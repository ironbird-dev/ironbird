import { IronbirdError } from './errors';

export type TimerId = number;

export interface ScheduledTimer {
  id: TimerId;
  dueAt: number;
  scheduledAt: number;
  label?: string;
  repeatMs?: number;
}

export interface Clock {
  readonly kind: 'real' | 'manual';
  now(): number;
  setTimeout(callback: () => void, ms: number, label?: string): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(callback: () => void, ms: number, label?: string): TimerId;
  clearInterval(id: TimerId): void;
  timers(): ScheduledTimer[];
}

export interface ManualClock extends Clock {
  readonly kind: 'manual';
  /** Fires due timers in dueAt order (ties in scheduling order), yielding a macrotask between firings. */
  advance(ms: number): Promise<void>;
  setNow(epochMs: number): void;
}

export const MAX_FIRINGS_PER_ADVANCE = 10_000;

function withLabel<T extends object>(timer: T, label: string | undefined): T & { label?: string } {
  return label === undefined ? timer : { ...timer, label };
}

export function createRealClock(): Clock {
  // Typed from the ambient global rather than pinned to `unknown`: under tsconfig.json (no Node
  // types) that's the `unknown` TimerHandle from globals.d.ts, and under tsconfig.test.json
  // (Node types) it's NodeJS.Timeout, so clearTimeout/clearInterval accept it back in both.
  interface RealEntry extends ScheduledTimer {
    handle: ReturnType<typeof setTimeout>;
  }
  const entries = new Map<TimerId, RealEntry>();
  let nextId = 1;
  const publicView = ({ handle: _handle, ...timer }: RealEntry): ScheduledTimer => timer;

  return {
    kind: 'real',
    now: () => Date.now(),
    setTimeout(callback, ms, label) {
      const id = nextId++;
      const scheduledAt = Date.now();
      const handle = setTimeout(() => {
        entries.delete(id);
        callback();
      }, ms);
      entries.set(id, withLabel({ id, dueAt: scheduledAt + ms, scheduledAt, handle }, label));
      return id;
    },
    clearTimeout(id) {
      const entry = entries.get(id);
      if (!entry) return;
      clearTimeout(entry.handle);
      entries.delete(id);
    },
    setInterval(callback, ms, label) {
      const id = nextId++;
      const scheduledAt = Date.now();
      const handle = setInterval(() => {
        const entry = entries.get(id);
        if (entry) {
          entry.scheduledAt = Date.now();
          entry.dueAt = entry.scheduledAt + ms;
        }
        callback();
      }, ms);
      entries.set(id, withLabel({ id, dueAt: scheduledAt + ms, scheduledAt, repeatMs: ms, handle }, label));
      return id;
    },
    clearInterval(id) {
      const entry = entries.get(id);
      if (!entry) return;
      clearInterval(entry.handle);
      entries.delete(id);
    },
    timers: () => [...entries.values()].map(publicView).sort((a, b) => a.dueAt - b.dueAt || a.id - b.id),
  };
}

export function createManualClock(options: { now?: number } = {}): ManualClock {
  interface ManualEntry extends ScheduledTimer {
    seq: number;
    callback: () => void;
  }
  let now = options.now ?? 0;
  let nextId = 1;
  let nextSeq = 0;
  const entries = new Map<TimerId, ManualEntry>();
  const publicView = ({ seq: _seq, callback: _callback, ...timer }: ManualEntry): ScheduledTimer => timer;

  const schedule = (callback: () => void, ms: number, label: string | undefined, repeatMs?: number): TimerId => {
    const id = nextId++;
    const base: ManualEntry = { id, dueAt: now + Math.max(0, ms), scheduledAt: now, seq: nextSeq++, callback };
    const entry = repeatMs === undefined ? base : { ...base, repeatMs };
    entries.set(id, withLabel(entry, label));
    return id;
  };

  const nextDue = (): ManualEntry | undefined => {
    let best: ManualEntry | undefined;
    for (const entry of entries.values()) {
      if (!best || entry.dueAt < best.dueAt || (entry.dueAt === best.dueAt && entry.seq < best.seq)) best = entry;
    }
    return best;
  };

  return {
    kind: 'manual',
    now: () => now,
    setTimeout: (callback, ms, label) => schedule(callback, ms, label),
    clearTimeout: (id) => {
      entries.delete(id);
    },
    setInterval: (callback, ms, label) => schedule(callback, ms, label, Math.max(1, ms)),
    clearInterval: (id) => {
      entries.delete(id);
    },
    timers: () => [...entries.values()].map(publicView).sort((a, b) => a.dueAt - b.dueAt || a.id - b.id),
    setNow: (epochMs) => {
      now = epochMs;
    },
    async advance(ms) {
      const target = now + Math.max(0, ms);
      const firingsByLabel = new Map<string, number>();
      let firings = 0;
      for (;;) {
        const next = nextDue();
        if (!next || next.dueAt > target) break;
        firings += 1;
        const label = next.label ?? `timer#${next.id}`;
        firingsByLabel.set(label, (firingsByLabel.get(label) ?? 0) + 1);
        if (firings > MAX_FIRINGS_PER_ADVANCE) {
          const labels = [...firingsByLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
          throw new IronbirdError('CLOCK_RUNAWAY', `clock advance fired more than ${MAX_FIRINGS_PER_ADVANCE} timers; likely a zero-delay loop`, {
            labels,
            firings: MAX_FIRINGS_PER_ADVANCE,
          });
        }
        now = Math.max(now, next.dueAt);
        if (next.repeatMs === undefined) {
          entries.delete(next.id);
        } else {
          next.scheduledAt = now;
          next.dueAt = now + next.repeatMs;
          next.seq = nextSeq++;
        }
        next.callback();
        // Yield to the microtask queue (not a real macrotask) so promise jobs scheduled by the
        // callback run before the next firing, without coupling manual-clock advancement to
        // real wall-clock event-loop timing (see deviation note in the task report).
        await Promise.resolve();
      }
      now = target;
    },
  };
}
