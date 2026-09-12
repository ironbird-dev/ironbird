import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { counterDefinition } from '../test/helpers/counter-app';
import { startDaemon, type Daemon } from './daemon';
import { readDaemonInfo, removeDaemonInfo, writeDaemonInfo } from './daemon-info';
import { createHeadlessTarget, type HeadlessTarget } from './headless-target';

let daemon: Daemon | undefined;
let target: HeadlessTarget | undefined;

async function boot(options: { token?: string; defaultTarget?: string | null } = {}): Promise<Daemon> {
  target = await createHeadlessTarget({ definition: counterDefinition, appId: 'com.example.test', clockStart: '2026-01-01T00:00:00.000Z', settleTimeoutMs: 500, env: {}, log: () => {} });
  daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: options.defaultTarget === null ? undefined : (options.defaultTarget ?? 'headless'), token: options.token, log: () => {} });
  return daemon;
}

async function rpc(d: Daemon, body: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${d.url}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

afterEach(async () => {
  await daemon?.close();
  await target?.dispose();
  daemon = undefined;
  target = undefined;
});

describe('startDaemon', () => {
  it('answers status and routes operations to the default target', async () => {
    const d = await boot();
    expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const status = await rpc(d, { op: 'status' });
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ ok: true, result: { version: '0.0.0-test', protocol: 1, targets: [{ id: 'headless', platform: 'headless', appId: 'com.example.test', rev: 0 }] } });
    expect(status.json['target']).toBeUndefined();

    const dispatched = await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 2 }, path: 'count' } });
    expect(dispatched.json).toMatchObject({ ok: true, target: 'headless', result: { rev: 1, state: 2 } });
    const state = await rpc(d, { op: 'getState', target: 'headless', params: { path: 'count' } });
    expect(state.json).toMatchObject({ ok: true, target: 'headless', result: { rev: 1, path: 'count', value: 2 } });
  });

  it('returns operation failures as ok:false with HTTP 200', async () => {
    const d = await boot();
    const unknown = await rpc(d, { op: 'dispatch', params: { name: 'nope' } });
    expect(unknown.status).toBe(200);
    expect(unknown.json).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } });
    const unsupported = await rpc(d, { op: 'fakeControl', params: {} });
    expect(unsupported.json).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', details: { op: 'fakeControl', target: 'headless' } } });
  });

  it('reports NO_TARGET for unknown ids and when nothing is selected', async () => {
    const d = await boot({ defaultTarget: null });
    const missing = await rpc(d, { op: 'getState', target: 'ios' });
    expect(missing.json).toMatchObject({ ok: false, error: { code: 'NO_TARGET', details: { available: ['headless'] } } });
    const single = await rpc(d, { op: 'getState' });
    expect(single.json).toMatchObject({ ok: true, target: 'headless' });
  });

  it('rejects bad envelopes and unknown routes', async () => {
    const d = await boot();
    expect((await rpc(d, '{not json')).json).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect((await rpc(d, { params: {} })).json).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    const missing = await fetch(`${d.url}/v1/nope`);
    expect(missing.status).toBe(404);
  });

  it('enforces the bearer token when configured', async () => {
    const d = await boot({ token: 'secret' });
    expect((await rpc(d, { op: 'status' })).status).toBe(401);
    expect((await rpc(d, { op: 'status' }, 'wrong')).status).toBe(401);
    expect((await rpc(d, { op: 'status' }, 'secret')).status).toBe(200);
    const stream = await fetch(`${d.url}/v1/stream`);
    expect(stream.status).toBe(401);
  });

  it('streams recorded events and throttled state revisions over SSE', async () => {
    const d = await boot();
    await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 1 } } });
    const controller = new AbortController();
    const response = await fetch(`${d.url}/v1/stream?target=headless&since=0`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil(': connected');
    await rpc(d, { op: 'dispatch', params: { name: 'data.load' } });
    await rpc(d, { op: 'clockAdvance', params: { ms: 500 } });
    await readUntil('"name":"loaded"');
    expect(text).toContain('event: state\ndata: {"rev":2}');
    expect(text).toContain('event: event\ndata: {"seq":1,');
    controller.abort();
  });

  it('close() stops accepting connections', async () => {
    const d = await boot();
    await d.close();
    await expect(fetch(`${d.url}/v1/rpc`, { method: 'POST', body: '{}' })).rejects.toThrow();
    daemon = undefined;
  });
});

describe('daemon.json', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips and tolerates a missing or corrupt file', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-info-'));
    const artifacts = path.join(dir, '.ironbird');
    expect(await readDaemonInfo(artifacts)).toBeUndefined();
    const info = { url: 'http://127.0.0.1:4567', pid: 123, startedAt: 1, version: '0.0.0', defaultTarget: 'headless' };
    expect(await writeDaemonInfo(artifacts, info)).toBe(path.join(artifacts, 'daemon.json'));
    expect(await readDaemonInfo(artifacts)).toEqual(info);
    await removeDaemonInfo(artifacts);
    expect(await readDaemonInfo(artifacts)).toBeUndefined();
    await removeDaemonInfo(artifacts);
  });
});
