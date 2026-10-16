import { withIronbirdRestore } from '@ironbird/redux';
import type { Reducer } from '@reduxjs/toolkit';
import type { AppState } from '../store/todos';

export interface ReplacementTracker {
  /** Pass to createAppStore as `wrapReducer`. */
  wrapReducer: (reducer: Reducer<AppState>) => Reducer<AppState>;
  /** Pass to createAppStore as `syncGeneration`. */
  generation: () => number;
}

/**
 * Makes the root reducer restorable and counts state replacements. A restore answers without
 * calling the app's reducer, so a dispatch the inner reducer never saw is a replacement. Saves
 * started before one are abandoned: their acknowledgements would otherwise land on a different
 * to-do that reuses the id. The restored state already has inFlight 0 (see restoreSchema), so the
 * count and the generation change in the same reducer step and a save started right after can't
 * be miscounted.
 */
export function trackReplacements(): ReplacementTracker {
  let generation = 0;
  const wrapReducer = (reducer: Reducer<AppState>): Reducer<AppState> => {
    let called = false;
    const counted: Reducer<AppState> = (state, action) => {
      called = true;
      return reducer(state, action);
    };
    const restorable = withIronbirdRestore(counted);
    return (state, action) => {
      called = false;
      const next = restorable(state, action);
      if (!called) generation += 1;
      return next;
    };
  };
  return { wrapReducer, generation: () => generation };
}
