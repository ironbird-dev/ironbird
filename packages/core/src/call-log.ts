import type { Clock } from './clock';
import { messageOf } from './errors';
import type { FakeCall, FakeCallsResult } from './protocol';
import { serializeState } from './serialize';
import { FAKE_PORT_MARK } from './tracker';

/** Calls kept per fake; the oldest is dropped past this, and `since` reports `truncated` when it points into the dropped range. */
export const MAX_FAKE_CALLS = 10_000;

export interface CallLog {
  /**
   * The call-recording proxy over `port`: a proxy whose target is a fresh object, never the port
   * itself, so a port the app froze still works and `tracker.wrap` can proxy the result again.
   * Reads forward to `port`; function-valued string properties come back as wrappers, created once
   * per property and cached, that record a call and invoke the original with `this` bound to `port`.
   * Symbol keys and non-function values pass through, except that `FAKE_PORT_MARK` reads `true`.
   * Property reads and `in` are forwarded; enumeration, spread, and `instanceof` are not.
   */
  wrap<P extends object>(port: P): P;
  /** A page of calls newer than `since`, as copies, with the cursor to pass next and whether `since` points into the dropped range. */
  since(since?: number, limit?: number): FakeCallsResult;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

export function createCallLog(options: { fake: string; clock: Clock }): CallLog {
  const { fake, clock } = options;
  const buffer: FakeCall[] = [];
  let lastSeq = 0;
  let evictedThrough = 0;

  const record = (method: string, args: unknown[]): FakeCall => {
    lastSeq += 1;
    // Arguments go through serializeState so a listener or other unserializable argument becomes
    // a placeholder instead of failing the call.
    const entry: FakeCall = { seq: lastSeq, t: clock.now(), fake, method, args: serializeState(args).value as unknown[], outcome: 'pending' };
    buffer.push(entry);
    if (buffer.length > MAX_FAKE_CALLS) {
      const dropped = buffer.shift();
      if (dropped) evictedThrough = dropped.seq;
    }
    return entry;
  };

  const invoke = (port: object, property: string, method: (...args: unknown[]) => unknown, args: unknown[]): unknown => {
    const entry = record(property, args);
    let result: unknown;
    try {
      result = method.apply(port, args);
    } catch (error) {
      entry.outcome = 'threw';
      entry.error = messageOf(error);
      throw error;
    }
    if (!isThenable(result)) {
      entry.outcome = 'returned';
      return result;
    }
    // The buffered entry is updated in place when the promise settles; `since` hands out copies,
    // so a caller that wants the final outcome of a pending call reads again. The rejection
    // handler here is on this derived chain only; the caller still owns the original rejection.
    Promise.resolve(result).then(
      () => {
        entry.outcome = 'resolved';
      },
      (error: unknown) => {
        entry.outcome = 'rejected';
        entry.error = messageOf(error);
      },
    );
    return result;
  };

  return {
    wrap<P extends object>(port: P): P {
      const wrappers = new Map<string, { original: unknown; wrapper: (...args: unknown[]) => unknown }>();
      const target: Record<string | symbol, unknown> = {};
      return new Proxy(target, {
        get(_target, property) {
          if (property === FAKE_PORT_MARK) return true;
          const value: unknown = Reflect.get(port, property);
          if (typeof value !== 'function' || typeof property !== 'string') return value;
          const cached = wrappers.get(property);
          if (cached && cached.original === value) return cached.wrapper;
          const method = value as (...args: unknown[]) => unknown;
          const wrapper = (...args: unknown[]): unknown => invoke(port, property, method, args);
          wrappers.set(property, { original: value, wrapper });
          return wrapper;
        },
        has(_target, property) {
          return property === FAKE_PORT_MARK || Reflect.has(port, property);
        },
      }) as P;
    },
    since(since = 0, limit = Number.POSITIVE_INFINITY) {
      const calls = buffer.filter((call) => call.seq > since).slice(0, limit).map((call) => ({ ...call }));
      const last = calls[calls.length - 1];
      return { calls, nextSeq: last ? last.seq : Math.max(since, lastSeq), truncated: since < evictedThrough };
    },
  };
}
