import { defineCommands } from '@ironbird/core';
import { combineReducers, configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { z } from 'zod';
import { withIronbirdRestore } from '../src/restore';

// The unit tests' fixture: a Redux Toolkit store with a to-do slice and a `meta` slice, with and
// without the restore wrapper. Never exported from the package.

export interface Todo {
  text: string;
  done: boolean;
}

export const todos = createSlice({
  name: 'todos',
  initialState: { items: [] as Todo[] },
  reducers: {
    add(state, action: PayloadAction<{ text: string }>) {
      state.items.push({ text: action.payload.text, done: false });
    },
    toggle(state, action: PayloadAction<{ index: number }>) {
      const item = state.items[action.payload.index];
      if (item) item.done = !item.done;
    },
  },
});

export const rootReducer = combineReducers({ todos: todos.reducer, meta: (state: { version: number } = { version: 1 }) => state });
export type RootState = ReturnType<typeof rootReducer>;

// Command names are the slice's action types, so the default `toAction` needs no mapping.
export const storeCommands = defineCommands({
  'todos/add': z.object({ text: z.string().min(1) }).describe('Add a to-do'),
  'todos/toggle': z.object({ index: z.number().int().min(0) }).describe('Toggle a to-do; an index past the end does nothing'),
  'todos/noop': z.object({}).describe('An action no reducer handles'),
});

export const rootSchema = z.object({
  todos: z.object({ items: z.array(z.object({ text: z.string().min(1), done: z.boolean() })) }),
  meta: z.object({ version: z.number().int() }),
});

export const SAVED: RootState = { todos: { items: [{ text: 'milk', done: true }] }, meta: { version: 1 } };

export const wrappedStore = () => configureStore({ reducer: withIronbirdRestore(rootReducer) });
export const plainStore = () => configureStore({ reducer: rootReducer });
