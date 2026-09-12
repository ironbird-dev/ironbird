import type { Clock } from './clock';
import type { PendingItem, SettleResult } from './protocol';
import { scheduler } from './scheduler';

export const FAKE_PORT_MARK: unique symbol = Symbol.for('ironbird.fakePort');

/** Tags a port so that tracker.wrap marks its calls fake: true. defineFake (M2) does this for every fake port. */
export function markFakePort<P extends object>(port: P): P {
  Object.defineProperty(port, FAKE_PORT_MARK, { value: true, enumerable: false, configurable: false, writable: false });
  return port;
}

export function isFakePort(port: object): boolean {
  return (port as Record<symbol, unknown>)[FAKE_PORT_MARK] === true;
}

export interface Tracker {
  track<T>(promise: Promise<T>, label: string, options?: { fake?: boolean }): Promise<T>;
  /** Shallow proxy: each method returning a thenable is tracked as `${name}.${method}`. */
  wrap<P extends object>(port: P, name: string, options?: { fake?: boolean }): P;
  pending(): PendingItem[];
  /** `timeoutMs` is wall-clock time, because a manual clock never advances on its own. */
  whenIdle(options?: { timeoutMs?: number; mode?: 'idle' | 'quiescent' }): Promise<SettleResult>;
  onChange(listener: () => void): () => void;
}

export const QUIESCENT_STABLE_YIELDS = 3;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

export function createTracker(options: { clock?: Clock; timerThresholdMs?: number; enabled?: boolean } = {}): Tracker {
  const { clock, timerThresholdMs = 1_000, enabled = true } = options;

  interface Effect {
    label: string;
    fake: boolean;
    startedAt: number;
  }

  const effects = new Set<Effect>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const timerItems = (): PendingItem[] => {
    if (!clock || clock.kind !== 'real') return [];
    const now = clock.now();
    return clock
      .timers()
      .filter((timer) => timer.dueAt - now <= timerThresholdMs)
      .map((timer) => ({ kind: 'timer', label: timer.label ?? `timer#${timer.id}`, ageMs: Math.max(0, now - timer.scheduledAt), fake: false }));
  };

  const pending = (): PendingItem[] => {
    const now = scheduler.now();
    const effectItems: PendingItem[] = [...effects].map((effect) => ({ kind: 'effect', label: effect.label, ageMs: now - effect.startedAt, fake: effect.fake }));
    return [...effectItems, ...timerItems()];
  };

  const nextTimer = (): Pick<SettleResult, 'nextTimerInMs'> => {
    if (!clock || clock.kind !== 'manual') return {};
    const first = clock.timers()[0];
    return first ? { nextTimerInMs: Math.max(0, first.dueAt - clock.now()) } : {};
  };

  const onChange = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const nextChange = (): Promise<void> =>
    new Promise((resolve) => {
      const off = onChange(() => {
        off();
        resolve();
      });
    });

  const track = <T>(promise: Promise<T>, label: string, trackOptions?: { fake?: boolean }): Promise<T> => {
    if (!enabled) return promise;
    const effect: Effect = { label, fake: trackOptions?.fake ?? false, startedAt: scheduler.now() };
    effects.add(effect);
    notify();
    const done = (): void => {
      effects.delete(effect);
      notify();
    };
    promise.then(done, done);
    return promise;
  };

  const wrap = <P extends object>(port: P, name: string, wrapOptions?: { fake?: boolean }): P => {
    if (!enabled) return port;
    const fake = wrapOptions?.fake ?? isFakePort(port);
    return new Proxy(port, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || typeof property !== 'string') return value;
        const method = value as (this: P, ...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
          const result = method.apply(target, args);
          return isThenable(result) ? track(Promise.resolve(result), `${name}.${property}`, { fake }) : result;
        };
      },
    });
  };

  const whenIdle = async (idleOptions: { timeoutMs?: number; mode?: 'idle' | 'quiescent' } = {}): Promise<SettleResult> => {
    const { timeoutMs = 5_000, mode = 'idle' } = idleOptions;
    const started = scheduler.now();
    const waited = (): number => scheduler.now() - started;
    let stableYields = 0;
    let lastKey = '';

    for (;;) {
      const items = pending();
      if (items.length === 0) return { idle: true, quiescent: false, waitedMs: waited(), pending: [], ...nextTimer() };
      if (mode === 'quiescent' && items.every((item) => item.fake)) {
        const key = items.map((item) => item.label).join('|');
        stableYields = key === lastKey ? stableYields + 1 : 0;
        lastKey = key;
        if (stableYields >= QUIESCENT_STABLE_YIELDS) {
          return { idle: false, quiescent: true, waitedMs: waited(), pending: items, ...nextTimer() };
        }
        await scheduler.yieldMacrotask();
      } else {
        stableYields = 0;
        lastKey = '';
        if (waited() >= timeoutMs) return { idle: false, quiescent: false, waitedMs: waited(), pending: items, ...nextTimer() };
        await Promise.race([nextChange(), scheduler.sleep(Math.min(16, Math.max(0, timeoutMs - waited())))]);
      }
      if (waited() >= timeoutMs) return { idle: false, quiescent: false, waitedMs: waited(), pending: pending(), ...nextTimer() };
    }
  };

  return { track, wrap, pending, whenIdle, onChange };
}
