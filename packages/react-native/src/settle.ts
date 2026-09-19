import type { Clock, SettleResult, TimerId, Tracker } from '@ironbird/core';

export interface SettleDeps {
  clock: Clock;
  tracker: Tracker;
  /** Schedules one animation frame: `requestAnimationFrame` in the app, a stub in tests. */
  requestFrame: (callback: () => void) => void;
}

export interface SettleOptions {
  /** Animation frames to wait after the tracker is idle (default 2 in startBridge). */
  frames: number;
  timeoutMs: number;
}

interface Sleep {
  promise: Promise<void>;
  cancel(): void;
}

function sleep(clock: Clock, ms: number): Sleep {
  let id: TimerId | undefined;
  const promise = new Promise<void>((resolve) => {
    id = clock.setTimeout(resolve, ms, 'ironbird.settle');
  });
  return {
    promise,
    cancel: () => {
      if (id !== undefined) clock.clearTimeout(id);
    },
  };
}

function animationFrames(requestFrame: SettleDeps['requestFrame'], count: number): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const tick = (): void => {
      left -= 1;
      if (left <= 0) resolve();
      else requestFrame(tick);
    };
    if (count <= 0) resolve();
    else requestFrame(tick);
  });
}

function nextChange(tracker: Tracker): { promise: Promise<void>; off(): void } {
  let off: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    off = tracker.onChange(() => resolve());
  });
  return { promise, off };
}

/**
 * The remote settle from architecture.md §6.5: yield a macrotask so subscriptions and React
 * scheduling can begin, wait until the tracker has nothing pending, wait `frames` animation
 * frames so the UI has painted, and re-check the tracker before reporting idle. Time comes from
 * the injected clock, so tests drive this with a manual clock; frames come from the rendering
 * signal directly. A timeout while frames are still outstanding (an app in the background never
 * paints) reports `idle: false` with whatever is pending, which may be nothing.
 */
export async function settle(deps: SettleDeps, options: SettleOptions): Promise<SettleResult> {
  const { clock, tracker, requestFrame } = deps;
  const started = clock.now();
  const waited = (): number => clock.now() - started;
  const notSettled = (): SettleResult => ({ idle: false, quiescent: false, waitedMs: waited(), pending: tracker.pending() });

  const yieldMacrotask = sleep(clock, 0);
  await yieldMacrotask.promise;

  for (;;) {
    const remaining = options.timeoutMs - waited();
    if (remaining <= 0) return notSettled();
    if (tracker.pending().length === 0) {
      const deadline = sleep(clock, remaining);
      let painted = false;
      try {
        await Promise.race([animationFrames(requestFrame, options.frames).then(() => (painted = true)), deadline.promise]);
      } finally {
        deadline.cancel();
      }
      if (!painted) return notSettled();
      if (tracker.pending().length === 0) return { idle: true, quiescent: false, waitedMs: waited(), pending: [] };
      continue;
    }
    const change = nextChange(tracker);
    const pause = sleep(clock, Math.min(16, remaining));
    try {
      await Promise.race([change.promise, pause.promise]);
    } finally {
      change.off();
      pause.cancel();
    }
  }
}
