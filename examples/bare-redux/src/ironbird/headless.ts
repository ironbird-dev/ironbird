import { defineHeadless } from '@ironbird/core';
import { withIronbirdRestore } from '@ironbird/redux';
import { createAppStore } from '../store/store';
import { fakeSync } from './fakes/sync';
import { toTarget } from './target';

export default defineHeadless(({ clock, recorder, tracker, env }) => {
  // A fresh fake and store per boot: `reset` runs this factory again, so ids, revisions, held
  // acknowledgements, and the fake's slow/fast alternation all start over.
  const sync = fakeSync.create({ clock, recorder });
  const store = createAppStore(
    { sync: tracker.wrap(sync.port, 'sync') },
    { plantBug: env['PLANT_BUG'] === '1', wrapReducer: withIronbirdRestore },
  );
  return { target: toTarget(store), fakes: [sync] };
});
