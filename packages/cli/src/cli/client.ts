import { IronbirdError, messageOf, type ErrorShape } from '@ironbird/core';
import path from 'node:path';
import { readDaemonInfo } from '../daemon-info';

export interface DaemonClient {
  readonly url: string;
  rpc<T = unknown>(op: string, params?: Record<string, unknown>, target?: string): Promise<T>;
  stream(options: { target?: string; since?: number; signal: AbortSignal; onMessage: (kind: 'event' | 'state' | 'target' | 'error', data: unknown) => void }): Promise<void>;
}

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4567';

type RpcEnvelope = { ok: true; result: unknown } | { ok: false; error: ErrorShape };

/** Recognizes a parsed JSON body shaped like the protocol's failure envelope, `{ ok: false, error }`. */
function asErrorEnvelope(parsed: unknown): ErrorShape | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const candidate = parsed as { ok?: unknown; error?: unknown };
  if (candidate.ok !== false || candidate.error === null || typeof candidate.error !== 'object') return undefined;
  return candidate.error as ErrorShape;
}

export function createDaemonClient(options: { url: string; token?: string; fetch?: typeof fetch }): DaemonClient {
  const url = options.url.replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  });
  const unreachable = (): IronbirdError => new IronbirdError('NO_TARGET', `Daemon unreachable at ${url}; run ironbird serve`, { url });
  const unexpectedResponse = (status: number, bodyText: string): IronbirdError =>
    new IronbirdError('INTERNAL', `Daemon at ${url} returned an unexpected response (HTTP ${status})`, { url, status, body: bodyText.slice(0, 200) });

  return {
    url,
    async rpc<T>(op: string, params: Record<string, unknown> = {}, target?: string): Promise<T> {
      let response: Response;
      try {
        response = await doFetch(`${url}/v1/rpc`, { method: 'POST', headers: headers(), body: JSON.stringify({ op, target, params }) });
      } catch {
        throw unreachable();
      }
      const status = response.status;
      const bodyText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = undefined;
      }
      const errorEnvelope = asErrorEnvelope(parsed);

      if (status === 401) throw new IronbirdError('UNAUTHORIZED', errorEnvelope?.message ?? 'Token missing or wrong for this daemon');
      if (status === 404) throw new IronbirdError('INTERNAL', `Daemon at ${url} has no /v1/rpc route; is it an ironbird daemon?`, { url });
      if (errorEnvelope) throw new IronbirdError(errorEnvelope.code, errorEnvelope.message, errorEnvelope.details);

      const isJsonObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'ok' in (parsed as object);
      if (status !== 200 || !isJsonObject) throw unexpectedResponse(status, bodyText);

      const envelope = parsed as RpcEnvelope;
      if (envelope.ok) return envelope.result as T;
      throw new IronbirdError(envelope.error.code, envelope.error.message, envelope.error.details);
    },
    async stream({ target, since = 0, signal, onMessage }) {
      const query = new URLSearchParams({ ...(target ? { target } : {}), since: String(since) });
      let response: Response;
      try {
        response = await doFetch(`${url}/v1/stream?${query.toString()}`, { headers: headers(), signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error instanceof IronbirdError ? error : unreachable();
      }
      const status = response.status;
      if (status === 401) throw new IronbirdError('UNAUTHORIZED', 'Token missing or wrong for this daemon');
      if (status !== 200) throw unexpectedResponse(status, await response.text().catch(() => ''));
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          let result: Awaited<ReturnType<typeof reader.read>>;
          try {
            result = await reader.read();
          } catch (error) {
            if (signal.aborted) return;
            throw new IronbirdError('TARGET_DISCONNECTED', `Stream from ${url} ended unexpectedly: ${messageOf(error)}`, { target, op: 'stream' });
          }
          if (result.done) return;
          buffer = (buffer + decoder.decode(result.value, { stream: true })).replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let kind = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) continue;
              if (line.startsWith('event:')) kind = line.slice(6).replace(/^ /, '');
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (data.length > 0 && (kind === 'event' || kind === 'state' || kind === 'target' || kind === 'error')) {
              onMessage(kind, JSON.parse(data.join('\n')));
              if (kind === 'error') return;
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      } finally {
        try {
          await reader.cancel();
        } catch {
          // ignore: the reader may already be closed or errored.
        }
      }
    },
  };
}

async function findArtifactsDir(cwd: string): Promise<string | undefined> {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, '.ironbird');
    if (await readDaemonInfo(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function resolveDaemon(options: { flag?: string; cwd: string; env: Record<string, string | undefined> }): Promise<{ url: string; token?: string; defaultTarget?: string }> {
  const token = options.env['IRONBIRD_TOKEN'];
  if (options.flag) return { url: options.flag, token, defaultTarget: undefined };
  const artifactsDir = await findArtifactsDir(options.cwd);
  const info = artifactsDir ? await readDaemonInfo(artifactsDir) : undefined;
  if (info) return { url: info.url, token, defaultTarget: info.defaultTarget };
  return { url: DEFAULT_DAEMON_URL, token, defaultTarget: undefined };
}
