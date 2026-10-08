import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { initialState, type AppState } from '../store/todos';
import { appStateSchema, restoreSchema } from './schema';

const todo = { id: 't1', title: 'Buy milk', done: false, rev: 2, syncedRev: 1 };

describe('the root-state schema', () => {
  it('describes AppState exactly and accepts real states', () => {
    expectTypeOf<z.output<typeof appStateSchema>>().toEqualTypeOf<AppState>();
    expect(appStateSchema.parse(initialState)).toEqual(initialState);
    const state = { todos: { items: [todo], nextId: 2 }, sync: { inFlight: 1, lastError: 'Saving t1 failed: offline' } };
    expect(appStateSchema.parse(state)).toEqual(state);
  });

  it('rejects unknown keys, malformed ids, empty titles, and negative counts', () => {
    expect(appStateSchema.safeParse({ ...initialState, extra: 1 }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...initialState, todos: { items: [{ ...todo, id: 'x1' }], nextId: 2 } }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...initialState, todos: { items: [{ ...todo, title: '' }], nextId: 2 } }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...initialState, todos: { items: [{ ...todo, notes: 'x' }], nextId: 2 } }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...initialState, sync: { inFlight: -1, lastError: null } }).success).toBe(false);
  });

  it('zeroes the in-flight count for a restore and otherwise validates the same', () => {
    const state = { todos: { items: [todo], nextId: 2 }, sync: { inFlight: 3, lastError: 'x' } };
    expect(restoreSchema.parse(state)).toEqual({ ...state, sync: { inFlight: 0, lastError: 'x' } });
    expect(restoreSchema.safeParse({ ...state, extra: 1 }).success).toBe(false);
  });
});
