import { IronbirdError, type ErrorShape } from '@ironbird/core';
import path from 'node:path';
import { readDaemonInfo } from '../daemon-info';

export interface DaemonClient {
  readonly url: string;
  rpc<T = unknown>(op: string, params?: Record<string, unknown>, target?: string): Promise<T>;
  stream(options: { target?: string; since?: number; signal: AbortSignal; onMessage: (kind: 'event' | 'state' | 'target', data: unknown) => void }): Promise<void>;
}

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4567';

type RpcEnvelope = { ok: true; result: unknown } | { ok: false; error: ErrorShape };

export function createDaemonClient(options: { url: string; token?: string; fetch?: typeof fetch }): DaemonClient {
  const url = options.url.replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  });
  const unreachable = (): IronbirdError => new IronbirdError('NO_TARGET', `Daemon unreachable at ${url}; run ironbird serve`, { url });

  return {
    url,
    async rpc<T>(op: string, params: Record<string, unknown> = {}, target?: string): Promise<T> {
      let response: Response;
      try {
        response = await doFetch(`${url}/v1/rpc`, { method: 'POST', headers: headers(), body: JSON.stringify({ op, target, params }) });
      } catch {
        throw unreachable();
      }
      if (response.status === 401) throw new IronbirdError('UNAUTHORIZED', 'Token missing or wrong for this daemon');
      if (response.status === 404) throw new IronbirdError('INTERNAL', `Daemon at ${url} has no /v1/rpc route; is it an ironbird daemon?`, { url });
      const envelope = (await response.json()) as RpcEnvelope;
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
      if (response.status === 401) throw new IronbirdError('UNAUTHORIZED', 'Token missing or wrong for this daemon');
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let kind = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) kind = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (data.length > 0 && (kind === 'event' || kind === 'state' || kind === 'target')) onMessage(kind, JSON.parse(data.join('\n')));
          boundary = buffer.indexOf('\n\n');
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
