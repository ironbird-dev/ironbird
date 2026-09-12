import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
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
