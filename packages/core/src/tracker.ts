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

  if (!enabled) {
    return {
      track: (promise) => promise,
      wrap: (port) => port,
      pending: () => [],
      whenIdle: async () => ({ idle: true, quiescent: false, waitedMs: 0, pending: [] }),
      onChange: () => () => {},
    };
  }

  interface Effect {
    id: number;
    label: string;
    fake: boolean;
    startedAt: number;
  }

  type InternalItem = { kind: 'effect'; id: number; label: string; ageMs: number; fake: boolean } | { kind: 'timer'; label: string; ageMs: number; fake: boolean };

  const toPendingItem = (item: InternalItem): PendingItem =>
    item.kind === 'effect' ? { kind: 'effect', label: item.label, ageMs: item.ageMs, fake: item.fake } : { kind: 'timer', label: item.label, ageMs: item.ageMs, fake: item.fake };

  const stabilityKey = (item: InternalItem): string => (item.kind === 'effect' ? `e${item.id}` : `t:${item.label}`);

  let nextEffectId = 1;
  const effects = new Set<Effect>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const timerItems = (): InternalItem[] => {
    if (!clock || clock.kind !== 'real') return [];
    const now = clock.now();
    return clock
      .timers()
      .filter((timer) => timer.dueAt - now <= timerThresholdMs)
      .map((timer) => ({ kind: 'timer' as const, label: timer.label ?? `timer#${timer.id}`, ageMs: Math.max(0, now - timer.scheduledAt), fake: false }));
  };

  const pendingItems = (): InternalItem[] => {
    const now = scheduler.now();
    const effectItems: InternalItem[] = [...effects].map((effect) => ({ kind: 'effect' as const, id: effect.id, label: effect.label, ageMs: now - effect.startedAt, fake: effect.fake }));
    return [...effectItems, ...timerItems()];
  };

  const pending = (): PendingItem[] => pendingItems().map(toPendingItem);

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

  const waitForChangeOrSleep = async (ms: number): Promise<void> => {
    let off: () => void = () => {};
    const changed = new Promise<void>((resolve) => {
      off = onChange(() => resolve());
    });
    try {
      await Promise.race([changed, scheduler.sleep(ms)]);
    } finally {
      off();
    }
  };

  const track = <T>(promise: Promise<T>, label: string, trackOptions?: { fake?: boolean }): Promise<T> => {
    const effect: Effect = { id: nextEffectId++, label, fake: trackOptions?.fake ?? false, startedAt: scheduler.now() };
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
    const fake = wrapOptions?.fake ?? isFakePort(port);
    const wrapperCache = new Map<string, unknown>();
    const originalCache = new Map<string, unknown>();
    return new Proxy(port, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || typeof property !== 'string') return value;
        if (wrapperCache.has(property) && originalCache.get(property) === value) {
          return wrapperCache.get(property);
        }
        const method = value as (this: P, ...args: unknown[]) => unknown;
        const wrapper = (...args: unknown[]): unknown => {
          const result = method.apply(target, args);
          return isThenable(result) ? track(Promise.resolve(result), `${name}.${property}`, { fake }) : result;
        };
        wrapperCache.set(property, wrapper);
        originalCache.set(property, value);
        return wrapper;
      },
    });
  };

  const whenIdle = async (idleOptions: { timeoutMs?: number; mode?: 'idle' | 'quiescent' } = {}): Promise<SettleResult> => {
    const { timeoutMs = 5_000, mode = 'idle' } = idleOptions;
    const started = scheduler.now();
    const waited = (): number => scheduler.now() - started;
    let stableYields = 0;
    let lastKey: string | undefined;

    for (;;) {
      const items = pendingItems();
      if (items.length === 0) return { idle: true, quiescent: false, waitedMs: waited(), pending: [], ...nextTimer() };
      if (mode === 'quiescent' && items.every((item) => item.fake)) {
        const key = items.map(stabilityKey).join('|');
        stableYields = key === lastKey ? stableYields + 1 : 0;
        lastKey = key;
        if (stableYields >= QUIESCENT_STABLE_YIELDS) {
          return { idle: false, quiescent: true, waitedMs: waited(), pending: items.map(toPendingItem), ...nextTimer() };
        }
        await scheduler.yieldMacrotask();
      } else {
        stableYields = 0;
        lastKey = undefined;
        if (waited() >= timeoutMs) return { idle: false, quiescent: false, waitedMs: waited(), pending: items.map(toPendingItem), ...nextTimer() };
        await waitForChangeOrSleep(Math.min(16, Math.max(0, timeoutMs - waited())));
      }
      if (waited() >= timeoutMs) return { idle: false, quiescent: false, waitedMs: waited(), pending: pending(), ...nextTimer() };
    }
  };

  return { track, wrap, pending, whenIdle, onChange };
}
