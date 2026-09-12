import { IronbirdError, PROTOCOL_VERSION, isIronbirdError, toErrorShape, type RecordedEvent, type TargetInfo } from '@ironbird/core';
import { timingSafeEqual } from 'node:crypto';
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
  /** Test hook: overrides the SSE keepalive ping interval (default 15_000ms) so tests can observe
   * ping behavior without waiting out the real interval. */
  pingIntervalMs?: number;
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

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_MAPPED_LOOPBACK = /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Loopback hosts may run without a token (see spec R3); anything else must be paired with one. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || IPV4_LOOPBACK.test(normalized) || IPV4_MAPPED_LOOPBACK.test(normalized);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
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

  if (!isLoopbackHost(options.host) && !options.token) {
    throw new IronbirdError('UNAUTHORIZED', `Binding ${options.host} requires a token; pass one or bind 127.0.0.1`);
  }

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

  const authorized = (req: IncomingMessage): boolean => {
    if (!options.token) return true;
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const expected = Buffer.from(`Bearer ${options.token}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const handleRpc = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (error) {
      const shape = isIronbirdError(error) ? toErrorShape(error) : { code: 'INVALID_PAYLOAD' as const, message: 'Malformed JSON body', details: { name: 'rpc', issues: [] } };
      sendJson(res, 200, { ok: false, error: shape });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 200, {
        ok: false,
        error: { code: 'INVALID_PAYLOAD', message: 'Body must be a JSON object', details: { name: 'rpc', issues: [{ path: [], message: 'expected an object' }] } },
      });
      return;
    }
    const envelope = parsed as { op?: unknown; target?: unknown; params?: unknown };
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

    // Registered before the backlog await below so a client disconnect (or a backlog read that
    // throws) while we're still awaiting it is handled here rather than leaking the subscription,
    // leaving stray timers, or falling through to the daemon-fault handler.
    let aborted = false;
    // A holder object rather than separate `let`s: each of these is assigned exactly once, once
    // its value becomes available, but `cleanup` (below) must be able to reference it beforehand.
    const handles: { offEvent?: () => void; offState?: () => void; ping?: NodeJS.Timeout } = {};
    let throttle: NodeJS.Timeout | undefined;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      handles.offEvent?.();
      handles.offState?.();
      if (handles.ping) clearInterval(handles.ping);
      if (throttle) clearTimeout(throttle);
    };
    req.on('close', () => {
      aborted = true;
      cleanup();
    });
    // A late socket error (e.g. an ECONNRESET after headers are already flushed) must not reach
    // Node as an unhandled 'error' event on `res` — an EventEmitter that emits 'error' with no
    // listener throws, which would crash the process. Attaching this here, before anything is
    // ever written, means any such error just runs the same teardown as a normal disconnect.
    res.on('error', () => cleanup());

    let streamEnded = false;
    const endStream = (): void => {
      if (streamEnded) return;
      streamEnded = true;
      res.end();
    };
    // A client that vanished between event-loop turns can make `res.write` throw, and a value
    // that fails to serialize can make `JSON.stringify` throw: either must tear the subscription
    // down and end the response exactly once right here, instead of propagating out of a backlog
    // frame, a live event/state callback, or the backlog-failure error frame below, and up into
    // the request handler's try/catch, which would log it as a daemon fault and then attempt to
    // send a second, JSON error response on a stream whose headers are already flushed. Every call
    // site routes its serialization through the `produce` thunk so it also runs inside this guard,
    // not just the socket write.
    const guarded = (produce: () => string): void => {
      try {
        res.write(produce());
      } catch {
        cleanup();
        endStream();
      }
    };
    const writeRaw = (text: string): void => guarded(() => text);
    const write = (kind: string, data: unknown): void => guarded(() => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    writeRaw(': connected\n\n');

    // Subscribe before awaiting the backlog so an event recorded during that await isn't lost
    // between the snapshot and the subscription. Anything that arrives while we're still
    // buffering is held here and reconciled against the backlog by seq once it's in hand.
    let buffering = true;
    const liveBuffer: RecordedEvent[] = [];
    handles.offEvent = target.onEvent((event) => {
      if (buffering) liveBuffer.push(event);
      else write('event', event);
    });

    let backlog: { events: RecordedEvent[] };
    try {
      backlog = (await target.run('events', { since })) as { events: RecordedEvent[] };
    } catch (error) {
      // The subscription is live but no backlog was ever flushed, so there's nothing to
      // reconcile: tear down and end the stream with a single error frame instead of letting
      // this reach the daemon-fault handler (the client already got a 200 SSE response head).
      // Serializing the error shape inside `guarded` (rather than eagerly before calling it) means
      // a value that itself fails to serialize can't escape as an unhandled throw here either.
      cleanup();
      guarded(() => `event: error\ndata: ${JSON.stringify(toErrorShape(error))}\n\n`);
      endStream();
      return;
    }
    if (aborted || req.destroyed) {
      cleanup();
      return;
    }
    // `cleanup()` runs inside `guarded` the moment a write or a serialization fails, but that
    // doesn't stop either loop from running to completion on its own, and nothing past this point
    // must run once it has: the stream is already ended, so subscribing to more state here would
    // never be released (`cleanup` is latched by `cleaned` and won't call `offState`/clear `ping`
    // for handles it hasn't seen yet), and arming the ping interval would write to a dead response
    // forever. So every loop bails out as soon as `cleaned` flips, and the function returns before
    // reaching the state subscription or the ping timer below.
    for (const event of backlog.events) {
      write('event', event);
      if (cleaned) break;
    }
    if (cleaned) return;
    const lastBacklogSeq = backlog.events.length > 0 ? backlog.events[backlog.events.length - 1]!.seq : since;
    for (const event of liveBuffer) {
      if (event.seq > lastBacklogSeq) write('event', event);
      if (cleaned) break;
    }
    if (cleaned) return;
    buffering = false;

    let pendingRev: number | undefined;
    // Writes immediately on the first update after a quiet period, then re-arms for another
    // STATE_THROTTLE_MS as long as there's something to flush, so a sustained burst is capped at
    // one write per window instead of overshooting it.
    const flush = (): void => {
      if (pendingRev === undefined) {
        throttle = undefined;
        return;
      }
      write('state', { rev: pendingRev });
      pendingRev = undefined;
      throttle = setTimeout(flush, STATE_THROTTLE_MS);
    };
    handles.offState = target.onState((rev) => {
      pendingRev = rev;
      if (!throttle) flush();
    });
    handles.ping = setInterval(() => writeRaw(': ping\n\n'), options.pingIntervalMs ?? PING_INTERVAL_MS);
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req)) {
          sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Token missing or wrong' } });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/v1/rpc') return await handleRpc(req, res);
        if (req.method === 'GET' && url.pathname === '/v1/stream') return await handleStream(url, req, res);
        sendJson(res, 404, { ok: false, error: { code: 'INTERNAL', message: `No route ${req.method ?? ''} ${url.pathname}` } });
      } catch (error) {
        log(`daemon fault: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: toErrorShape(error) });
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

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
    return closing;
  };

  return {
    url,
    host: options.host,
    port,
    targets: () => [...targets.values()].map((t) => t.info()),
    close,
  };
}
