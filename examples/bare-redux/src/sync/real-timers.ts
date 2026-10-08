import type { Timers } from './server';
// exercise:begin-remove
import { createRealClock } from '@ironbird/core';

/**
 * The real clock the device store injects into the simulated server. In this repository it is
 * @ironbird/core's real clock, so the platform timer is called only inside core's clock.ts.
 */
export function createRealTimers(): Timers {
  return createRealClock();
}
// exercise:else
// /**
//  * The real clock the device store injects into the simulated server. It is the only code in the
//  * app that calls the platform timer; everything else takes time from the Timers it is given.
//  */
// export function createRealTimers(): Timers {
//   return { setTimeout: (callback, ms) => setTimeout(callback, ms) };
// }
// exercise:end
