import { createTarget, defineCommands, defineHeadless } from '@ironbird/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { counterDefinition } from '../test/helpers/counter-app';
import { isLoopbackHost, startDaemon, type Daemon } from './daemon';
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

  it('rejects a JSON null body as INVALID_PAYLOAD without a daemon fault', async () => {
    const logs: string[] = [];
    target = await createHeadlessTarget({ definition: counterDefinition, appId: 'com.example.test', settleTimeoutMs: 500, env: {}, log: () => {} });
    daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', log: (line) => logs.push(line) });
    const response = await rpc(daemon, 'null');
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(logs.filter((line) => line.includes('daemon fault'))).toEqual([]);
  });

  it('ends the stream with an error frame and no daemon fault when the backlog read fails', async () => {
    const logs: string[] = [];
    let boots = 0;
    const failsOnReset = defineHeadless(() => {
      boots += 1;
      if (boots > 1) throw new Error('boot exploded');
      const target = createTarget({ commands: defineCommands({ 'x.go': z.object({}) }), dispatch: () => {}, getState: () => ({ boots }) });
      return { target };
    });
    target = await createHeadlessTarget({ definition: failsOnReset, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', log: (line) => logs.push(line) });
    await rpc(daemon, { op: 'reset' });
    const response = await fetch(`${daemon.url}/v1/stream?target=headless&since=0`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('event: error');
    expect(text).toContain('"code":"INTERNAL"');
    expect(logs.filter((line) => line.includes('daemon fault'))).toEqual([]);
  });

  it('closes the stream when an event contains an unserializable value (BigInt) and logs no daemon fault', async () => {
    const logs: string[] = [];
    const bigIntEmitter = defineHeadless((context) => {
      // Record an event with BigInt immediately; it will be in the backlog when the stream loads
      context.recorder.record('app', 'weird', { big: 10n });
      const target = createTarget({
        commands: defineCommands({ 'noop': z.object({}) }),
        dispatch: () => {},
        getState: () => ({}),
      });
      return { target };
    });
    target = await createHeadlessTarget({ definition: bigIntEmitter, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', log: (line) => logs.push(line) });
    const response = await fetch(`${daemon.url}/v1/stream?target=headless&since=0`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let done = false;
    // Keep reading until the stream closes (which happens when the BigInt serialization error is caught)
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) decoder.decode(chunk.value, { stream: true });
    }
    expect(done).toBe(true);
    expect(logs.filter((line) => line.includes('daemon fault'))).toEqual([]);
  });

  it('throttles state notifications to at most one per 100 ms after the first', async () => {
    const d = await boot();
    const controller = new AbortController();
    const response = await fetch(`${d.url}/v1/stream?target=headless&since=0`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // Reuses one in-flight reader.read() across iterations instead of issuing a fresh one each
    // time the 20ms timeout wins the race: a stream reader queues concurrent read() calls and
    // resolves them in the order they were issued, so calling read() again before the previous
    // call settles orphans it — a later chunk fulfills that stale call instead of the current
    // iteration's, and its value is silently dropped.
    let pendingRead: ReturnType<typeof reader.read> | undefined;
    const drain = async (ms: number): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (!pendingRead) pendingRead = reader.read();
        const chunk = await Promise.race([pendingRead, new Promise<{ value: undefined; done: false }>((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 20))]);
        if (chunk.value) {
          text += decoder.decode(chunk.value, { stream: true });
          pendingRead = undefined;
        }
      }
    };
    await drain(50);
    const t0 = Date.now();
    // Spread the burst across several 100 ms throttle windows (12 dispatches, 30 ms apart, 360 ms
    // total) instead of firing it all at once, so a throttle that doesn't cap correctly per
    // window is exposed instead of accidentally passing because everything landed in one window.
    // Draining (rather than plain sleeping) between dispatches keeps the reader pulling frames as
    // they're actually written instead of letting them queue up unread until the final drain,
    // which would otherwise collapse their real arrival times together and make every gap below
    // measure close to 0 regardless of how the server actually paced its writes.
    for (let i = 0; i < 12; i += 1) {
      await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 1 } } });
      await drain(30);
    }
    await drain(200);
    const elapsed = Date.now() - t0;
    const stateFrames = text.split('\n\n').filter((frame) => frame.startsWith('event: state'));
    // A correct throttle (write immediately, then re-arm only while something is still pending)
    // produces 2 + floor(burstSpan / 100) frames for a sustained burst, and burstSpan grows with
    // rpc round-trip latency, so a fixed frame-count cap is inherently flaky on a slower machine.
    // Deriving the cap from `elapsed` (measured from just before the first dispatch to just after
    // the final drain) tracks that instead, and it's provably safe under jitter: a throttle timer
    // can fire late (adding delay, never a frame) but never early, so a slow run can only push
    // frames past the window and reduce the count, never inflate it above the bound. As a scratch
    // check, reverting `flush` in daemon.ts so it never re-arms its timeout after a write leaves
    // `throttle` permanently unset, so every later update fires `flush` again immediately with no
    // throttling at all: measured against this test, that produced all 12 frames, which the
    // derived count bound correctly rejected (12 > ceil(760/100)+1 = 9 for that run's ~760 ms
    // elapsed window). A per-frame minimum-gap assertion was tried too but removed: an event-loop
    // stall on the client side can coalesce two correctly spaced frames into a single chunk, so
    // their recorded arrival times collapse to the same instant and the assertion fails on a
    // correct throttle, not just a broken one. On a machine so slow that this burst takes over about 1.1 s, the elapsed bound stops distinguishing a broken throttle; the scratch check measured about 0.77 s.
    expect(stateFrames.length).toBeGreaterThanOrEqual(3);
    expect(stateFrames.length).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 1);
    expect(stateFrames[stateFrames.length - 1]).toContain('"rev":12');
    controller.abort();
  });

  it('refuses a non-loopback bind without a token', async () => {
    target = await createHeadlessTarget({ definition: counterDefinition, appId: 'com.example.test', settleTimeoutMs: 500, env: {}, log: () => {} });
    await expect(startDaemon({ host: '0.0.0.0', port: 0, version: '0.0.0-test', headless: target, log: () => {} })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('127.example.com')).toBe(false);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('close() is idempotent', async () => {
    const d = await boot();
    await d.close();
    await expect(d.close()).resolves.toBeUndefined();
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

  it('rejects a daemon.json missing required fields or that is not valid JSON', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-info-'));
    const artifacts = path.join(dir, '.ironbird');
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, 'daemon.json'), JSON.stringify({ url: 'x' }));
    expect(await readDaemonInfo(artifacts)).toBeUndefined();
    await writeFile(path.join(artifacts, 'daemon.json'), 'not json');
    expect(await readDaemonInfo(artifacts)).toBeUndefined();
  });
});
