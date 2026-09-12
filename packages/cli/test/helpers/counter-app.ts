import { createTarget, defineCommands, defineHeadless, markFakePort } from '@ironbird/core';
import { z } from 'zod';

interface State {
  count: number;
  status: 'idle' | 'loading' | 'done';
  junk?: unknown;
}

export const counterDefinition = defineHeadless(({ clock, recorder, tracker, env }) => {
  let state: State = { count: 0, status: 'idle' };
  const listeners = new Set<() => void>();
  const set = (next: State): void => {
    state = next;
    listeners.forEach((l) => l());
  };
  const port = tracker.wrap(
    markFakePort({
      load: () =>
        new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            set({ ...state, status: 'done' });
            recorder.record('api', 'loaded');
            resolve();
          }, 500, 'api.load');
        }),
    }),
    'api',
  );
  const commands = defineCommands({
    'counter.add': z.object({ by: z.number().int() }),
    'data.load': z.object({}),
    'state.junk': z.object({}),
    'boom.now': z.object({}),
  });
  const target = createTarget({
    commands,
    dispatch: ({ name, payload }) => {
      if (name === 'counter.add') set({ ...state, count: state.count + (payload as { by: number }).by });
      if (name === 'data.load') {
        set({ ...state, status: 'loading' });
        void port.load();
      }
      if (name === 'state.junk') set({ ...state, junk: new Map() });
      if (name === 'boom.now') throw new Error(`boom ${env['WHO'] ?? ''}`.trim());
    },
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  });
  return { target };
});

export type { State as CounterState };
