import type { Timers } from '../sync/server';

/** A timer waiting on a ManualTimers. */
export interface PendingTimer {
  dueAt: number;
  label?: string;
}

/** Timers the test moves forward by hand. Nothing fires until advance() is called. */
export interface ManualTimers extends Timers {
  /** The timers that haven't fired, soonest first. */
  timers(): PendingTimer[];
  /**
   * Moves time forward by ms, firing every timer due by then in due order (ties in the order they
   * were set). After each firing it lets the promise callbacks that firing settled run, so a reply
   * the timer resolved is handled before the next timer fires.
   */
  advance(ms: number): Promise<void>;
}

/** How many microtask turns advance() yields after each firing: enough for a `.then` chain to run. */
const SETTLE_TURNS = 10;

export function createManualTimers(): ManualTimers {
  let now = 0;
  let nextSeq = 0;
  const pending: Array<PendingTimer & { seq: number; callback: () => void }> = [];

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < SETTLE_TURNS; turn += 1) await Promise.resolve();
  };

  return {
    setTimeout(callback, ms, label) {
      const timer = { dueAt: now + Math.max(0, ms), seq: nextSeq++, callback };
      pending.push(label === undefined ? timer : { ...timer, label });
      return timer.seq;
    },
    timers: () =>
      [...pending]
        .sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)
        .map(({ dueAt, label }) => (label === undefined ? { dueAt } : { dueAt, label })),
    async advance(ms) {
      const target = now + Math.max(0, ms);
      for (;;) {
        pending.sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
        const next = pending[0];
        if (!next || next.dueAt > target) break;
        pending.shift();
        now = next.dueAt;
        next.callback();
        await settle();
      }
      now = target;
    },
  };
}
