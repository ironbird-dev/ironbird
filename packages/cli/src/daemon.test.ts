import { createTarget, defineCommands, defineHeadless } from '@ironbird/core';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { counterDefinition } from '../test/helpers/counter-app';
import { isLoopbackHost, startDaemon, type Daemon } from './daemon';
import type { DaemonTarget } from './daemon-target';
import { readDaemonInfo, removeDaemonInfo, writeDaemonInfo } from './daemon-info';
import { createHeadlessTarget, type HeadlessTarget } from './headless-target';

let daemon: Daemon | undefined;
let target: HeadlessTarget | undefined;

async function boot(options: { token?: string; defaultTarget?: string | null; extra?: Partial<Parameters<typeof startDaemon>[0]> } = {}): Promise<Daemon> {
  target = await createHeadlessTarget({ definition: counterDefinition, appId: 'com.example.test', clockStart: '2026-01-01T00:00:00.000Z', settleTimeoutMs: 500, env: {}, log: () => {} });
  daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: options.defaultTarget === null ? undefined : (options.defaultTarget ?? 'headless'), token: options.token, log: () => {}, ...options.extra });
  return daemon;
}

async function rpc(d: Daemon, body: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${d.url}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/**
 * `fetch` silently drops a caller-supplied `Host` header, so the cross-site checks go through
 * `node:http`, which sends exactly the headers it is given.
 */
async function raw(d: Daemon, options: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL(options.path ?? '/v1/rpc', d.url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: d.port, path: url.pathname + url.search, method: options.method ?? 'POST', headers: options.headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(options.body ?? JSON.stringify({ op: 'status' }));
  });
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
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', details: { op: 'GET /v1/nope', target: null } } });
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
    expect(text).toContain('"code":"HEADLESS_LOAD_FAILED"');
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

  it('does not leak the ping timer or state listener after a mid-backlog teardown', async () => {
    const logs: string[] = [];
    // Records the unserializable BigInt event during boot, before the stream ever connects, so it
    // is already in the backlog when `handleStream` reads it (the failure must happen in the
    // backlog loop, not the live-buffer loop). `counter.add` is included so a later rpc dispatch
    // can exercise `onState` against this same session.
    const bigIntCounter = defineHeadless((context) => {
      context.recorder.record('app', 'weird', { big: 10n });
      let count = 0;
      const listeners = new Set<() => void>();
      const target = createTarget({
        commands: defineCommands({ 'counter.add': z.object({ by: z.number().int() }) }),
        dispatch: ({ payload }) => {
          count += (payload as { by: number }).by;
          listeners.forEach((l) => l());
        },
        getState: () => ({ count }),
        subscribe: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      });
      return { target };
    });
    target = await createHeadlessTarget({ definition: bigIntCounter, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    // A short ping interval (rather than the 15s default) is what makes the leaked timer fire
    // within the test's lifetime instead of just after it.
    daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', pingIntervalMs: 20, log: (line) => logs.push(line) });

    // The bug under test is that `handleStream` keeps running past a mid-backlog teardown and
    // still calls `target.onState(...)` (and arms the ping interval) even though the response
    // already ended. Spying directly on `onState` makes that leak deterministic to observe: in
    // this Node/undici combination, writing to an already-ended-and-destroyed ServerResponse
    // silently no-ops (returns false) instead of throwing or emitting an 'error' event — verified
    // empirically against the unfixed code, where the leaked ping fired repeatedly and the leaked
    // state listener fired on the later dispatch below, and neither surfaced as a Vitest failure
    // on its own. So the spy is what actually turns this test red before the fix; the wait, the
    // rpc call, and the "no daemon fault" check below are kept as belt-and-suspenders behavioral
    // checks that a correct teardown produces no visible side effects, though they cannot by
    // themselves distinguish leaked-but-silently-ignored writes from no leak at all here.
    const onStateSpy = vi.spyOn(target, 'onState');

    const response = await fetch(`${daemon.url}/v1/stream?target=headless&since=0`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) decoder.decode(chunk.value, { stream: true });
    }
    expect(done).toBe(true);

    // The stream already tore down because of the BigInt failure above; a correct `handleStream`
    // must never reach the `target.onState(...)` registration for it.
    expect(onStateSpy).not.toHaveBeenCalled();

    // Wait past several ping intervals so a leaked ping timer would have fired multiple times.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const dispatched = await rpc(daemon, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 1 } } });
    expect(dispatched.json).toMatchObject({ ok: true });
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

  it('refuses a request carrying an Origin header or a foreign Host', async () => {
    const d = await boot();
    const crossOrigin = await fetch(`${d.url}/v1/rpc`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: JSON.stringify({ op: 'status' }) });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Cross-origin or foreign-host requests are not allowed' } });

    const rebound = await raw(d, { headers: { host: 'evil.example' } });
    expect(rebound.status).toBe(403);
    expect(rebound.json).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });

    // The daemon's own bind address and the loopback names it answers to still pass.
    expect((await raw(d, { headers: { host: `127.0.0.1:${d.port}` } })).status).toBe(200);
    expect((await raw(d, { headers: { host: `localhost:${d.port}` } })).status).toBe(200);
    expect((await raw(d, { headers: { host: '127.0.0.1' } })).status).toBe(200);
    // A stream request is checked the same way.
    const stream = await fetch(`${d.url}/v1/stream`, { headers: { origin: 'http://evil.example' } });
    expect(stream.status).toBe(403);
  });

  it('accepts a bracketed IPv6 loopback Host', async () => {
    const d = await boot();
    const response = await raw(d, { headers: { host: `[::1]:${d.port}` } });
    expect(response.status).toBe(200);
  });

  it('accepts any Host when bound to a wildcard address (0.0.0.0 or ::)', async () => {
    target = await createHeadlessTarget({ definition: counterDefinition, appId: 'com.example.test', settleTimeoutMs: 500, env: {}, log: () => {} });
    daemon = await startDaemon({ host: '0.0.0.0', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', token: 'secret', log: () => {} });
    // `0.0.0.0` means "every interface", not one address a request's Host header could ever
    // literally name, so there is nothing sensible to compare it against; a wildcard bind already
    // requires a token (checked in startDaemon), so any Host is accepted here.
    const named = await raw(daemon, { headers: { host: `0.0.0.0:${daemon.port}`, authorization: 'Bearer secret' } });
    expect(named.status).toBe(200);
    const foreign = await raw(daemon, { headers: { host: 'attacker.test', authorization: 'Bearer secret' } });
    expect(foreign.status).toBe(200);
  });

  it('fails a target operation that never settles with TARGET_DISCONNECTED, and keeps serving status', async () => {
    const wedged = defineHeadless(() => {
      const app = createTarget({
        commands: defineCommands({ 'hang.forever': z.object({}) }),
        dispatch: () => new Promise<void>(() => {}),
        getState: () => ({}),
      });
      return { target: app };
    });
    target = await createHeadlessTarget({ definition: wedged, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    // requestTimeoutMs is deliberately tiny; with no operation-specific timeout, the bound uses it directly.
    daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', requestTimeoutMs: 50, log: () => {} });
    const startedAt = Date.now();
    const wedgedResponse = await rpc(daemon, { op: 'dispatch', params: { name: 'hang.forever' } });
    expect(wedgedResponse.status).toBe(200);
    expect(wedgedResponse.json).toMatchObject({ ok: false, error: { code: 'TARGET_DISCONNECTED', details: { target: 'headless', op: 'dispatch' } } });
    expect(String((wedgedResponse.json['error'] as { message: string }).message)).toContain('ironbird reset');
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(1_000);
    // The daemon itself is still healthy; only the wedged operation failed.
    expect((await rpc(daemon, { op: 'status' })).json).toMatchObject({ ok: true });
  });

  it('never truncates a waitFor whose own timeoutMs outlives a tiny request timeout', async () => {
    target = await createHeadlessTarget({ definition: counterDefinition, appId: 'com.example.test', settleTimeoutMs: 500, env: {}, log: () => {} });
    daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', requestTimeoutMs: 50, log: () => {} });
    // requestTimeoutMs (50ms) alone would fire TARGET_DISCONNECTED long before this; the request's
    // own timeoutMs (300ms) must push the daemon's bound out past it so waitFor's own WAIT_TIMEOUT
    // is what the caller sees.
    const response = await rpc(daemon, { op: 'waitFor', params: { path: 'count', equals: 999, timeoutMs: 300 } });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: false, error: { code: 'WAIT_TIMEOUT' } });
  });

  it('never truncates a dispatch settle whose own timeoutMs outlives a tiny request timeout', async () => {
    const neverIdle = defineHeadless(({ tracker }) => {
      const app = createTarget({
        commands: defineCommands({ 'work.start': z.object({}) }),
        // A real (non-fake) effect that never resolves, tracked so `settle` actually has something
        // to wait on instead of reporting idle immediately.
        dispatch: () => {
          void tracker.track(new Promise<void>(() => {}), 'real.work');
        },
        getState: () => ({}),
      });
      return { target: app };
    });
    target = await createHeadlessTarget({ definition: neverIdle, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', requestTimeoutMs: 50, log: () => {} });
    const startedAt = Date.now();
    const response = await rpc(daemon, { op: 'dispatch', params: { name: 'work.start', settle: { timeoutMs: 300 } } });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: true, target: 'headless', result: { settle: { idle: false } } });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
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

function fakeRemote(id: string, platform: 'ios' | 'android' = 'ios', run?: (op: string, params: Record<string, unknown>) => unknown): DaemonTarget & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    id,
    calls,
    info: () => ({ id, platform, appId: 'com.example.test', connectedAt: 1, rev: 0 }),
    async run(op, params) {
      calls.push([op, params]);
      if (run) return run(op, params);
      return { target: id, rev: 1, path: '', state: {}, events: [], settle: { idle: true, quiescent: false, waitedMs: 2, pending: [] } };
    },
    onEvent: () => () => {},
    onState: () => () => {},
    dispose: async () => {},
  };
}

describe('screenshot and step', () => {
  let artifacts: string;
  const capture = {
    resolveDevice: async ({ platform, requested }: { platform: 'ios' | 'android'; requested?: string | undefined }) => ({ platform, id: requested ?? 'SIM-1' }),
    capture: async ({ outPath }: { outPath: string }) => {
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, 'png');
    },
  };

  afterEach(async () => {
    await rm(artifacts, { recursive: true, force: true });
  });

  it('step dispatches through the remote target, captures after settle, and reports both', async () => {
    artifacts = await mkdtemp(path.join(tmpdir(), 'ironbird-daemon-'));
    const remote = fakeRemote('ios');
    const d = await boot({ extra: { targets: [remote], artifactsPath: artifacts, capture } });
    const stepped = await rpc(d, { op: 'step', params: { name: 'cart.addItem', payload: { sku: 'x' }, path: 'cart', settle: { timeoutMs: 100 }, device: 'SIM-9' } });
    expect(stepped.json).toMatchObject({ ok: true, target: 'ios', result: { target: 'ios', rev: 1, settledBeforeCapture: true, screenshot: { device: 'SIM-9' } } });
    const shot = (stepped.json['result'] as { screenshot: { path: string } }).screenshot.path;
    expect(shot).toMatch(/\/screenshots\/\d{8}-\d{6}-\d{3}-ios\.png$/);
    expect((await readFile(shot)).toString()).toBe('png');
    expect(remote.calls).toEqual([['dispatch', { name: 'cart.addItem', payload: { sku: 'x' }, path: 'cart', settle: { timeoutMs: 100 } }]]);
  });

  it('step still captures when the step did not settle, and says so', async () => {
    artifacts = await mkdtemp(path.join(tmpdir(), 'ironbird-daemon-'));
    const remote = fakeRemote('android', 'android', () => ({ target: 'android', rev: 2, path: '', state: {}, events: [], settle: { idle: false, quiescent: false, waitedMs: 50, pending: [{ kind: 'effect', label: 'api.load', ageMs: 50, fake: false }] } }));
    const d = await boot({ extra: { targets: [remote], artifactsPath: artifacts, capture } });
    const stepped = await rpc(d, { op: 'step', params: { name: 'x' } });
    expect(stepped.json).toMatchObject({ ok: true, result: { settledBeforeCapture: false, screenshot: { device: 'SIM-1' }, settle: { idle: false } } });
  });

  it('screenshot picks the only connected app, honors out, and refuses the headless target', async () => {
    artifacts = await mkdtemp(path.join(tmpdir(), 'ironbird-daemon-'));
    const d = await boot({ extra: { targets: [fakeRemote('ios')], artifactsPath: artifacts, capture } });
    const out = path.join(artifacts, 'custom.png');
    const shot = await rpc(d, { op: 'screenshot', params: { out } });
    expect(shot.json).toMatchObject({ ok: true, target: 'ios', result: { path: out, device: 'SIM-1' } });
    expect((shot.json['result'] as { capturedAt: number }).capturedAt).toBeGreaterThan(0);
    const headless = await rpc(d, { op: 'screenshot', target: 'headless' });
    expect(headless.json).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', details: { op: 'screenshot', target: 'headless' } } });
  });

  it('screenshot fails with NO_TARGET when no app is connected and AMBIGUOUS_TARGET when several are', async () => {
    artifacts = await mkdtemp(path.join(tmpdir(), 'ironbird-daemon-'));
    const none = await boot({ extra: { artifactsPath: artifacts, capture } });
    expect((await rpc(none, { op: 'screenshot' })).json).toMatchObject({ ok: false, error: { code: 'NO_TARGET' } });
    await none.close();
    const two = await boot({ extra: { targets: [fakeRemote('ios'), fakeRemote('ios-2')], artifactsPath: artifacts, capture } });
    expect((await rpc(two, { op: 'screenshot' })).json).toMatchObject({ ok: false, error: { code: 'AMBIGUOUS_TARGET', details: { available: ['ios', 'ios-2'] } } });
    expect((await rpc(two, { op: 'screenshot', target: 'ios-2' })).json).toMatchObject({ ok: true, target: 'ios-2' });
  });

  it('starts a bridge server on the same host when asked', async () => {
    const d = await boot({ extra: { bridge: { port: 0 } } });
    expect(d.bridgeUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const socket = new WebSocket(d.bridgeUrl as string);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('bridge port refused the connection'));
    });
    socket.close();
  });
});
