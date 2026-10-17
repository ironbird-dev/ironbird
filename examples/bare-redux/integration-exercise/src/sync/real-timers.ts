import type { Timers } from './server';

/**
 * The real clock the device store injects into the simulated server. It is the only code in the
 * app that calls the platform timer; everything else takes time from the Timers it is given.
 */
export function createRealTimers(): Timers {
  return { setTimeout: (callback, ms) => setTimeout(callback, ms) };
}
