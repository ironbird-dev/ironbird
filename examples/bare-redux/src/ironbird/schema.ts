import { z } from 'zod';
import type { AppState } from '../store/todos';

const todo = z.strictObject({
  id: z.string().regex(/^t[1-9]\d*$/),
  title: z.string().min(1),
  done: z.boolean(),
  rev: z.number().int().min(1),
  syncedRev: z.number().int().min(0),
});

/**
 * The store's root state. `snapshot load` validates a snapshot against it before the reducer sees
 * it (AGENTS.md hard rule 4); strict objects, so a snapshot with a key the app doesn't know is
 * refused rather than carried into the store.
 */
export const appStateSchema = z.strictObject({
  todos: z.strictObject({ items: z.array(todo), nextId: z.number().int().min(1) }),
  sync: z.strictObject({ inFlight: z.number().int().min(0), lastError: z.string().nullable() }),
}) satisfies z.ZodType<AppState>;

/**
 * What `restore` validates against. A snapshot taken mid-save records saves in flight, but a
 * restore abandons them (their completions are ignored), so the count is zeroed here, in the value
 * the restore action carries, and the state is replaced in one reducer step.
 */
export const restoreSchema = appStateSchema.transform((state): AppState => ({ ...state, sync: { ...state.sync, inFlight: 0 } }));
