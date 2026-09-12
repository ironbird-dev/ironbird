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

/** Builds a Response whose body is a ReadableStream fed by the given chunks, enqueued in order
 * (so a single SSE frame can be split arbitrarily across chunks). When `neverCloses` is set, the
 * stream is left open and, if a `signal` is given, errors out (like an aborted fetch would) the
 * moment that signal fires. */
function chunkedResponse(chunks: string[], options: { status?: number; neverCloses?: boolean; signal?: AbortSignal } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!options.neverCloses) {
        controller.close();
        return;
      }
      options.signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  });
  return new Response(body, { status: options.status ?? 200 });
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

  it('uses the daemon message for a 401 error envelope', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Token missing or wrong' } }, 401));
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const error = await client.rpc('status').catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('UNAUTHORIZED');
    expect(isIronbirdError(error) && error.message).toBe('Token missing or wrong');
  });

  it('throws a 500 ok:false envelope as its IronbirdError', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ ok: false, error: { code: 'INTERNAL', message: 'boom' } }, 500));
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const error = await client.rpc('status').catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('INTERNAL');
    expect(isIronbirdError(error) && error.message).toBe('boom');
  });

  it('rejects with INTERNAL when a 200 body is not JSON', async () => {
    const fetchMock: FetchMock = vi.fn(async () => new Response('<html>nope</html>', { status: 200 }));
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const error = await client.rpc('status').catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('INTERNAL');
    expect(isIronbirdError(error) && error.details).toMatchObject({ url: 'http://127.0.0.1:4567', status: 200 });
    expect(isIronbirdError(error) && (error.details as { body?: string }).body).toContain('<html>nope</html>');
  });

  it('rejects an ok:false envelope with no usable error as INTERNAL instead of a raw TypeError', async () => {
    const bareFalse = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: vi.fn(async () => jsonResponse({ ok: false })) });
    const bareFalseError = await bareFalse.rpc('status').catch((caught: unknown) => caught);
    expect(isIronbirdError(bareFalseError) && bareFalseError.code).toBe('INTERNAL');

    const nullError = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: vi.fn(async () => jsonResponse({ ok: false, error: null })) });
    const nullErrorResult = await nullError.rpc('status').catch((caught: unknown) => caught);
    expect(isIronbirdError(nullErrorResult) && nullErrorResult.code).toBe('INTERNAL');
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

  it('handles a frame split mid-line across chunks, a CRLF-terminated frame, and ignores a comment', async () => {
    const response = chunkedResponse([
      ': ping\n',
      'event: eve',
      'nt\ndata: {"seq":1,"na',
      'me":"a"}\n\n',
      'event: state\r\ndata: {"rev":2}\r\n\r\n',
    ]);
    const fetchMock: FetchMock = vi.fn(async () => response);
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const seen: Array<[string, unknown]> = [];
    await client.stream({ signal: new AbortController().signal, onMessage: (kind, data) => seen.push([kind, data]) });
    expect(seen).toEqual([
      ['event', { seq: 1, name: 'a' }],
      ['state', { rev: 2 }],
    ]);
  });

  it('delivers a terminal error frame to onMessage and resolves', async () => {
    const response = chunkedResponse(['event: error\ndata: {"code":"TARGET_DISCONNECTED","message":"bye"}\n\n']);
    const fetchMock: FetchMock = vi.fn(async () => response);
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const seen: Array<[string, unknown]> = [];
    await expect(
      client.stream({ signal: new AbortController().signal, onMessage: (kind, data) => seen.push([kind, data]) }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([['error', { code: 'TARGET_DISCONNECTED', message: 'bye' }]]);
  });

  it('resolves quietly when aborted mid-stream', async () => {
    const abortController = new AbortController();
    const response = chunkedResponse(['event: state\ndata: {"rev":1}\n\n'], { neverCloses: true, signal: abortController.signal });
    const fetchMock: FetchMock = vi.fn(async () => response);
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const seen: Array<[string, unknown]> = [];
    await expect(
      client.stream({
        signal: abortController.signal,
        onMessage: (kind, data) => {
          seen.push([kind, data]);
          abortController.abort();
        },
      }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([['state', { rev: 1 }]]);
  });

  it('rejects a non-200 status (e.g. 404) with an IronbirdError', async () => {
    const fetchMock: FetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const error = await client.stream({ signal: new AbortController().signal, onMessage: () => {} }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('INTERNAL');
  });

  it('uses the daemon message for a 401 error envelope', async () => {
    const response = chunkedResponse([JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Token missing or wrong' } })], { status: 401 });
    const fetchMock: FetchMock = vi.fn(async () => response);
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const error = await client.stream({ signal: new AbortController().signal, onMessage: () => {} }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('UNAUTHORIZED');
    expect(isIronbirdError(error) && error.message).toBe('Token missing or wrong');
  });

  it('rejects a frame with an unparsable data payload as TARGET_DISCONNECTED', async () => {
    const response = chunkedResponse(['event: state\ndata: {not json\n\n']);
    const fetchMock: FetchMock = vi.fn(async () => response);
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const error = await client.stream({ signal: new AbortController().signal, onMessage: () => {} }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('TARGET_DISCONNECTED');
  });

  it('delivers a frame whose CRLF terminator is split across chunks (one ends with \\r, the next starts with \\n\\n)', async () => {
    const response = chunkedResponse(['event: state\ndata: {"rev":1}\r', '\n\nevent: state\ndata: {"rev":2}\n\n']);
    const fetchMock: FetchMock = vi.fn(async () => response);
    const client = createDaemonClient({ url: 'http://127.0.0.1:4567', fetch: fetchMock });
    const seen: Array<[string, unknown]> = [];
    await client.stream({ signal: new AbortController().signal, onMessage: (kind, data) => seen.push([kind, data]) });
    expect(seen).toEqual([
      ['state', { rev: 1 }],
      ['state', { rev: 2 }],
    ]);
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
