import { PROTOCOL_VERSION, type TargetInfo } from '@ironbird/core';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBridgeServer, type BridgeServer } from './bridge-server';
import type { RemoteTarget } from './remote-target';

interface Client {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
  until(ready: () => boolean): Promise<void>;
}

function connect(url: string, options: { origin?: string } = {}): Promise<Client> {
  const socket = new WebSocket(url, options.origin === undefined ? {} : { origin: options.origin });
  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  socket.on('error', () => {});
  const client: Client = {
    socket,
    frames,
    closed,
    send: (frame) => socket.send(JSON.stringify(frame)),
    until: async (ready) => {
      for (let i = 0; i < 400 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      if (!ready()) throw new Error('timed out');
    },
  };
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(client));
    socket.once('error', reject);
  });
}

const hello = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  marker: 'marker',
  app: { id: 'com.example.test', platform: 'ios', bridgeVersion: '0.0.0' },
  capabilities: ['settle', 'events'],
  ...overrides,
});

let server: BridgeServer | undefined;
let sessionAppId: string | undefined;
const connected: TargetInfo[] = [];
const disconnected: string[] = [];
const logs: string[] = [];

async function boot(options: { token?: string; handshakeTimeoutMs?: number } = {}): Promise<BridgeServer> {
  sessionAppId = undefined;
  connected.length = 0;
  disconnected.length = 0;
  logs.length = 0;
  server = await startBridgeServer({
    host: '127.0.0.1',
    port: 0,
    token: options.token,
    log: (line) => logs.push(line),
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    session: { appId: () => sessionAppId, adopt: (id) => (sessionAppId = id) },
    onConnect: (target: RemoteTarget) => connected.push(target.info()),
    onDisconnect: (target: RemoteTarget) => disconnected.push(target.id),
  });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('startBridgeServer', () => {
  it('welcomes a valid hello, requests describe, registers the target, and reuses its id after a disconnect', async () => {
    const s = await boot();
    expect(s.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const client = await connect(s.url);
    client.send(hello());
    await client.until(() => client.frames.length >= 2);
    expect(client.frames[0]).toEqual({ type: 'welcome', protocol: 1, targetId: 'ios' });
    expect(client.frames[1]).toMatchObject({ type: 'request', op: 'describe' });
    expect(connected).toEqual([]);
    client.send({ type: 'response', id: client.frames[1]!['id'], ok: true, result: { app: { id: 'com.example.test', platform: 'ios' }, commands: {}, fakes: {}, capabilities: ['settle', 'events'] } });
    await client.until(() => connected.length === 1);
    expect(connected[0]).toMatchObject({ id: 'ios', platform: 'ios', appId: 'com.example.test' });
    expect(sessionAppId).toBe('com.example.test');

    const second = await connect(s.url);
    second.send(hello());
    await second.until(() => second.frames.length >= 1);
    expect(second.frames[0]).toEqual({ type: 'welcome', protocol: 1, targetId: 'ios-2' });

    client.socket.close(1000, 'reload');
    await client.until(() => disconnected.length === 1);
    expect(disconnected).toEqual(['ios']);
    const third = await connect(s.url);
    third.send(hello());
    await third.until(() => third.frames.length >= 1);
    expect(third.frames[0]).toEqual({ type: 'welcome', protocol: 1, targetId: 'ios' });
  });

  it('rejects a protocol mismatch or a malformed hello with 4001', async () => {
    const s = await boot();
    const wrong = await connect(s.url);
    wrong.send(hello({ protocol: 2 }));
    await wrong.until(() => wrong.frames.length >= 1);
    expect(wrong.frames[0]).toEqual({ type: 'reject', code: 'PROTOCOL_MISMATCH', message: 'Daemon speaks protocol 1; bridge speaks protocol 2' });
    expect(await wrong.closed).toMatchObject({ code: 4001 });

    const malformed = await connect(s.url);
    malformed.send({ type: 'request', id: 'r-1', op: 'describe' });
    await malformed.until(() => malformed.frames.length >= 1);
    expect(malformed.frames[0]).toMatchObject({ type: 'reject', code: 'PROTOCOL_MISMATCH' });
    expect(await malformed.closed).toMatchObject({ code: 4001 });
    expect(connected).toEqual([]);
  });

  it('rejects a second app with 4002 and reports both ids', async () => {
    const s = await boot();
    const first = await connect(s.url);
    first.send(hello());
    await first.until(() => first.frames.length >= 1);
    const other = await connect(s.url);
    other.send(hello({ app: { id: 'com.other.app', platform: 'android', bridgeVersion: '0.0.0' } }));
    await other.until(() => other.frames.length >= 1);
    expect(other.frames[0]).toEqual({ type: 'reject', code: 'APP_MISMATCH', message: 'This daemon serves com.example.test; the bridge is com.other.app', details: { expected: 'com.example.test', received: 'com.other.app' } });
    expect(await other.closed).toMatchObject({ code: 4002 });
  });

  it('requires the token when the daemon has one, with 4003', async () => {
    const s = await boot({ token: 'secret' });
    const missing = await connect(s.url);
    missing.send(hello());
    await missing.until(() => missing.frames.length >= 1);
    expect(missing.frames[0]).toMatchObject({ type: 'reject', code: 'UNAUTHORIZED' });
    expect(await missing.closed).toMatchObject({ code: 4003 });
    const wrong = await connect(s.url);
    wrong.send(hello({ token: 'nope' }));
    expect(await wrong.closed).toMatchObject({ code: 4003 });
    const right = await connect(s.url);
    right.send(hello({ token: 'secret' }));
    await right.until(() => right.frames.length >= 1);
    expect(right.frames[0]).toMatchObject({ type: 'welcome' });
  });

  it('terminates a connection that never says hello', async () => {
    const s = await boot({ handshakeTimeoutMs: 50 });
    const silent = await connect(s.url);
    expect(await silent.closed).toMatchObject({ code: 1006 });
  });

  it('clears the handshake timer when a socket closes before hello, so a later close() does not leave a stray log behind', async () => {
    const s = await boot({ handshakeTimeoutMs: 200 });
    const client = await connect(s.url);
    client.socket.close();
    await client.closed;
    await s.close();
    server = undefined;
    // Bounded wait slightly past the handshake window: without the fix, the timer set for this
    // connection is never cleared and fires after handshakeTimeoutMs regardless of the socket (or
    // even the whole server) already being closed, logging the "sent no hello" line for a
    // connection that closed cleanly.
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(logs.some((line) => line.includes('sent no hello'))).toBe(false);
  });

  it('refuses an upgrade whose Origin names a foreign host and accepts a loopback one', async () => {
    const s = await boot();
    await expect(connect(s.url, { origin: 'http://evil.example' })).rejects.toThrow();
    const local = await connect(s.url, { origin: 'http://localhost:4568' });
    local.send(hello());
    await local.until(() => local.frames.length >= 1);
    expect(local.frames[0]).toMatchObject({ type: 'welcome' });
  });

  it('survives a receiver-level socket error before hello, such as an invalid UTF-8 text frame', async () => {
    const s = await boot();
    const bad = await connect(s.url);
    bad.socket.send(Buffer.from([0xff, 0xfe]), { binary: false });
    expect(await bad.closed).toMatchObject({ code: 1007 });

    const good = await connect(s.url);
    good.send(hello());
    await good.until(() => good.frames.length >= 1);
    expect(good.frames[0]).toMatchObject({ type: 'welcome' });
    expect(logs.some((line) => line.includes('bridge socket error:'))).toBe(true);
  });
});
