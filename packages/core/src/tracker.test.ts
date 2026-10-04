import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock, createRealClock } from './clock';
import type { SettleResult } from './protocol';
import { FAKE_PORT_MARK, QUIESCENT_STABLE_YIELDS, createTracker, isFakePort, markFakePort } from './tracker';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createTracker', () => {
  it('wraps promise-returning methods and labels them name.method', async () => {
    const tracker = createTracker();
    const pending = deferred<string>();
    const port = { fetch: () => pending.promise, sync: () => 42, value: 'x' };
    const wrapped = tracker.wrap(port, 'api');
    expect(wrapped.value).toBe('x');
    expect(wrapped.sync()).toBe(42);
    const result = wrapped.fetch();
    expect(tracker.pending().map((item) => ({ kind: item.kind, label: item.label, fake: item.fake }))).toEqual([{ kind: 'effect', label: 'api.fetch', fake: false }]);
    pending.resolve('done');
    await expect(result).resolves.toBe('done');
    await tick();
    expect(tracker.pending()).toEqual([]);
  });

  it('removes rejected effects too', async () => {
    const tracker = createTracker();
    const pending = deferred<never>();
    const wrapped = tracker.wrap({ call: () => pending.promise }, 'api');
    const result = wrapped.call().catch(() => 'handled');
    pending.reject(new Error('nope'));
    await expect(result).resolves.toBe('handled');
    await tick();
    expect(tracker.pending()).toEqual([]);
  });

  it('marks ports tagged with markFakePort, or wrapped with fake: true, as fake', () => {
    const tracker = createTracker();
    const tagged = markFakePort({ go: () => new Promise<void>(() => {}) });
    expect(isFakePort(tagged)).toBe(true);
    tracker.wrap(tagged, 'reader').go();
    tracker.wrap({ go: () => new Promise<void>(() => {}) }, 'legacy', { fake: true }).go();
    tracker.wrap({ go: () => new Promise<void>(() => {}) }, 'real').go();
    expect(tracker.pending().map((item) => [item.label, item.fake])).toEqual([
      ['reader.go', true],
      ['legacy.go', true],
      ['real.go', false],
    ]);
  });

  it('whenIdle resolves idle once every tracked promise settles', async () => {
    const tracker = createTracker();
    const pending = deferred<void>();
    tracker.track(pending.promise, 'work');
    const settle = tracker.whenIdle({ timeoutMs: 1_000 });
    setTimeout(() => pending.resolve(), 10);
    const result = await settle;
    expect(result.idle).toBe(true);
    expect(result.quiescent).toBe(false);
    expect(result.pending).toEqual([]);
    expect(result.waitedMs).toBeGreaterThanOrEqual(5);
  });

  it('whenIdle times out with the pending list when a real effect never settles', async () => {
    const tracker = createTracker();
    tracker.track(new Promise<void>(() => {}), 'api.submit');
    const result = await tracker.whenIdle({ timeoutMs: 40 });
    expect(result.idle).toBe(false);
    expect(result.quiescent).toBe(false);
    expect(result.pending.map((item) => item.label)).toEqual(['api.submit']);
    expect(result.waitedMs).toBeGreaterThanOrEqual(40);
  });

  it('whenIdle in quiescent mode returns quickly when only fake work is pending, with the next manual timer', async () => {
    const clock = createManualClock();
    const tracker = createTracker({ clock });
    const reader = markFakePort({
      collectPayment: () =>
        new Promise<void>((resolve) => {
          clock.setTimeout(resolve, 1_200, 'reader.collectPayment');
        }),
    });
    tracker.wrap(reader, 'reader').collectPayment();
    const result = await tracker.whenIdle({ timeoutMs: 5_000, mode: 'quiescent' });
    expect(result.idle).toBe(false);
    expect(result.quiescent).toBe(true);
    expect(result.pending.map((item) => item.label)).toEqual(['reader.collectPayment']);
    expect(result.nextTimerInMs).toBe(1_200);
    expect(result.waitedMs).toBeLessThan(200);
  });

  it('whenIdle in quiescent mode keeps waiting while a real effect is pending', async () => {
    const tracker = createTracker({ clock: createManualClock() });
    tracker.wrap(markFakePort({ a: () => new Promise<void>(() => {}) }), 'fake').a();
    tracker.wrap({ b: () => new Promise<void>(() => {}) }, 'real').b();
    const result = await tracker.whenIdle({ timeoutMs: 40, mode: 'quiescent' });
    expect(result.idle).toBe(false);
    expect(result.quiescent).toBe(false);
    expect(result.pending.map((item) => item.label).sort()).toEqual(['fake.a', 'real.b']);
  });

  it('counts real-clock timers due within the threshold and ignores manual-clock timers', () => {
    const real = createRealClock();
    const realTracker = createTracker({ clock: real, timerThresholdMs: 1_000 });
    const soon = real.setTimeout(() => {}, 100, 'debounce');
    const later = real.setTimeout(() => {}, 5_000, 'poll');
    expect(realTracker.pending().map((item) => [item.kind, item.label, item.fake])).toEqual([['timer', 'debounce', false]]);
    real.clearTimeout(soon);
    real.clearTimeout(later);

    const manual = createManualClock();
    const manualTracker = createTracker({ clock: manual });
    manual.setTimeout(() => {}, 1, 'tiny');
    expect(manualTracker.pending()).toEqual([]);
  });

  it('is inert when disabled', async () => {
    const tracker = createTracker({ enabled: false });
    const port = { go: () => new Promise<void>(() => {}) };
    expect(tracker.wrap(port, 'x')).toBe(port);
    const promise = new Promise<void>(() => {});
    expect(tracker.track(promise, 'y')).toBe(promise);
    expect(tracker.pending()).toEqual([]);
    const result = await tracker.whenIdle({ timeoutMs: 10 });
    expect(result.idle).toBe(true);
  });

  it('notifies onChange when effects start and finish', async () => {
    const tracker = createTracker();
    let changes = 0;
    const off = tracker.onChange(() => {
      changes += 1;
    });
    const pending = deferred<void>();
    tracker.track(pending.promise, 'w');
    pending.resolve();
    await tick();
    off();
    tracker.track(Promise.resolve(), 'ignored');
    expect(changes).toBe(2);
  });

  it('is inert when disabled even with a real clock that has short timers', async () => {
    const clock = createRealClock();
    const tracker = createTracker({ clock, enabled: false });
    const id = clock.setTimeout(() => {}, 100, 'debounce');
    expect(tracker.pending()).toEqual([]);
    const result = await tracker.whenIdle({ timeoutMs: 1_000, mode: 'quiescent' });
    expect(result).toEqual({ idle: true, quiescent: false, waitedMs: 0, pending: [] });
    clock.clearTimeout(id);
  });

  it('does not report quiescence while fake work keeps churning under the same label', async () => {
    const clock = createManualClock();
    const tracker = createTracker({ clock });
    // setImmediate (not a real-clock ms-scale timer) so each resolve/replace cycle races directly
    // against the tracker's own macrotask-yield sampling instead of running slower than it -
    // otherwise a single still-pending call can look "stable" for 3 straight samples well within
    // its own real-timer lifetime, before it is ever replaced.
    const port = markFakePort({ poll: () => new Promise<void>((resolve) => setImmediate(resolve)) });
    const wrapped = tracker.wrap(port, 'fake');
    let churning = true;
    const loop = async (): Promise<void> => {
      while (churning) await wrapped.poll();
    };
    const running = loop();
    const result = await tracker.whenIdle({ timeoutMs: 60, mode: 'quiescent' });
    churning = false;
    await running;
    expect(result.quiescent).toBe(false);
    expect(result.idle).toBe(false);
    expect(result.pending.map((item) => item.label)).toEqual(['fake.poll']);
  });

  it('returns the same wrapper function for the same method across reads', () => {
    const tracker = createTracker();
    const wrapped = tracker.wrap({ fetch: () => Promise.resolve(1) }, 'api');
    expect(wrapped.fetch).toBe(wrapped.fetch);
  });

  it('cleans up change listeners after a settle times out', async () => {
    const tracker = createTracker();
    tracker.track(new Promise<void>(() => {}), 'stuck');
    await tracker.whenIdle({ timeoutMs: 50 });
    let calls = 0;
    const off = tracker.onChange(() => {
      calls += 1;
    });
    tracker.track(Promise.resolve(), 'fresh');
    off();
    expect(calls).toBe(1);
  });

  it('property: idle is reported only when no tracked promise is unresolved', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async (resolveFlags) => {
        const tracker = createTracker();
        const deferreds = resolveFlags.map(() => deferred<void>());
        deferreds.forEach((d, i) => tracker.track(d.promise, `p${i}`));
        deferreds.forEach((d, i) => {
          if (resolveFlags[i]) d.resolve();
        });
        await tick();
        const result = await tracker.whenIdle({ timeoutMs: 20 });
        const unresolved = resolveFlags.filter((flag) => !flag).length;
        expect(result.idle).toBe(unresolved === 0);
        expect(result.pending).toHaveLength(unresolved);
        deferreds.forEach((d) => d.resolve());
      }),
      { numRuns: 30 },
    );
  });

  it('marks a port with a hidden, permanent global-registry symbol', () => {
    const port = markFakePort({ go: () => Promise.resolve() });
    // The registry key lets a second copy of core (the ESM and CommonJS builds) recognise the mark.
    expect(FAKE_PORT_MARK).toBe(Symbol.for('ironbird.fakePort'));
    expect(Object.getOwnPropertyDescriptor(port, FAKE_PORT_MARK)).toEqual({ value: true, enumerable: false, configurable: false, writable: false });
    expect(isFakePort({ ...port })).toBe(false);
  });

  it('passes non-promise results through untouched', () => {
    const tracker = createTracker();
    const plain = { ok: true };
    const notThenable = { then: 'later' };
    const wrapped = tracker.wrap({ plain: () => plain, nothing: () => null, odd: () => notThenable }, 'api');
    expect(wrapped.plain()).toBe(plain);
    expect(wrapped.nothing()).toBeNull();
    expect(wrapped.odd()).toBe(notThenable);
    expect(tracker.pending()).toEqual([]);
  });

  it('passes symbol-keyed methods through unwrapped', () => {
    const tracker = createTracker();
    const key = Symbol('custom');
    const method = (): Promise<number> => Promise.resolve(1);
    const wrapped = tracker.wrap({ [key]: method }, 'api');
    expect(wrapped[key]).toBe(method);
  });

  it('calls a method replaced on the port after it was first read', async () => {
    const tracker = createTracker();
    const port = { fetch: (): Promise<number> => Promise.resolve(1) };
    const wrapped = tracker.wrap(port, 'api');
    const first = wrapped.fetch;
    expect(await wrapped.fetch()).toBe(1);
    port.fetch = () => Promise.resolve(2);
    expect(wrapped.fetch).not.toBe(first);
    expect(await wrapped.fetch()).toBe(2);
  });

  it('returns a callable unsubscribe from onChange when disabled', () => {
    const tracker = createTracker({ enabled: false });
    const off = tracker.onChange(() => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('in idle mode, waits out fake-backed work instead of reporting quiescence', async () => {
    const tracker = createTracker({ clock: createManualClock() });
    tracker.wrap(markFakePort({ go: () => new Promise<void>(() => {}) }), 'reader').go();
    const result = await tracker.whenIdle({ timeoutMs: 40 });
    expect(result).toMatchObject({ idle: false, quiescent: false });
    expect(result.pending.map((item) => item.label)).toEqual(['reader.go']);
  });

  it('reports quiescence after QUIESCENT_STABLE_YIELDS unchanged samples, restarting the count when real work interleaves', async () => {
    const clock = createRealClock();
    const tracker = createTracker({ clock });
    tracker.wrap(markFakePort({ go: () => new Promise<void>(() => {}) }), 'reader').go();
    const real = deferred<void>();
    let samples = 0;
    // A real clock's timers() is read exactly once per settle sample, so the spy counts samples and
    // acts at chosen ones: real work starts during sample 2 (seen from sample 3) and settles during sample 3.
    vi.spyOn(clock, 'timers').mockImplementation(() => {
      samples += 1;
      if (samples === 2) void tracker.track(real.promise, 'api.submit');
      if (samples === 3) real.resolve();
      return [];
    });
    const result = await tracker.whenIdle({ timeoutMs: 5_000, mode: 'quiescent' });
    expect(result).toMatchObject({ idle: false, quiescent: true });
    // Samples 1-2 fake only, sample 3 sees the real effect and restarts the count, then
    // QUIESCENT_STABLE_YIELDS + 1 unchanged fake-only samples (4 to 7) report quiescence.
    expect(samples).toBe(3 + QUIESCENT_STABLE_YIELDS + 1);
  });

  it('settles once a short real timer fires, though timers send no change', async () => {
    const clock = createRealClock();
    const tracker = createTracker({ clock });
    clock.setTimeout(() => {}, 30, 'debounce');
    const result = await tracker.whenIdle({ timeoutMs: 2_000 });
    expect(result.idle).toBe(true);
    expect(result.waitedMs).toBeLessThan(1_000);
  });
});

describe('listener isolation', () => {
  it('a throwing onChange listener does not stop later listeners or the tracked promise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = createTracker();
    let calls = 0;
    tracker.onChange(() => {
      throw new Error('listener broke');
    });
    tracker.onChange(() => {
      calls += 1;
    });
    await tracker.track(Promise.resolve(1), 'api.load');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener broke'));
    warn.mockRestore();
  });
});

describe('createTracker with frozen wall-clock time', () => {
  beforeEach(() => {
    // setImmediate stays real so quiescent sampling still yields; scheduler.sleep never fires.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports an effect tracked without options as real, with its wall-clock age', () => {
    const tracker = createTracker();
    void tracker.track(new Promise<void>(() => {}), 'work');
    vi.setSystemTime(10_250);
    expect(tracker.pending()).toEqual([{ kind: 'effect', label: 'work', ageMs: 250, fake: false }]);
  });

  it('counts a real timer due exactly at the threshold, names unlabeled timers by id, and ages timers from when they were scheduled', () => {
    const clock = createRealClock();
    const tracker = createTracker({ clock, timerThresholdMs: 1_000 });
    clock.setTimeout(() => {}, 1_300, 'edge');
    clock.setTimeout(() => {}, 1_301, 'beyond');
    const unlabeled = clock.setTimeout(() => {}, 500);
    vi.advanceTimersByTime(300);
    // now 10_300: 'edge' is due in exactly 1_000 ms, 'beyond' in 1_001 ms.
    expect(tracker.pending()).toEqual([
      { kind: 'timer', label: `timer#${unlabeled}`, ageMs: 300, fake: false },
      { kind: 'timer', label: 'edge', ageMs: 300, fake: false },
    ]);
  });

  it("reports nextTimerInMs from the manual clock's current time, and never for a real clock", async () => {
    const manual = createManualClock({ now: 5_000 });
    manual.setTimeout(() => {}, 1_200, 'reader');
    expect(await createTracker({ clock: manual }).whenIdle()).toEqual({ idle: true, quiescent: false, waitedMs: 0, pending: [], nextTimerInMs: 1_200 });
    const real = createRealClock();
    real.setTimeout(() => {}, 5_000, 'poll');
    expect(await createTracker({ clock: real }).whenIdle()).toEqual({ idle: true, quiescent: false, waitedMs: 0, pending: [] });
  });

  it('wakes on a tracked change instead of waiting for the next poll', async () => {
    const tracker = createTracker();
    const work = deferred<void>();
    void tracker.track(work.promise, 'work');
    const settled = tracker.whenIdle({ timeoutMs: 1_000 });
    work.resolve();
    expect(await settled).toEqual({ idle: true, quiescent: false, waitedMs: 0, pending: [] });
  });

  it('returns at once with the pending list when timeoutMs is 0', async () => {
    const tracker = createTracker();
    void tracker.track(new Promise<void>(() => {}), 'api.submit');
    expect(await tracker.whenIdle({ timeoutMs: 0 })).toEqual({
      idle: false,
      quiescent: false,
      waitedMs: 0,
      pending: [{ kind: 'effect', label: 'api.submit', ageMs: 0, fake: false }],
    });
  });

  it('times out at its deadline rather than on the next poll after it', async () => {
    const tracker = createTracker();
    void tracker.track(new Promise<void>(() => {}), 'api.submit');
    let result: SettleResult | undefined;
    void tracker.whenIdle({ timeoutMs: 20 }).then((settled) => {
      result = settled;
    });
    // Polls at 0 and 16 ms; the second sleeps only the 4 ms left, so the deadline is met exactly.
    await vi.advanceTimersByTimeAsync(20);
    expect(result).toEqual({ idle: false, quiescent: false, waitedMs: 20, pending: [{ kind: 'effect', label: 'api.submit', ageMs: 20, fake: false }] });
  });

  it('re-samples unchanged real work once per 16 ms poll instead of spinning', async () => {
    const clock = createRealClock();
    const tracker = createTracker({ clock });
    let samples = 0;
    // A real clock's timers() is read exactly once per settle sample.
    vi.spyOn(clock, 'timers').mockImplementation(() => {
      samples += 1;
      return [];
    });
    void tracker.track(new Promise<void>(() => {}), 'api.submit');
    const settled = tracker.whenIdle({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(15);
    expect(samples).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(samples).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(await settled).toMatchObject({ idle: false, waitedMs: 100 });
  });

  it('gives up after one sample in quiescent mode when timeoutMs is 0', async () => {
    const tracker = createTracker({ clock: createManualClock() });
    tracker.wrap(markFakePort({ go: () => new Promise<void>(() => {}) }), 'reader').go();
    expect(await tracker.whenIdle({ timeoutMs: 0, mode: 'quiescent' })).toMatchObject({ idle: false, quiescent: false, waitedMs: 0 });
  });
});
