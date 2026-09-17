import { isIronbirdError } from '@ironbird/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteTarget, type RemoteSocket, type RemoteTarget } from './remote-target';

type Listener = (...args: unknown[]) => void;

interface Fake {
  socket: RemoteSocket;
  sent: Array<Record<string, unknown>>;
  closes: Array<[number | undefined, string | undefined]>;
  terminated: number;
  receive(frame: unknown): void;
  drop(code?: number): void;
}

function fakeSocket(): Fake {
  const listeners: Record<string, Listener[]> = {};
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners[event] ?? []) listener(...args);
  };
  const fake: Fake = {
    sent: [],
    closes: [],
    terminated: 0,
    socket: {
      send: (data) => {
        fake.sent.push(JSON.parse(data) as Record<string, unknown>);
      },
      close: (code, reason) => {
        fake.closes.push([code, reason]);
        emit('close', code ?? 1005);
      },
      terminate: () => {
        fake.terminated += 1;
        emit('close', 1006);
      },
      on: (event: string, listener: Listener) => {
        (listeners[event] ??= []).push(listener);
      },
    } as RemoteSocket,
    receive: (frame) => emit('message', Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame))),
    drop: (code = 1006) => emit('close', code),
  };
  return fake;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const failure = async (promise: Promise<unknown>): Promise<{ code: string; details: unknown }> => {
  const error = await promise.catch((caught: unknown) => caught);
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return { code: error.code, details: error.details };
};

const respondTo = (fake: Fake, op: string, result: unknown): void => {
  const request = fake.sent.find((frame) => frame['type'] === 'request' && frame['op'] === op);
  if (!request) throw new Error(`no ${op} request was sent`);
  fake.receive({ type: 'response', id: request['id'], ok: true, result });
};

let target: RemoteTarget | undefined;

afterEach(async () => {
  await target?.dispose();
  target = undefined;
  vi.useRealTimers();
});

function boot(fake: Fake, overrides: Partial<Parameters<typeof createRemoteTarget>[0]> = {}): RemoteTarget {
  target = createRemoteTarget({ id: 'ios', platform: 'ios', appId: 'com.example.test', capabilities: ['settle', 'events'], socket: fake.socket, log: () => {}, pingIntervalMs: 60_000, ...overrides });
  return target;
}

describe('createRemoteTarget', () => {
  it('sends requests with ids and resolves or rejects from the matching response', async () => {
    const fake = fakeSocket();
    const t = boot(fake);
    const reading = t.run('getState', { path: 'cart' });
    await tick();
    expect(fake.sent[0]).toEqual({ type: 'request', id: 'r-1', op: 'getState', params: { path: 'cart' } });
    fake.receive({ type: 'response', id: 'r-999', ok: true, result: 'ignored' });
    fake.receive({ type: 'response', id: 'r-1', ok: true, result: { rev: 3, path: 'cart', value: [] } });
    expect(await reading).toEqual({ rev: 3, path: 'cart', value: [] });

    const failing = t.run('waitFor', { path: 'x', equals: 1 });
    await tick();
    fake.receive({ type: 'response', id: 'r-2', ok: false, error: { code: 'WAIT_TIMEOUT', message: 'no', details: { path: 'x' } } });
    expect(await failure(failing)).toEqual({ code: 'WAIT_TIMEOUT', details: { path: 'x' } });

    const malformed = t.run('events', {});
    await tick();
    fake.receive({ type: 'response', id: 'r-3', ok: false, error: 'not a shape' });
    expect(await failure(malformed)).toMatchObject({ code: 'INTERNAL', details: { target: 'ios', op: 'events' } });
    expect(t.info()).toMatchObject({ id: 'ios', platform: 'ios', appId: 'com.example.test', rev: 0 });
  });

  it('serializes mutating operations and lets reads run alongside', async () => {
    const fake = fakeSocket();
    const t = boot(fake);
    const first = t.run('dispatch', { name: 'a' });
    const read = t.run('getState', {});
    const second = t.run('dispatch', { name: 'b' });
    await tick();
    // The read and the first dispatch are on the wire; the second dispatch waits its turn.
    expect(fake.sent.map((frame) => frame['op'])).toEqual(['dispatch', 'getState']);
    respondTo(fake, 'getState', { rev: 0 });
    await read;
    fake.receive({ type: 'response', id: 'r-1', ok: true, result: { rev: 1 } });
    await first;
    await tick();
    expect(fake.sent.map((frame) => frame['op'])).toEqual(['dispatch', 'getState', 'dispatch']);
    fake.receive({ type: 'response', id: 'r-3', ok: true, result: { rev: 2 } });
    expect(await second).toEqual({ rev: 2 });
  });

  it('answers UNSUPPORTED locally for operations outside the declared capabilities', async () => {
    const fake = fakeSocket();
    const t = boot(fake, { capabilities: ['settle', 'events', 'persist'] });
    for (const op of ['clockAdvance', 'clockNow', 'reset', 'fakeControl', 'fakeCalls', 'snapshotLoad']) {
      expect(await failure(t.run(op, {}))).toEqual({ code: 'UNSUPPORTED', details: { op, target: 'ios' } });
    }
    expect(fake.sent).toEqual([]);
    const saving = t.run('snapshotSave', {});
    await tick();
    expect(fake.sent[0]).toMatchObject({ op: 'snapshotSave' });
    respondTo(fake, 'snapshotSave', { rev: 0, snapshot: {} });
    await saving;
  });

  it('caches the description once loaded', async () => {
    const fake = fakeSocket();
    const t = boot(fake);
    const loading = t.loadDescription();
    await tick();
    const description = { app: { id: 'com.example.test', platform: 'ios' }, commands: {}, fakes: {}, capabilities: ['settle', 'events'] };
    respondTo(fake, 'describe', description);
    expect(await loading).toEqual(description);
    expect(await t.run('describe', {})).toEqual(description);
    expect(fake.sent.filter((frame) => frame['op'] === 'describe')).toHaveLength(1);
  });

  it('turns notifications into event and state listeners and tracks the revision', async () => {
    const fake = fakeSocket();
    const t = boot(fake);
    const events: string[] = [];
    const revs: number[] = [];
    t.onEvent((event) => events.push(event.name));
    t.onState((rev) => revs.push(rev));
    fake.receive({ type: 'notify', kind: 'event', data: { seq: 1, t: 5, source: 'api', name: 'loaded' } });
    fake.receive({ type: 'notify', kind: 'state', data: { rev: 4 } });
    fake.receive({ type: 'notify', kind: 'warning', data: { code: 'UNSERIALIZABLE_STATE', path: 'x', valueKind: 'Map' } });
    fake.receive({ type: 'notify', kind: 'event', data: 'garbage' });
    fake.receive('{not json');
    expect(events).toEqual(['loaded']);
    expect(revs).toEqual([4]);
    expect(t.info().rev).toBe(4);
  });

  it('fails in-flight and queued work with TARGET_DISCONNECTED when the socket closes, once', async () => {
    const fake = fakeSocket();
    const closes: number[] = [];
    const t = boot(fake, { onClose: () => closes.push(1) });
    const inFlight = t.run('dispatch', { name: 'a' });
    const queued = t.run('dispatch', { name: 'b' });
    await tick();
    fake.drop(1001);
    expect(await failure(inFlight)).toEqual({ code: 'TARGET_DISCONNECTED', details: { target: 'ios', op: 'dispatch' } });
    expect(await failure(queued)).toMatchObject({ code: 'TARGET_DISCONNECTED' });
    expect(t.closed).toBe(true);
    expect(await failure(t.run('getState', {}))).toMatchObject({ code: 'TARGET_DISCONNECTED', details: { op: 'getState' } });
    fake.drop(1001);
    await t.dispose();
    expect(closes).toEqual([1]);
  });

  it('pings on the interval and terminates after the missed-pong limit', async () => {
    vi.useFakeTimers();
    const fake = fakeSocket();
    const t = boot(fake, { pingIntervalMs: 10, missedPongLimit: 3 });
    vi.advanceTimersByTime(10);
    expect(fake.sent).toEqual([{ type: 'ping', t: expect.any(Number) }]);
    fake.receive({ type: 'pong', t: 1 });
    vi.advanceTimersByTime(30);
    expect(fake.sent.filter((frame) => frame['type'] === 'ping')).toHaveLength(4);
    expect(fake.terminated).toBe(0);
    // No pong answers the last three; the fourth tick closes the connection.
    vi.advanceTimersByTime(10);
    expect(fake.terminated).toBe(1);
    expect(t.closed).toBe(true);
  });

  it('dispose closes the socket with 1001 and resolves once', async () => {
    const fake = fakeSocket();
    const t = boot(fake);
    await t.dispose();
    await t.dispose();
    expect(fake.closes).toEqual([[1001, 'daemon shutting down']]);
    expect(t.closed).toBe(true);
  });
});
