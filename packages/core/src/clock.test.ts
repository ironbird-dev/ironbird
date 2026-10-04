import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isIronbirdError } from './errors';
import { MAX_FIRINGS_PER_ADVANCE, createManualClock, createRealClock } from './clock';

describe('createManualClock', () => {
  it('starts at the given time and only moves through advance', async () => {
    const clock = createManualClock({ now: 1_000 });
    expect(clock.now()).toBe(1_000);
    await clock.advance(250);
    expect(clock.now()).toBe(1_250);
    clock.setNow(5);
    expect(clock.now()).toBe(5);
  });

  it('fires due timers in due order with ties in scheduling order, and sets now to each due time', async () => {
    const clock = createManualClock();
    const fired: Array<[string, number]> = [];
    clock.setTimeout(() => fired.push(['b', clock.now()]), 20, 'b');
    clock.setTimeout(() => fired.push(['a1', clock.now()]), 10, 'a1');
    clock.setTimeout(() => fired.push(['a2', clock.now()]), 10, 'a2');
    clock.setTimeout(() => fired.push(['late', clock.now()]), 100);
    await clock.advance(50);
    expect(fired).toEqual([['a1', 10], ['a2', 10], ['b', 20]]);
    expect(clock.now()).toBe(50);
    expect(clock.timers()).toEqual([{ id: 4, dueAt: 100, scheduledAt: 0 }]);
  });

  it('lets promise jobs run between firings so timers can schedule timers', async () => {
    const clock = createManualClock();
    const fired: string[] = [];
    clock.setTimeout(() => {
      fired.push('first');
      Promise.resolve().then(() => fired.push('microtask'));
      clock.setTimeout(() => fired.push('second'), 5, 'second');
    }, 5);
    await clock.advance(10);
    expect(fired).toEqual(['first', 'microtask', 'second']);
  });

  it('runs zero-delay timers on advance(0)', async () => {
    const clock = createManualClock();
    let ran = false;
    clock.setTimeout(() => {
      ran = true;
    }, 0);
    await clock.advance(0);
    expect(ran).toBe(true);
  });

  it('repeats intervals and stops when cleared', async () => {
    const clock = createManualClock();
    let count = 0;
    const id = clock.setInterval(() => {
      count += 1;
      if (count === 3) clock.clearInterval(id);
    }, 10, 'tick');
    await clock.advance(100);
    expect(count).toBe(3);
    expect(clock.timers()).toEqual([]);
  });

  it('never fires cleared timeouts', async () => {
    const clock = createManualClock();
    let fired = false;
    const id = clock.setTimeout(() => {
      fired = true;
    }, 10);
    clock.clearTimeout(id);
    await clock.advance(10);
    expect(fired).toBe(false);
  });

  it('stops a runaway zero-delay loop with CLOCK_RUNAWAY naming the label', async () => {
    const clock = createManualClock();
    const loop = (): void => {
      clock.setTimeout(loop, 0, 'loop');
    };
    loop();
    const error = await clock.advance(1).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isIronbirdError(error) && error.code).toBe('CLOCK_RUNAWAY');
    expect(isIronbirdError(error) && error.details).toEqual({ labels: ['loop'], firings: MAX_FIRINGS_PER_ADVANCE });
  });

  it('drains a multi-step promise chain before firing the next timer', async () => {
    const clock = createManualClock();
    const fired: string[] = [];
    clock.setTimeout(() => {
      void (async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        clock.setTimeout(() => fired.push('chained@' + clock.now()), 300, 'chained');
      })();
    }, 1_200, 'first');
    clock.setTimeout(() => fired.push('later@' + clock.now()), 1_700, 'later');
    await clock.advance(2_000);
    expect(fired).toEqual(['chained@1500', 'later@1700']);
  });

  it('property: advancing by a then b fires the same sequence as advancing by a + b', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ delay: fc.integer({ min: 0, max: 50 }), label: fc.string({ minLength: 1, maxLength: 3 }) }), { maxLength: 12 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        async (timers, a, b) => {
          const run = async (advances: number[]): Promise<string[]> => {
            const clock = createManualClock();
            const fired: string[] = [];
            for (const timer of timers) clock.setTimeout(() => fired.push(`${timer.label}@${clock.now()}`), timer.delay, timer.label);
            for (const ms of advances) await clock.advance(ms);
            return fired;
          };
          expect(await run([a, b])).toEqual(await run([a + b]));
        },
      ),
    );
  });

  it('property: timers fire in non-decreasing due order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 20 }), async (delays) => {
        const clock = createManualClock();
        const dueTimes: number[] = [];
        for (const delay of delays) clock.setTimeout(() => dueTimes.push(clock.now()), delay);
        await clock.advance(100);
        for (let i = 1; i < dueTimes.length; i += 1) expect(dueTimes[i]).toBeGreaterThanOrEqual(dueTimes[i - 1] ?? 0);
        expect(dueTimes).toHaveLength(delays.length);
      }),
    );
  });

  it('lists timers by due time with ties by id, omitting label and repeatMs when absent', () => {
    const clock = createManualClock({ now: 100 });
    clock.setTimeout(() => {}, 50, 'late');
    clock.setTimeout(() => {}, 10);
    clock.setInterval(() => {}, 10, 'tick');
    expect(clock.timers()).toStrictEqual([
      { id: 2, dueAt: 110, scheduledAt: 100 },
      { id: 3, dueAt: 110, scheduledAt: 100, label: 'tick', repeatMs: 10 },
      { id: 1, dueAt: 150, scheduledAt: 100, label: 'late' },
    ]);
  });

  it('repeats an interval every ms milliseconds, and a zero-ms interval every millisecond', async () => {
    const clock = createManualClock();
    const ten: number[] = [];
    const tenId = clock.setInterval(() => ten.push(clock.now()), 10, 'ten');
    await clock.advance(35);
    clock.clearInterval(tenId);
    expect(ten).toEqual([10, 20, 30]);
    const zero: number[] = [];
    clock.setInterval(() => zero.push(clock.now()), 0, 'zero');
    await clock.advance(3);
    expect(zero).toEqual([35, 36, 37, 38]);
  });

  it('re-arms an interval behind a timer already due at the same time, and reports when it was re-armed', async () => {
    const clock = createManualClock();
    const fired: string[] = [];
    const id = clock.setInterval(() => fired.push(`i@${clock.now()}`), 10, 'i');
    clock.setTimeout(() => fired.push(`t@${clock.now()}`), 20, 't');
    await clock.advance(20);
    // At 10 the interval re-arms for 20, after `t` was scheduled for 20, so `t` fires first.
    expect(fired).toEqual(['i@10', 't@20', 'i@20']);
    expect(clock.timers()).toStrictEqual([{ id, dueAt: 30, scheduledAt: 20, label: 'i', repeatMs: 10 }]);
  });

  it('allows exactly MAX_FIRINGS_PER_ADVANCE firings in one advance', async () => {
    const clock = createManualClock();
    let count = 0;
    clock.setInterval(() => {
      count += 1;
    }, 1, 'tick');
    await clock.advance(MAX_FIRINGS_PER_ADVANCE);
    expect(count).toBe(MAX_FIRINGS_PER_ADVANCE);
  });

  it('names the five busiest labels in CLOCK_RUNAWAY, busiest first, with unlabeled timers by id', async () => {
    const clock = createManualClock();
    for (const label of ['a', 'b', 'c', 'd', 'e', 'f']) clock.setTimeout(() => {}, 0, label);
    const runaway = clock.setInterval(() => {}, 0);
    const error = await clock.advance(20_000).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isIronbirdError(error) && error.code).toBe('CLOCK_RUNAWAY');
    expect(isIronbirdError(error) && error.message).toMatch(/fired more than 10000 timers/);
    expect(isIronbirdError(error) && error.details).toEqual({ labels: [`timer#${runaway}`, 'a', 'b', 'c', 'd'], firings: MAX_FIRINGS_PER_ADVANCE });
  });

  it('fires a re-armed interval before a later-due timer that was scheduled before the re-arm', async () => {
    const clock = createManualClock();
    const fired: string[] = [];
    clock.setInterval(() => fired.push(`i@${clock.now()}`), 10, 'i');
    clock.setTimeout(() => fired.push(`t@${clock.now()}`), 50, 't');
    await clock.advance(50);
    // After each re-arm the interval's scheduling order is newer than `t`'s, but only its due time decides until 50.
    expect(fired).toEqual(['i@10', 'i@20', 'i@30', 'i@40', 't@50', 'i@50']);
  });
});

describe('createRealClock', () => {
  it('reports pending timers with labels and clears them when they fire', async () => {
    const clock = createRealClock();
    expect(clock.kind).toBe('real');
    const before = clock.now();
    const id = clock.setTimeout(() => {}, 5, 'quick');
    const [timer] = clock.timers();
    expect(timer?.id).toBe(id);
    expect(timer?.label).toBe('quick');
    expect(timer?.dueAt).toBeGreaterThanOrEqual(before + 5);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(clock.timers()).toEqual([]);
  });

  it('drops cleared timers and intervals from timers()', () => {
    const clock = createRealClock();
    const a = clock.setTimeout(() => {}, 1_000);
    const b = clock.setInterval(() => {}, 1_000);
    expect(clock.timers()).toHaveLength(2);
    clock.clearTimeout(a);
    clock.clearInterval(b);
    expect(clock.timers()).toEqual([]);
  });
});

describe('createRealClock with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists real timers by due time with ties by id, and reads now from Date', () => {
    const clock = createRealClock();
    expect(clock.now()).toBe(10_000);
    clock.setTimeout(() => {}, 50, 'late');
    clock.setTimeout(() => {}, 10);
    clock.setInterval(() => {}, 10, 'tick');
    expect(clock.timers()).toStrictEqual([
      { id: 2, dueAt: 10_010, scheduledAt: 10_000 },
      { id: 3, dueAt: 10_010, scheduledAt: 10_000, label: 'tick', repeatMs: 10 },
      { id: 1, dueAt: 10_050, scheduledAt: 10_000, label: 'late' },
    ]);
  });

  it('gives a real timeout scheduled after an interval the next id', () => {
    const clock = createRealClock();
    const interval = clock.setInterval(() => {}, 10, 'tick');
    const timeout = clock.setTimeout(() => {}, 20, 'after');
    expect([interval, timeout]).toEqual([1, 2]);
    expect(clock.timers().map((timer) => timer.id)).toEqual([1, 2]);
    clock.clearInterval(interval);
    clock.clearTimeout(timeout);
  });

  it('runs a real timeout once at its due time and drops it', () => {
    const clock = createRealClock();
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), 100, 'once');
    vi.advanceTimersByTime(500);
    expect(fired).toEqual([10_100]);
    expect(clock.timers()).toEqual([]);
  });

  it('re-arms a real interval and reports its new due time', () => {
    const clock = createRealClock();
    let count = 0;
    const id = clock.setInterval(() => {
      count += 1;
    }, 100, 'poll');
    vi.advanceTimersByTime(250);
    expect(count).toBe(2);
    expect(clock.timers()).toStrictEqual([{ id, dueAt: 10_300, scheduledAt: 10_200, label: 'poll', repeatMs: 100 }]);
    clock.clearInterval(id);
  });

  it('never runs a cleared real timeout or interval, and ignores unknown ids', () => {
    const clock = createRealClock();
    const fired: string[] = [];
    const timeout = clock.setTimeout(() => fired.push('timeout'), 100);
    const interval = clock.setInterval(() => fired.push('interval'), 100);
    clock.clearTimeout(timeout);
    clock.clearInterval(interval);
    expect(() => {
      clock.clearTimeout(timeout);
      clock.clearInterval(interval);
      clock.clearTimeout(999);
      clock.clearInterval(999);
    }).not.toThrow();
    vi.advanceTimersByTime(500);
    expect(fired).toEqual([]);
  });
});
