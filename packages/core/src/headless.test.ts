import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createManualClock } from './clock';
import { defineHeadless, isHeadlessDefinition } from './headless';
import { createEventRecorder } from './recorder';
import { defineCommands } from './registry';
import { createTarget } from './target';
import { createTracker } from './tracker';

describe('defineHeadless', () => {
  it('wraps a factory and calls it with the context each time create runs', async () => {
    const commands = defineCommands({ 'x.go': z.object({}) });
    let created = 0;
    const definition = defineHeadless(({ clock, env }) => {
      created += 1;
      return { target: createTarget({ commands, dispatch: () => {}, getState: () => ({ now: clock.now(), plant: env['PLANT_RACE'] }) }) };
    });
    expect(definition.kind).toBe('ironbird.headless');
    expect(isHeadlessDefinition(definition)).toBe(true);
    expect(isHeadlessDefinition({ kind: 'other' })).toBe(false);
    expect(isHeadlessDefinition({ kind: 'ironbird.headless', create: async () => ({}) })).toBe(true);

    const clock = createManualClock({ now: 42 });
    const context = { clock, recorder: createEventRecorder({ clock }), tracker: createTracker({ clock }), env: { PLANT_RACE: '1' } };
    const app = await definition.create(context);
    expect(app.target.getState()).toEqual({ now: 42, plant: '1' });
    await definition.create(context);
    expect(created).toBe(2);
  });
});
