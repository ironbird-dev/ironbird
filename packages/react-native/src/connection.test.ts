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
  const until = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!ready()) throw new Error('timed out waiting for the bridge');
  };
  return {
    url: `ws://127.0.0.1:${port}`,
    sockets,
    frames,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        server.close(() => resolve());
      }),
    waitForFrames: (count) => until(() => frames.length >= count),
    waitForSockets: (count) => until(() => sockets.length >= count),
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connection.connected).toBe(true);

    fixture.sockets[0]!.close(1012, 'restart');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connection.connected).toBe(false);
    expect(connection.targetId).toBeNull();
    expect(seen).toEqual(['welcome', 'close']);
    expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([500]);

    await clock.advance(500);
    await fixture.waitForSockets(2);
    fixture.sockets[1]!.close(1012, 'again');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([1_000]);
    await clock.advance(1_000);
    await fixture.waitForSockets(3);
    fixture.sockets[2]!.close(1012, 'and again');
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Capped at maxDelayMs.
    expect(clock.timers().map((timer) => timer.dueAt - clock.now())).toEqual([1_500]);
    await clock.advance(1_500);
    await fixture.waitForSockets(4);
    fixture.sockets[3]!.send(JSON.stringify({ type: 'welcome', protocol: 1, targetId: 'ios' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    fixture.sockets[3]!.close(1012, 'after welcome');
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.sockets[0]!.close(4002, 'APP_MISMATCH');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connection.connected).toBe(false);
    expect(clock.timers()).toEqual([]);
    expect(logs).toContainEqual('error:ironbird daemon rejected this bridge (APP_MISMATCH): Daemon serves com.other');
  });

  it('stop closes the socket and cancels a pending reconnect', async () => {
    fixture = await daemon();
    const clock = createManualClock();
    connection = openConnection({ url: 'ws://127.0.0.1:1', clock, hello, logger: () => {}, reconnect: { initialDelayMs: 500, maxDelayMs: 5_000 }, onRequest: async () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clock.timers()).toHaveLength(1);
    connection.stop();
    expect(clock.timers()).toEqual([]);
    expect(connection.send({ type: 'pong', t: 1 })).toBe(false);
  });
});
