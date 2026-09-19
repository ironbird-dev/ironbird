import { createEventRecorder, createRealClock, createTracker } from '@ironbird/core';
import { createFakeApi } from '../ironbird/fakes/api';
import { createFakeReader } from '../ironbird/fakes/reader';
import { createAppCore } from './app';

// The one instance the UI renders. Created here, and only here, so the headless entry never
// loads it: this file is for the device build (architecture.md §5).
export const clock = createRealClock();
export const tracker = createTracker({ clock, enabled: __DEV__ });
export const recorder = createEventRecorder({ clock, enabled: __DEV__ });

// The device build has no backend. The same hand-written fakes the headless entry uses stand in
// for the reader and the payment API, now on the real clock, so a payment takes real seconds
// and the bridge's settle has real effects to wait for (spec D5).
const reader = createFakeReader({ clock, recorder });
const api = createFakeApi({ clock, recorder });

export const appCore = createAppCore({
  reader: tracker.wrap(reader.port, 'reader'),
  api: tracker.wrap(api.port, 'api'),
  analytics: { track: (name, properties) => void recorder.record('analytics', name, properties) },
  clock,
});
