import { IronbirdError, PROTOCOL_VERSION, createManualClock } from '@ironbird/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { openConnection, type Connection } from './connection';
import type { HelloFrame } from './messages';

interface Fixture {
  url: string;
  sockets: ServerSocket[];
  frames: Array<Record<string, unknown>>;
  close(): Promise<void>;
  waitForFrames(count: number): Promise<void>;
  waitForSockets(count: number): Promise<void>;
}

// Waits on an observable condition instead of a fixed sleep: socket events arrive asynchronously and a
// loaded CI runner can take longer than any constant, so every wait in this file names the state it needs.
const until = async (ready: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
};

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
    waitForFrames: (count) => until(() => frames.length >= count, `${count} frame(s) from the bridge`),
    waitForSockets: (count) => until(() => sockets.length >= count, `${count} bridge socket(s)`),
  };
}

const hello = (): HelloFrame => ({ type: 'hello', protocol: PROTOCOL_VERSION, marker: 'marker', app: { id: 'com.example.test', platform: 'ios', bridgeVersion: '0.0.0' }, capabilities: ['settle', 'events'] });

let fixture: Fixture | undefined;
let connection: Connection | undefined;

afterEach(async () => {
  connection?.stop();
  await fixture?.close();
  fixture = undefined;
  connection = undefined;
});

describe('openConnection', () => {
  it('sends hello, takes its id from welcome, answers pings, and answers requests', async () => {
    fixture = await daemon();
    const clock = createManualClock();
    const seen: string[] = [];
    connection = openConnection({
      url: fixture.url,
      clock,
      hello,
      logger: () => {},
      reconnect: { initialDelayMs: 500, maxDelayMs: 5_000 },
      onRequest: async (op, params) => {
        if (op === 'boom') throw new IronbirdError('UNSUPPORTED', 'nope', { op });
        return { op, params };
      },
      onWelcome: (id) => seen.push(`welcome:${id}`),
      onClose: () => seen.push('close'),
    });
    await fixture.waitForFrames(1);
    expect(fixture.frames[0]).toMatchObject({ type: 'hello', protocol: 1, marker: 'marker', app: { id: 'com.example.test', platform: 'ios' } });
    expect(connection.connected).toBe(false);
    const socket = fixture.sockets[0]!;
    socket.send(JSON.stringify({ type: 'welcome', protocol: 1, targetId: 'ios' }));
    await until(() => connection!.connected, 'the welcome to be processed');
    expect(connection.connected).toBe(true);
    expect(connection.targetId).toBe('ios');
    expect(seen).toEqual(['welcome:ios']);

    socket.send(JSON.stringify({ type: 'ping', t: 42 }));
    socket.send(JSON.stringify({ type: 'request', id: 'r-1', op: 'getState', params: { path: 'a' } }));
    socket.send(JSON.stringify({ type: 'request', id: 'r-2', op: 'boom' }));
    socket.send('{not json');
    await fixture.waitForFrames(4);
    expect(fixture.frames.slice(1)).toEqual([
      { type: 'pong', t: 42 },
      { type: 'response', id: 'r-1', ok: true, result: { op: 'getState', params: { path: 'a' } } },
      { type: 'response', id: 'r-2', ok: false, error: { code: 'UNSUPPORTED', message: 'nope', details: { op: 'boom' } } },
    ]);
    expect(connection.send({ type: 'notify', kind: 'state', data: { rev: 1 } })).toBe(true);
    await fixture.waitForFrames(5);
    expect(fixture.frames[4]).toEqual({ type: 'notify', kind: 'state', data: { rev: 1 } });
  });

  it('reconnects with exponential backoff on the clock and resets it after a welcome', async () => {
    fixture = await daemon();
    const clock = createManualClock();
    const seen: string[] = [];
    connection = openConnection({ url: fixture.url, clock, hello, logger: () => {}, reconnect: { initialDelayMs: 500, maxDelayMs: 1_500 }, onRequest: async () => undefined, onWelcome: () => seen.push('welcome'), onClose: () => seen.push('close') });
    await fixture.waitForSockets(1);
    fixture.sockets[0]!.send(JSON.stringify({ type: 'welcome', protocol: 1, targetId: 'ios' }));
    await until(() => connection!.connected, 'the welcome to be processed');
    expect(connection.connected).toBe(true);

    fixture.sockets[0]!.close(1012, 'restart');
    await until(() => clock.timers().length === 1, 'the close to schedule a reconnect');
    expect(connection.connected).toBe(false);
    expect(connection.targetId).toBeNull();
    expect(seen).toEqual(['welcome', 'close']);
    expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([500]);

    await clock.advance(500);
    await fixture.waitForSockets(2);
    fixture.sockets[1]!.close(1012, 'again');
    await until(() => clock.timers().length === 1, 'the close to schedule a reconnect');
    expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([1_000]);
    await clock.advance(1_000);
    await fixture.waitForSockets(3);
    fixture.sockets[2]!.close(1012, 'and again');
    await until(() => clock.timers().length === 1, 'the close to schedule a reconnect');
    // Capped at maxDelayMs.
    expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([1_500]);
    await clock.advance(1_500);
    await fixture.waitForSockets(4);
    fixture.sockets[3]!.send(JSON.stringify({ type: 'welcome', protocol: 1, targetId: 'ios' }));
    await until(() => connection!.connected, 'the welcome to be processed');
    fixture.sockets[3]!.close(1012, 'after welcome');
    await until(() => clock.timers().length === 1, 'the close to schedule a reconnect');
    // A welcome resets the attempt counter.
    expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([500]);
  });

  it('treats a reject as final', async () => {
    fixture = await daemon();
    const clock = createManualClock();
    const logs: string[] = [];
    connection = openConnection({ url: fixture.url, clock, hello, logger: (level, message) => logs.push(`${level}:${message}`), reconnect: { initialDelayMs: 500, maxDelayMs: 5_000 }, onRequest: async () => undefined });
    await fixture.waitForSockets(1);
    fixture.sockets[0]!.send(JSON.stringify({ type: 'reject', code: 'APP_MISMATCH', message: 'Daemon serves com.other' }));
    await until(() => logs.some((line) => line.startsWith('error:')), 'the reject to be processed');
    fixture.sockets[0]!.close(4002, 'APP_MISMATCH');
    await until(() => fixture!.sockets[0]!.readyState === fixture!.sockets[0]!.CLOSED, 'the close handshake to finish');
    expect(connection.connected).toBe(false);
    expect(clock.timers()).toEqual([]);
    expect(logs).toContainEqual('error:ironbird daemon rejected this bridge (APP_MISMATCH): Daemon serves com.other');
  });

  it('stop closes the socket and cancels a pending reconnect', async () => {
    fixture = await daemon();
    const clock = createManualClock();
    connection = openConnection({ url: 'ws://127.0.0.1:1', clock, hello, logger: () => {}, reconnect: { initialDelayMs: 500, maxDelayMs: 5_000 }, onRequest: async () => undefined });
    // The refused connect surfaces through onclose asynchronously; a loaded CI runner can take longer than any fixed sleep.
    await until(() => clock.timers().length === 1, 'the refused connect to schedule a reconnect');
    expect(clock.timers()).toHaveLength(1);
    connection.stop();
    expect(clock.timers()).toEqual([]);
    expect(connection.send({ type: 'pong', t: 1 })).toBe(false);
  });

  it('reconnects when the runtime reports a failed connect with an error and no close', async () => {
    // Node 22's WebSocket (undici 6) fires only `error` for a refused connect and stays CONNECTING forever;
    // React Native and newer Node follow the error with `close`. Both shapes must schedule exactly one reconnect.
    class FakeSocket {
      readyState = 0;
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor() {
        created.push(this);
      }
      send(): void {}
      close(): void {}
    }
    const created: FakeSocket[] = [];
    const globals = globalThis as { WebSocket?: unknown };
    const original = globals.WebSocket;
    globals.WebSocket = FakeSocket;
    try {
      const clock = createManualClock();
      const seen: string[] = [];
      connection = openConnection({ url: 'ws://fake', clock, hello, logger: () => {}, reconnect: { initialDelayMs: 500, maxDelayMs: 5_000 }, onRequest: async () => undefined, onClose: () => seen.push('close') });

      // Never opened, error only: treated as closed.
      created[0]!.onerror?.({});
      expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([500]);
      // A runtime that does follow up with close must not schedule a second reconnect.
      created[0]!.onclose?.({ code: 1006, reason: '' });
      expect(clock.timers()).toHaveLength(1);

      // An error on a socket that did open waits for its close event, which every runtime sends.
      await clock.advance(500);
      expect(created).toHaveLength(2);
      created[1]!.onopen?.({});
      created[1]!.onerror?.({});
      expect(clock.timers()).toEqual([]);
      created[1]!.onclose?.({ code: 1006, reason: '' });
      expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([1_000]);
      // Neither socket was ever welcomed, so the host never hears a close.
      expect(seen).toEqual([]);
    } finally {
      globals.WebSocket = original;
    }
  });
});
