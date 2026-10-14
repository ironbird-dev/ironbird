import { createTarget, defineCommands, defineFake, defineHeadless } from '@ironbird/core';
import { z } from 'zod';

// A test fixture, never exported from the package: a counter capped at 2 and a bell that rings
// 100 ms after it is struck. With `env.BUG === '1'`, `count.inc` skips the cap, the deliberate bug
// the modelTest tests must find. With `env.START === 'over-cap'`, the app boots already over the
// cap, so the cap invariant fails after any first step, including one the app rejects.

export interface CounterState {
  count: number;
  rings: number;
}

export const COUNT_CAP = 2;
export const RING_DELAY_MS = 100;

export const counterCommands = defineCommands({
  'count.inc': z.object({}).describe('Add one, up to the cap'),
  'count.add': z.object({ by: z.number().int().min(1).max(3) }).describe('Add by, up to the cap'),
  'count.fail': z.object({}).describe('Always fails'),
});

export const bellFake = defineFake('bell', {
  description: 'A bell that rings 100 ms after it is struck',
  controls: {
    strike: z.object({ times: z.number().int().min(1).max(2) }).describe('Strike the bell; it rings `times` times after 100 ms'),
  },
  create: ({ clock, record }) => {
    const listeners = new Set<(times: number) => void>();
    return {
      port: {
        onRing: (listener: (times: number) => void): (() => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      controls: {
        strike: ({ times }) => {
          clock.setTimeout(
            () => {
              record('rang', { times });
              for (const listener of listeners) listener(times);
            },
            RING_DELAY_MS,
            'bell.ring',
          );
        },
      },
    };
  },
});

export const counterApp = defineHeadless(({ clock, recorder, env }) => {
  const buggy = env['BUG'] === '1';
  let state: CounterState = { count: env['START'] === 'over-cap' ? COUNT_CAP + 1 : 0, rings: 0 };
  const listeners = new Set<() => void>();
  // A capped command never lowers the count, so an app that boots over the cap stays over it.
  const capped = (by: number): number => Math.max(state.count, Math.min(COUNT_CAP, state.count + by));
  const set = (next: CounterState): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const bell = bellFake.create({ clock, recorder });
  bell.port.onRing((times) => set({ ...state, rings: state.rings + times }));
  const target = createTarget({
    commands: counterCommands,
    dispatch: (command) => {
      if (command.name === 'count.inc') set({ ...state, count: buggy ? state.count + 1 : capped(1) });
      if (command.name === 'count.add') set({ ...state, count: capped(command.payload.by) });
      if (command.name === 'count.fail') throw new Error('count.fail always fails');
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return { target, fakes: [bell] };
});
