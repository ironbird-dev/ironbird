import { PROTOCOL_VERSION, createEventRecorder, createManualClock, createRealClock, createTarget, createTracker, defineCommands } from '@ironbird/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { z } from 'zod';
import { BRIDGE_MARKER, STATE_NOTIFY_INTERVAL_MS, startBridge, type BridgeHandle } from './index';

const globals = globalThis as { __DEV__?: boolean; requestAnimationFrame?: (callback: (time: number) => void) => number };

interface Fixture {
  url: string;
  sockets: ServerSocket[];
  frames: Array<Record<string, unknown>>;
  close(): Promise<void>;
  until(ready: () => boolean): Promise<void>;
}

async function daemon(): Promise<Fixture> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const sockets: ServerSocket[] = [];
  const frames: Array<Record<string, unknown>> = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    sockets,
    frames,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        server.close(() => resolve());
      }),
    until: async (ready) => {
      for (let i = 0; i < 400 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      if (!ready()) throw new Error('timed out');
    },
  };
}

function counterTarget() {
  let count = 0;
  const listeners = new Set<() => void>();
  const commands = defineCommands({ 'counter.add': z.object({ by: z.number().int() }) });
  const target = createTarget<typeof commands, { count: number }>({
    commands,
    dispatch: ({ payload }) => {
      count += payload.by;
      for (const listener of listeners) listener();
    },
    getState: () => ({ count }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return target;
}

let fixture: Fixture | undefined;
let handle: BridgeHandle | undefined;
const originalRaf = globals.requestAnimationFrame;

afterEach(async () => {
  handle?.stop();
  await fixture?.close();
  fixture = undefined;
  handle = undefined;
  delete globals.__DEV__;
  globals.requestAnimationFrame = originalRaf;
});

describe('startBridge', () => {
  it('is inert outside dev builds unless allowed', () => {
    globals.__DEV__ = false;
    const logs: string[] = [];
    handle = startBridge({ target: counterTarget(), url: 'ws://127.0.0.1:1', logger: (level, message) => logs.push(`${level}:${message}`) });
    expect(handle.connected).toBe(false);
    expect(handle.targetId).toBeNull();
    expect(logs).toEqual(['warn:startBridge is a no-op outside dev builds; pass allowInNonDevBuilds to override']);
  });

  it('connects, sends a hello carrying the marker, and answers a describe request', async () => {
    fixture = await daemon();
    globals.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
    handle = startBridge({ target: counterTarget(), url: fixture.url, appId: 'com.example.test', appName: 'Test', clock: createRealClock(), logger: () => {} });
    await fixture.until(() => fixture!.frames.length >= 1);
    expect(fixture.frames[0]).toEqual({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      marker: BRIDGE_MARKER,
      app: { id: 'com.example.test', platform: 'ios', name: 'Test', bridgeVersion: expect.any(String) },
      capabilities: ['settle', 'events'],
    });
    const socket = fixture.sockets[0]!;
    socket.send(JSON.stringify({ type: 'welcome', protocol: 1, targetId: 'ios' }));
    await fixture.until(() => handle!.connected);
    expect(handle.targetId).toBe('ios');
    socket.send(JSON.stringify({ type: 'request', id: 'r-1', op: 'describe' }));
    await fixture.until(() => fixture!.frames.length >= 2);
    expect(fixture.frames[1]).toMatchObject({ type: 'response', id: 'r-1', ok: true, result: { app: { id: 'com.example.test', platform: 'ios' }, capabilities: ['settle', 'events'] } });
    socket.send(JSON.stringify({ type: 'request', id: 'r-2', op: 'dispatch', params: { name: 'counter.add', payload: { by: 2 }, settle: false } }));
    await fixture.until(() => fixture!.frames.length >= 4);
    // A state notification precedes the response: the dispatch bumped the revision.
    expect(fixture.frames[2]).toEqual({ type: 'notify', kind: 'state', data: { rev: 1 } });
    expect(fixture.frames[3]).toMatchObject({ type: 'response', id: 'r-2', ok: true, result: { target: 'ios', rev: 1, state: { count: 2 }, settle: null } });
    socket.send(JSON.stringify({ type: 'request', id: 'r-3', op: 'clockNow' }));
    await fixture.until(() => fixture!.frames.length >= 5);
    expect(fixture.frames[4]).toMatchObject({ type: 'response', id: 'r-3', ok: false, error: { code: 'UNSUPPORTED', details: { op: 'clockNow', target: 'ios' } } });
  });

  it('forwards recorded events and throttles state notifications on the clock', async () => {
    fixture = await daemon();
    const clock = createManualClock();
    const recorder = createEventRecorder({ clock });
    const target = counterTarget();
    handle = startBridge({ target, recorder, tracker: createTracker({ clock }), clock, url: fixture.url, logger: () => {} });
    await fixture.until(() => fixture!.sockets.length >= 1);
    fixture.sockets[0]!.send(JSON.stringify({ type: 'welcome', protocol: 1, targetId: 'android' }));
    await fixture.until(() => handle!.connected);
    recorder.record('analytics', 'opened', { screen: 'cart' });
    await target.dispatch('counter.add', { by: 1 });
    await target.dispatch('counter.add', { by: 1 });
    await target.dispatch('counter.add', { by: 1 });
    await fixture.until(() => fixture!.frames.length >= 3);
    expect(fixture.frames.slice(1)).toEqual([
      { type: 'notify', kind: 'event', data: { seq: 1, t: 0, source: 'analytics', name: 'opened', data: { screen: 'cart' } } },
      { type: 'notify', kind: 'state', data: { rev: 1 } },
    ]);
    // Revisions 2 and 3 are coalesced into one frame once the window elapses.
    expect(clock.timers().map((timer) => timer.label)).toEqual(['ironbird.stateNotify']);
    await clock.advance(STATE_NOTIFY_INTERVAL_MS);
    await fixture.until(() => fixture!.frames.length >= 4);
    expect(fixture.frames[3]).toEqual({ type: 'notify', kind: 'state', data: { rev: 3 } });
    handle.stop();
    expect(clock.timers()).toEqual([]);
  });
});
