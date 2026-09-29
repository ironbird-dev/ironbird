import { createEventRecorder, createRealClock, createTracker, type FakeInstance } from '@ironbird/core';
import { fakeApi } from '../ironbird/fakes/api';
import { fakeReader } from '../ironbird/fakes/reader';
import { createAppCore } from './app';

// The one instance the UI renders. Created here, and only here, so the headless entry never
// loads it: this file is for the device build (architecture.md §5).
export const clock = createRealClock();
export const tracker = createTracker({ clock, enabled: __DEV__ });
export const recorder = createEventRecorder({ clock, enabled: __DEV__ });

// The device build has no backend. The same defineFake fakes the headless entry uses stand in
// for the reader and the payment API, now on the real clock, so a payment takes real seconds
// and the bridge's settle has real effects to wait for. They are exported so device.ts can hand
// them to the bridge, which is what makes `ironbird fake` work against a connected app.
export const reader = fakeReader.create({ clock, recorder });
export const api = fakeApi.create({ clock, recorder });
export const fakes: FakeInstance[] = [reader, api];

// Expo inlines EXPO_PUBLIC_* when Metro bundles, so the flag is fixed per bundle: planting the
// race on a device means restarting Metro with the variable set and its cache cleared (M2 D12).
export const appCore = createAppCore(
  {
    reader: tracker.wrap(reader.port, 'reader'),
    api: tracker.wrap(api.port, 'api'),
    analytics: { track: (name, properties) => void recorder.record('analytics', name, properties) },
    clock,
  },
  { plantRace: process.env.EXPO_PUBLIC_PLANT_RACE === '1' },
);
