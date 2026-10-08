import { defineHeadless } from '@ironbird/core';
import { withIronbirdRestore } from '@ironbird/redux';
import type { Reducer } from '@reduxjs/toolkit';
import { createAppStore } from '../store/store';
import { savesAbandoned, type AppState } from '../store/todos';
import { fakeSync } from './fakes/sync';
import { toTarget } from './target';

export default defineHeadless(({ clock, recorder, tracker, env }) => {
  // A fresh fake and store per boot: `reset` runs this factory again, so ids, revisions, held
  // acknowledgements, and the fake's slow/fast alternation all start over.
  const sync = fakeSync.create({ clock, recorder });

  // Counts state replacements. A restore answers without calling the app's reducer, so a dispatch
  // the inner reducer never saw is a replacement. Saves started before one are abandoned: their
  // acknowledgements would otherwise land on a different to-do that reuses the id.
  let generation = 0;
  const countReplacements = (reducer: Reducer<AppState>): Reducer<AppState> => {
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

  const store = createAppStore(
    { sync: tracker.wrap(sync.port, 'sync') },
    { plantBug: env['PLANT_BUG'] === '1', wrapReducer: countReplacements, syncGeneration: () => generation },
  );

  // The restored snapshot may record saves in flight, which no longer exist: clear the count once
  // the snapshot is in, so nothing waits on a completion that will be ignored.
  const target = toTarget(store);
  const restore = target.restore;
  if (restore) {
    target.restore = async (snapshot) => {
      await restore(snapshot);
      store.dispatch(savesAbandoned());
    };
  }
  return { target, fakes: [sync] };
});
