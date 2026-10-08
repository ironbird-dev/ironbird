import { createAppStore } from '../store/store';
// exercise:begin-remove
import { createEventRecorder, createRealClock, createTracker, type FakeInstance } from '@ironbird/core';
import { fakeSync } from '../ironbird/fakes/sync';
import { trackReplacements } from '../ironbird/replacements';

// The device build has no backend. The fake the headless entry uses stands in for the sync API,
// here on the real clock: a save takes real milliseconds, the bridge's settle has a pending save
// to wait for, and `ironbird fake sync ...` works against the running app. The wrapped reducer
// lets `ironbird snapshot load` replace the root state, and counts the replacements so saves
// started before one are abandoned. The bug is never planted on the device.
export const clock = createRealClock();
export const tracker = createTracker({ clock, enabled: __DEV__ });
export const recorder = createEventRecorder({ clock, enabled: __DEV__ });
const sync = fakeSync.create({ clock, recorder });
export const fakes: FakeInstance[] = [sync];
const replacements = trackReplacements();
export const store = createAppStore(
  { sync: tracker.wrap(sync.port, 'sync') },
  { wrapReducer: replacements.wrapReducer, syncGeneration: replacements.generation },
);
// exercise:else
// import { createRealTimers } from '../sync/real-timers';
// import { createSimulatedServer } from '../sync/server';
//
// // The one store the screen renders. The device build has no backend: a simulated sync server
// // answers every save, timed by the injected real clock.
// export const store = createAppStore({ sync: createSimulatedServer(createRealTimers()) });
// exercise:end
