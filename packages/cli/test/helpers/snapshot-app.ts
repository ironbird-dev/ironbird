import { createTarget, defineCommands, defineHeadless } from '@ironbird/core';
import { z } from 'zod';

const notesSchema = z.strictObject({ notes: z.array(z.string()), status: z.enum(['idle', 'saving']) });

export type NotesState = z.infer<typeof notesSchema> & { junk?: unknown };

/**
 * A headless app that persists and restores its root state, for the snapshot tests. `state.junk`
 * puts a Map into the state, so a save must fail with INVALID_SNAPSHOT; `restore` validates with a
 * strict schema before applying anything, as AGENTS.md rule 4 asks of every restore.
 */
export const notesDefinition = defineHeadless(() => {
  let state: NotesState = { notes: [], status: 'idle' };
  const listeners = new Set<() => void>();
  const set = (next: NotesState): void => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const commands = defineCommands({
    'note.add': z.object({ text: z.string().min(1) }),
    'note.clear': z.object({}),
    'state.junk': z.object({}),
  });
  const target = createTarget({
    commands,
    dispatch: ({ name, payload }) => {
      if (name === 'note.add') set({ ...state, notes: [...state.notes, (payload as { text: string }).text] });
      if (name === 'note.clear') set({ notes: [], status: 'idle' });
      if (name === 'state.junk') set({ ...state, junk: new Map([['k', 1]]) });
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    persist: () => state,
    restore: (snapshot) => set(notesSchema.parse(snapshot)),
  });
  return { target };
});
