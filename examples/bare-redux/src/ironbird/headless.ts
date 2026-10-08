import { defineHeadless } from '@ironbird/core';
import { createAppStore } from '../store/store';
import { fakeSync } from './fakes/sync';
import { trackReplacements } from './replacements';
import { toTarget } from './target';

export default defineHeadless(({ clock, recorder, tracker, env }) => {
  // A fresh fake and store per boot: `reset` runs this factory again, so ids, revisions, held
  // acknowledgements, and the fake's slow/fast alternation all start over.
  const sync = fakeSync.create({ clock, recorder });

  // Restores replace the root state; saves started before one are abandoned (see trackReplacements).
  const replacements = trackReplacements();
  const store = createAppStore(
    { sync: tracker.wrap(sync.port, 'sync') },
    { plantBug: env['PLANT_BUG'] === '1', wrapReducer: replacements.wrapReducer, syncGeneration: replacements.generation },
  );

  const target = toTarget(store);
  return { target, fakes: [sync] };
});
