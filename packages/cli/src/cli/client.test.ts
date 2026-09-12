import { isIronbirdError } from '@ironbird/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonClient, resolveDaemon } from './client';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createDaemonClient.rpc', () => {
  it('posts the operation with the bearer token and returns result', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ ok: true, result: { rev: 3 } }));
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', token: 'secret', fetch: fetchMock });
    await expect(client.rpc('getState', { path: 'cart' }, 'headless')).resolves.toEqual({ rev: 3 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4567/v1/rpc');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer secret');
    expect(JSON.parse(init.body as string)).toEqual({ op: 'getState', target: 'headless', params: { path: 'cart' } });
  });

  it('throws the daemon error as an IronbirdError', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ ok: false, error: { code: 'WAIT_TIMEOUT', message: 'nope', details: { path: 'a' } } }));
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const error = await client.rpc('waitFor', { path: 'a', equals: 1 }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('WAIT_TIMEOUT');
    expect(isIronbirdError(error) && error.details).toEqual({ path: 'a' });
  });

  it('maps 401 to UNAUTHORIZED and connection failures to NO_TARGET with a hint', async () => {
    const unauthorized = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: vi.fn(async () => jsonResponse({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Token missing' } }, 401)) });
    const authError = await unauthorized.rpc('status').catch((caught: unknown) => caught);
    expect(isIronbirdError(authError) && authError.code).toBe('UNAUTHORIZED');

    const down = createDaemonClient({ url: 'http://127.0.0.1:1', fetch: vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) });
    const downError = await down.rpc('status').catch((caught: unknown) => caught);
    expect(isIronbirdError(downError) && downError.code).toBe('NO_TARGET');
    expect(isIronbirdError(downError) && downError.message).toBe('Daemon unreachable at http://127.0.0.1:1; run ironbird serve');
  });
});

describe('createDaemonClient.stream', () => {
  it('parses server-sent events until aborted', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('event: event\ndata: {"seq":1,"name":"a"}\n\n'));
        controller.enqueue(encoder.encode('event: state\ndata: {"rev":2}\n\n'));
        controller.close();
      },
    });
    const fetchMock: FetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const seen: Array<[string, unknown]> = [];
    await client.stream({ target: 'headless', since: 0, signal: new AbortController().signal, onMessage: (kind, data) => seen.push([kind, data]) });
    expect(seen).toEqual([
      ['event', { seq: 1, name: 'a' }],
      ['state', { rev: 2 }],
    ]);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('http://127.0.0.1:4567/v1/stream?target=headless&since=0');
  });
});

describe('resolveDaemon', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('prefers the flag, then daemon.json found walking up, then the default', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-client-'));
    await mkdir(path.join(dir, '.ironbird'), { recursive: true });
    await mkdir(path.join(dir, 'src/deep'), { recursive: true });
    await writeFile(path.join(dir, '.ironbird/daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:4999', pid: 1, startedAt: 0, version: '0.0.0', defaultTarget: 'headless' }));
    expect(await resolveDaemon({ flag: 'http://10.0.0.2:4567', cwd: dir, env: {} })).toEqual({ url: 'http://10.0.0.2:4567', token: undefined, defaultTarget: undefined });
    expect(await resolveDaemon({ cwd: path.join(dir, 'src/deep'), env: { IRONBIRD_TOKEN: 't' } })).toEqual({ url: 'http://127.0.0.1:4999', token: 't', defaultTarget: 'headless' });
    expect(await resolveDaemon({ cwd: tmpdir(), env: {} })).toEqual({ url: 'http://127.0.0.1:4567', token: undefined, defaultTarget: undefined });
  });
});
