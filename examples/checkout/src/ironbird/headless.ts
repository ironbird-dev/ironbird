import { defineHeadless } from '@ironbird/core';
import { createAppCore } from '../core/app';
import { createFakeApi } from './fakes/api';
import { createFakeReader } from './fakes/reader';
import { toTarget } from './target';

export default defineHeadless(({ clock, recorder, tracker, env }) => {
  const reader = createFakeReader({ clock, recorder });
  const api = createFakeApi({ clock, recorder });
  const app = createAppCore(
    {
      reader: tracker.wrap(reader.port, 'reader'),
      api: tracker.wrap(api.port, 'api'),
      analytics: { track: (name, properties) => void recorder.record('analytics', name, properties) },
      clock,
    },
    { plantRace: env['PLANT_RACE'] === '1' },
  );
  return { target: toTarget(app), dispose: () => app.dispose() };
});
