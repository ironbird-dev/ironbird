import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { createManualClock, createRealClock } from './clock';
import { createTracker, isFakePort, markFakePort } from './tracker';

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
    warn.mockRestore();
  });
});
