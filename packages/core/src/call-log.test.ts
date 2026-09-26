import { describe, expect, it } from 'vitest';
import { createCallLog } from './call-log';
import { createManualClock } from './clock';
import { FAKE_PORT_MARK, createTracker, isFakePort } from './tracker';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface ReaderPort {
  readonly version: number;
  collectPayment(amountCents: number): Promise<{ token: string }>;
  onEvent(listener: (event: string) => void): () => void;
  describe(): string;
  explode(): never;
}

function reader(clock = createManualClock({ now: 1_000 })) {
  const log = createCallLog({ fake: 'reader', clock });
  let failReason: string | undefined;
  const raw: ReaderPort = {
    version: 3,
    collectPayment: (amountCents) =>
      new Promise((resolve, reject) => {
        clock.setTimeout(
          () => {
            if (failReason !== undefined) {
              reject(new Error(failReason));
              return;
            }
            resolve({ token: `fake_${amountCents}` });
          },
          100,
          'reader.collectPayment',
        );
      }),
    onEvent: () => () => {},
    describe: () => 'ready',
    explode: () => {
      throw new Error('kaboom');
    },
  };
  return { log, clock, port: log.wrap(raw), raw, fail: (reason: string) => (failReason = reason) };
}

describe('createCallLog', () => {
  it('records every outcome with serialized arguments and updates a pending call in place while earlier reads keep their copies', async () => {
    const { log, clock, port, fail } = reader();
    expect(port.describe()).toBe('ready');
    expect(() => port.explode()).toThrow('kaboom');
    port.onEvent(() => {});
    const paying = port.collectPayment(4_500);
    const before = log.since();
    expect(before).toEqual({
      calls: [
        { seq: 1, t: 1_000, fake: 'reader', method: 'describe', args: [], outcome: 'returned' },
        { seq: 2, t: 1_000, fake: 'reader', method: 'explode', args: [], outcome: 'threw', error: 'kaboom' },
        { seq: 3, t: 1_000, fake: 'reader', method: 'onEvent', args: [{ $unserializable: 'function' }], outcome: 'returned' },
        { seq: 4, t: 1_000, fake: 'reader', method: 'collectPayment', args: [4_500], outcome: 'pending' },
      ],
      nextSeq: 4,
      truncated: false,
    });
    await clock.advance(100);
    await expect(paying).resolves.toEqual({ token: 'fake_4500' });
    expect(before.calls[3]?.outcome).toBe('pending');
    expect(log.since(3).calls).toEqual([{ seq: 4, t: 1_000, fake: 'reader', method: 'collectPayment', args: [4_500], outcome: 'resolved' }]);

    fail('declined');
    const failing = port.collectPayment(1);
    await clock.advance(100);
    await expect(failing).rejects.toThrow('declined');
    expect(log.since(4).calls).toEqual([{ seq: 5, t: 1_100, fake: 'reader', method: 'collectPayment', args: [1], outcome: 'rejected', error: 'declined' }]);
  });

  it('keeps 10,000 calls, pages with since and limit, and reports truncation', () => {
    const { log, port } = reader();
    for (let i = 0; i < 10_001; i += 1) port.describe();
    const all = log.since();
    expect(all.calls).toHaveLength(10_000);
    expect(all.calls[0]?.seq).toBe(2);
    expect(all).toMatchObject({ nextSeq: 10_001, truncated: true });
    expect(log.since(1)).toMatchObject({ nextSeq: 10_001, truncated: false });
    const page = log.since(5, 2);
    expect(page.calls.map((call) => call.seq)).toEqual([6, 7]);
    expect(page).toMatchObject({ nextSeq: 7, truncated: false });
    expect(log.since(10_001)).toEqual({ calls: [], nextSeq: 10_001, truncated: false });
    // limit 0 is how a caller learns where the log stands without transferring it.
    expect(log.since(0, 0)).toEqual({ calls: [], nextSeq: 10_001, truncated: true });
    expect(createCallLog({ fake: 'empty', clock: createManualClock() }).since()).toEqual({ calls: [], nextSeq: 0, truncated: false });
  });

  it('hands out one wrapper per method, passes other values and symbols through, and forwards in', () => {
    const { port, raw } = reader();
    expect(port.describe).toBe(port.describe);
    expect(port.describe).not.toBe(raw.describe);
    expect(port.version).toBe(3);
    expect('describe' in port).toBe(true);
    expect('nope' in port).toBe(false);
    expect(FAKE_PORT_MARK in port).toBe(true);
    expect((port as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
  });

  it('carries the fake mark and works under tracker.wrap', async () => {
    const { log, clock, port } = reader();
    expect(isFakePort(port)).toBe(true);
    const tracker = createTracker({ clock });
    const wrapped = tracker.wrap(port, 'reader');
    expect(wrapped.describe).toBe(wrapped.describe);
    const paying = wrapped.collectPayment(1);
    expect(tracker.pending().map((item) => [item.label, item.fake])).toEqual([['reader.collectPayment', true]]);
    await clock.advance(100);
    await paying;
    await tick();
    expect(tracker.pending()).toEqual([]);
    expect(log.since().calls.map((call) => [call.method, call.outcome])).toEqual([['collectPayment', 'resolved']]);
  });

  it('works over a frozen port and a class instance whose methods live on the prototype', () => {
    const clock = createManualClock();
    const frozenLog = createCallLog({ fake: 'frozen', clock });
    const frozen = frozenLog.wrap(Object.freeze({ ping: () => 'pong' }));
    expect(createTracker({ clock }).wrap(frozen, 'frozen').ping()).toBe('pong');
    expect(frozenLog.since().calls).toMatchObject([{ method: 'ping', outcome: 'returned' }]);

    class Counter {
      private n = 0;
      bump(): number {
        this.n += 1;
        return this.n;
      }
    }
    const counterLog = createCallLog({ fake: 'counter', clock });
    const counter = counterLog.wrap(new Counter());
    expect(counter.bump()).toBe(1);
    expect(counter.bump()).toBe(2);
    expect('bump' in counter).toBe(true);
    expect(counterLog.since().calls.map((call) => call.method)).toEqual(['bump', 'bump']);
  });
});
