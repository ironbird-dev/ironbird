import { defineHeadless } from '@ironbird/core';
import { createAppCore } from '../core/app';
import { fakeApi } from './fakes/api';
import { fakeReader } from './fakes/reader';
import { toTarget } from './target';

export default defineHeadless(({ clock, recorder, tracker, env }) => {
  // Fresh fakes per boot: `reset` runs this factory again, so counters, pending timers, and call
  // logs start over, which is what makes repeated headless runs identical.
  const reader = fakeReader.create({ clock, recorder });
  const api = fakeApi.create({ clock, recorder });
  const app = createAppCore(
    {
      reader: tracker.wrap(reader.port, 'reader'),
      api: tracker.wrap(api.port, 'api'),
      analytics: { track: (name, properties) => void recorder.record('analytics', name, properties) },
      clock,
    },
    { plantRace: env['PLANT_RACE'] === '1' },
  );
  return { target: toTarget(app), fakes: [reader, api], dispose: () => app.dispose() };
});
