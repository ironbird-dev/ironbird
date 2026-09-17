import { PROTOCOL_VERSION, createEventRecorder, createRealClock, createTarget, createTracker, defineCommands } from '@ironbird/core';
import { startBridge, type BridgeHandle } from '@ironbird/react-native';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import { startDaemon, type Daemon } from '../src/daemon';

const globals = globalThis as { requestAnimationFrame?: (callback: (time: number) => void) => number };
const originalRaf = globals.requestAnimationFrame;

beforeAll(() => {
  // The bridge paints between settle checks with requestAnimationFrame; Node has none.
  globals.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
});

afterAll(() => {
  globals.requestAnimationFrame = originalRaf;
});

interface App {
  target: ReturnType<typeof createTarget<ReturnType<typeof commandsOf>, { count: number; status: string }>>;
  tracker: ReturnType<typeof createTracker>;
  recorder: ReturnType<typeof createEventRecorder>;
  clock: ReturnType<typeof createRealClock>;
  /** Count of live `target.subscribe()` listeners. The bridge holds one for the life of the
   * connection (state notifications); `waitFor` (packages/react-native/src/handlers.ts ~105) adds
   * a second only once its request has crossed both hops (daemon RPC to socket, socket to
   * handler) and found its condition unmet. Wrapping `subscribe` here - not in package source -
   * lets a test wait on that real hop instead of a guessed sleep. */
  subscribers: () => number;
}

const commandsOf = () => defineCommands({ 'counter.add': z.object({ by: z.number().int() }), 'data.load': z.object({}) });

function app(): App {
  const clock = createRealClock();
  const tracker = createTracker({ clock });
  const recorder = createEventRecorder({ clock });
  let state = { count: 0, status: 'idle' };
  const listeners = new Set<() => void>();
  const set = (next: typeof state): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const api = tracker.wrap(
    {
      load: () =>
        new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            set({ ...state, status: 'done' });
            recorder.record('api', 'loaded');
            resolve();
          }, 30, 'api.load');
        }),
    },
    'api',
  );
  const commands = commandsOf();
  const target = createTarget<typeof commands, typeof state>({
    commands,
    dispatch: ({ name, payload }) => {
      if (name === 'counter.add') set({ ...state, count: state.count + (payload as { by: number }).by });
      if (name === 'data.load') {
        set({ ...state, status: 'loading' });
        void api.load();
      }
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  // Test-only instrumentation: count active target.subscribe() listeners so a test can wait for
  // waitFor's subscription (see the App.subscribers doc comment) instead of sleeping.
  let subscriberCount = 0;
  const nativeSubscribe = target.subscribe.bind(target);
  target.subscribe = (listener) => {
    subscriberCount += 1;
    const off = nativeSubscribe(listener);
    return () => {
      subscriberCount -= 1;
      off();
    };
  };
  return { target, tracker, recorder, clock, subscribers: () => subscriberCount };
}

let daemon: Daemon | undefined;
const handles: BridgeHandle[] = [];
const sockets: WebSocket[] = [];

async function boot(options: { token?: string; pingIntervalMs?: number } = {}): Promise<Daemon> {
  daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', log: () => {}, token: options.token, bridge: { port: 0, pingIntervalMs: options.pingIntervalMs } });
  return daemon;
}

function bridge(d: Daemon, a: App, options: { appId?: string; token?: string } = {}): BridgeHandle {
  const handle = startBridge({ target: a.target, tracker: a.tracker, recorder: a.recorder, clock: a.clock, url: d.bridgeUrl as string, appId: options.appId ?? 'com.example.test', token: options.token, logger: () => {}, reconnect: { initialDelayMs: 20, maxDelayMs: 50 } });
  handles.push(handle);
  return handle;
}

async function rpc(d: Daemon, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${d.url}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await response.json()) as Record<string, unknown>;
}

async function until(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
}

function rawClient(url: string): { socket: WebSocket; frames: Array<Record<string, unknown>>; closed: Promise<number>; open: Promise<void> } {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  socket.on('error', () => {});
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  const open = new Promise<void>((resolve) => socket.once('open', () => resolve()));
  return { socket, frames, closed, open };
}

const hello = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, marker: 'm', app: { id: 'com.example.test', platform: 'ios', bridgeVersion: '0' }, capabilities: ['settle', 'events'], ...overrides });

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.stop();
  for (const socket of sockets.splice(0)) socket.terminate();
  await daemon?.close();
  daemon = undefined;
});

describe('bridge against daemon', () => {
  it('connects, appears in status, and answers every remote operation', async () => {
    const d = await boot();
    const a = app();
    const handle = bridge(d, a);
    await until(() => d.targets().some((t) => t.id === 'ios'), 'the bridge to connect');
    expect(handle.targetId).toBe('ios');
    expect((await rpc(d, { op: 'status' }))['result']).toMatchObject({ targets: [{ id: 'ios', platform: 'ios', appId: 'com.example.test' }] });

    const described = await rpc(d, { op: 'describe', target: 'ios' });
    expect(described).toMatchObject({ ok: true, target: 'ios', result: { app: { id: 'com.example.test', platform: 'ios' }, capabilities: ['settle', 'events'] } });
    expect(Object.keys((described['result'] as { commands: object }).commands)).toEqual(['counter.add', 'data.load']);

    const stepped = await rpc(d, { op: 'dispatch', params: { name: 'data.load', path: 'status' } });
    expect(stepped).toMatchObject({ ok: true, target: 'ios', result: { target: 'ios', state: 'done', settle: { idle: true } } });
    expect((stepped['result'] as { events: Array<{ name: string }> }).events.map((e) => e.name)).toEqual(['loaded']);

    const waiting = rpc(d, { op: 'waitFor', params: { path: 'count', equals: 3, timeoutMs: 2_000 } });
    await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 3 }, settle: false } });
    expect(await waiting).toMatchObject({ ok: true, result: { path: 'count', value: 3 } });
    expect(await rpc(d, { op: 'getState', params: { path: 'count' } })).toMatchObject({ ok: true, result: { value: 3 } });
    expect(await rpc(d, { op: 'events', params: { since: 0 } })).toMatchObject({ ok: true, result: { events: [{ name: 'loaded' }] } });
    expect(await rpc(d, { op: 'settle', params: { timeoutMs: 500 } })).toMatchObject({ ok: true, result: { idle: true } });
    expect(await rpc(d, { op: 'clockNow' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', details: { op: 'clockNow', target: 'ios' } } });
    expect(await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 'x' } } })).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });

  it('forwards notifications to the stream and ends it when its target disconnects', async () => {
    const d = await boot();
    const a = app();
    const handle = bridge(d, a);
    await until(() => d.targets().length === 1, 'the bridge to connect');
    const controller = new AbortController();
    const response = await fetch(`${d.url}/v1/stream?target=ios&since=0`, { signal: controller.signal });
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
    await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 1 }, settle: false } });
    await readUntil('event: state');
    expect(text).toContain('data: {"rev":1}');
    a.recorder.record('analytics', 'opened');
    await readUntil('"name":"opened"');
    handle.stop();
    await readUntil('event: error');
    expect(text).toContain('event: target');
    expect(text).toContain('"status":"disconnected"');
    expect(text).toContain('"code":"TARGET_DISCONNECTED"');
    await until(() => d.targets().length === 0, 'the target to be removed');
    controller.abort();
  });

  it('rejects the wrong protocol, a second app, and a missing token with the documented close codes', async () => {
    const d = await boot();
    const first = bridge(d, app());
    await until(() => d.targets().length === 1, 'the first bridge');

    const wrongProtocol = rawClient(d.bridgeUrl as string);
    await wrongProtocol.open;
    wrongProtocol.socket.send(hello({ protocol: 2 }));
    expect(await wrongProtocol.closed).toBe(4001);
    expect(wrongProtocol.frames[0]).toMatchObject({ type: 'reject', code: 'PROTOCOL_MISMATCH' });

    const otherApp = rawClient(d.bridgeUrl as string);
    await otherApp.open;
    otherApp.socket.send(hello({ app: { id: 'com.other', platform: 'android', bridgeVersion: '0' } }));
    expect(await otherApp.closed).toBe(4002);
    expect(otherApp.frames[0]).toMatchObject({ type: 'reject', code: 'APP_MISMATCH', details: { expected: 'com.example.test', received: 'com.other' } });
    expect(first.connected).toBe(true);
    // Stopped before its daemon closes so it isn't still reconnecting (and possibly hitting the
    // next daemon below, if the OS reuses the port) once that daemon is gone.
    first.stop();
    await daemon?.close();

    const secured = await boot({ token: 'secret' });
    const noToken = rawClient(secured.bridgeUrl as string);
    await noToken.open;
    noToken.socket.send(hello());
    expect(await noToken.closed).toBe(4003);
    const withToken = bridge(secured, app(), { token: 'secret' });
    await until(() => withToken.connected, 'the tokened bridge');
    expect(secured.targets().map((t) => t.id)).toEqual(['ios']);
  });

  it('closes a connection that stops answering pings', async () => {
    const d = await boot({ pingIntervalMs: 20 });
    const silent = rawClient(d.bridgeUrl as string);
    await silent.open;
    silent.socket.send(hello());
    await until(() => silent.frames.some((frame) => frame['type'] === 'ping'), 'a ping');
    // Never answering the describe request or any ping: after three misses the daemon terminates.
    expect(await silent.closed).toBe(1006);
  });

  it('fails an in-flight request on disconnect, and the reconnecting bridge takes the same id', async () => {
    const d = await boot();
    const a = app();
    const first = bridge(d, a);
    await until(() => d.targets().length === 1, 'the first bridge');
    const baseline = a.subscribers();
    const pending = rpc(d, { op: 'waitFor', params: { path: 'count', equals: 99, timeoutMs: 5_000 } });
    // waitFor subscribes to the target only once its request has crossed both hops (the daemon's
    // RPC over the socket, the socket to the handler) and found count !== 99; waiting on that real
    // subscription, rather than a fixed sleep, is what makes the request actually in flight below.
    await until(() => a.subscribers() > baseline, 'the waitFor to subscribe');
    first.stop();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TARGET_DISCONNECTED', details: { target: 'ios', op: 'waitFor' } } });
    await until(() => d.targets().length === 0, 'the disconnect');
    const second = bridge(d, app());
    await until(() => d.targets().length === 1, 'the second bridge');
    expect(second.targetId).toBe('ios');
    expect(await rpc(d, { op: 'getState', target: 'ios', params: { path: 'count' } })).toMatchObject({ ok: true, target: 'ios', result: { value: 0 } });
  });
});
