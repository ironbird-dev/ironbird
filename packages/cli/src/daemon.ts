import { IronbirdError, PROTOCOL_VERSION, isIronbirdError, toErrorShape, type ErrorShape, type TargetInfo } from '@ironbird/core';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { HeadlessTarget } from './headless-target';

export interface DaemonOptions {
  host: string;
  port: number;
  token?: string;
  version: string;
  headless?: HeadlessTarget;
  defaultTarget?: string;
  log?: (line: string) => void;
}

export interface Daemon {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  targets(): TargetInfo[];
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const STATE_THROTTLE_MS = 100;
const PING_INTERVAL_MS = 15_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function failure(status: number, error: ErrorShape): { status: number; body: { ok: false; error: ErrorShape } } {
  return { status, body: { ok: false, error } };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new IronbirdError('INVALID_PAYLOAD', 'Request body too large', { name: 'rpc', issues: [{ path: [], message: `body exceeds ${MAX_BODY_BYTES} bytes` }] });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => console.error(line));
  const startedAt = Date.now();
  const targets = new Map<string, HeadlessTarget>();
  if (options.headless) targets.set(options.headless.id, options.headless);

  const selectTarget = (requested: unknown): HeadlessTarget => {
    const available = [...targets.keys()];
    const id = typeof requested === 'string' && requested !== '' ? requested : options.defaultTarget;
    if (id === undefined) {
      const only = available.length === 1 ? targets.get(available[0] as string) : undefined;
      if (only) return only;
      const code = available.length === 0 ? 'NO_TARGET' : 'AMBIGUOUS_TARGET';
      throw new IronbirdError(code, available.length === 0 ? 'No target is connected or configured' : 'Several targets qualify; pass --target', { available });
    }
    const target = targets.get(id);
    if (!target) throw new IronbirdError('NO_TARGET', `No target ${id}`, { available });
    return target;
  };

  const authorized = (req: IncomingMessage): boolean => !options.token || req.headers.authorization === `Bearer ${options.token}`;

  const handleRpc = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let envelope: { op?: unknown; target?: unknown; params?: unknown };
    try {
      envelope = JSON.parse(await readBody(req)) as typeof envelope;
    } catch (error) {
      const shape = isIronbirdError(error) ? toErrorShape(error) : { code: 'INVALID_PAYLOAD' as const, message: 'Malformed JSON body', details: { name: 'rpc', issues: [] } };
      sendJson(res, 200, failure(200, shape).body);
      return;
    }
    const { op, target: requestedTarget } = envelope;
    const params = typeof envelope.params === 'object' && envelope.params !== null ? (envelope.params as Record<string, unknown>) : {};
    try {
      if (typeof op !== 'string') throw new IronbirdError('INVALID_PAYLOAD', 'Body needs a string op', { name: 'rpc', issues: [{ path: ['op'], message: 'expected a string' }] });
      if (op === 'status') {
        sendJson(res, 200, { ok: true, result: { version: options.version, protocol: PROTOCOL_VERSION, uptimeMs: Date.now() - startedAt, targets: [...targets.values()].map((t) => t.info()) } });
        return;
      }
      const target = selectTarget(requestedTarget);
      const result = await target.run(op, params);
      sendJson(res, 200, { ok: true, target: target.id, result });
    } catch (error) {
      if (isIronbirdError(error)) {
        sendJson(res, 200, { ok: false, error: toErrorShape(error) });
        return;
      }
      log(`daemon fault handling ${String(op)}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      sendJson(res, 500, { ok: false, error: toErrorShape(error) });
    }
  };

  const handleStream = async (url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let target: HeadlessTarget;
    try {
      target = selectTarget(url.searchParams.get('target') ?? undefined);
    } catch (error) {
      sendJson(res, 200, { ok: false, error: toErrorShape(error) });
      return;
    }
    const since = Number(url.searchParams.get('since') ?? '0') || 0;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const write = (kind: string, data: unknown): void => {
      res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.write(': connected\n\n');
    const backlog = (await target.run('events', { since })) as { events: unknown[] };
    for (const event of backlog.events) write('event', event);
    const offEvent = target.onEvent((event) => write('event', event));
    let pendingRev: number | undefined;
    let throttle: NodeJS.Timeout | undefined;
    const flush = (): void => {
      throttle = undefined;
      if (pendingRev === undefined) return;
      write('state', { rev: pendingRev });
      pendingRev = undefined;
    };
    const offState = target.onState((rev) => {
      pendingRev = rev;
      if (!throttle) {
        flush();
        throttle = setTimeout(flush, STATE_THROTTLE_MS);
      }
    });
    const ping = setInterval(() => res.write(': ping\n\n'), PING_INTERVAL_MS);
    req.on('close', () => {
      offEvent();
      offState();
      clearInterval(ping);
      if (throttle) clearTimeout(throttle);
    });
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req)) {
          sendJson(res, 401, failure(401, { code: 'UNAUTHORIZED', message: 'Token missing or wrong' }).body);
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/v1/rpc') return await handleRpc(req, res);
        if (req.method === 'GET' && url.pathname === '/v1/stream') return await handleStream(url, req, res);
        sendJson(res, 404, failure(404, { code: 'INTERNAL', message: `No route ${req.method ?? ''} ${url.pathname}` }).body);
      } catch (error) {
        log(`daemon fault: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, failure(500, toErrorShape(error)).body);
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host}:${port}`;
  log(`ironbird daemon listening at ${url}`);

  return {
    url,
    host: options.host,
    port,
    targets: () => [...targets.values()].map((t) => t.info()),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
