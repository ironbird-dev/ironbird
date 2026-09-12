/**
 * The only module besides clock.ts that touches global timers or Date (AGENTS.md hard rule 9).
 * It provides real-time scheduling primitives for settle loops, which must yield to the host's
 * event loop and enforce wall-clock deadlines even when app time is a manual clock.
 */
export const scheduler = {
  now(): number {
    return Date.now();
  },
  /** Yields a macrotask: prefers `setImmediate` where available, falling back to a zero-delay timeout. */
  yieldMacrotask(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof setImmediate === 'function') setImmediate(() => resolve());
      else setTimeout(() => resolve(), 0);
    });
  },
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(), ms);
    });
  },
};
