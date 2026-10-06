import { defineCommands, defineHeadless } from '@ironbird/core';
import { combineReducers, configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { z } from 'zod';
import { fromStore, withIronbirdRestore } from '../src/index';

// The in-repo sample for @ironbird/redux (M5 design §10, plan 1): a to-do list capped at three
// items, in a Redux Toolkit store whose root reducer is wrapped for restore. With
// `env.BUG === '1'`, `todos/add` skips the cap, the planted bug the model test must find. The
// target shows only `state.todos`; snapshots carry the root state, `meta` included.

export const MAX_TODOS = 3;

export interface Todo {
  text: string;
  done: boolean;
}

export interface TodosState {
  items: Todo[];
}

const todosSlice = (buggy: boolean) =>
  createSlice({
    name: 'todos',
    initialState: { items: [] } as TodosState,
    reducers: {
      add(state, action: PayloadAction<{ text: string }>) {
        if (!buggy && state.items.length >= MAX_TODOS) return;
        state.items.push({ text: action.payload.text, done: false });
      },
      toggle(state, action: PayloadAction<{ index: number }>) {
        const item = state.items[action.payload.index];
        if (item) item.done = !item.done;
      },
      clearDone(state) {
        state.items = state.items.filter((item) => !item.done);
      },
    },
  });

export function createTodoStore(buggy = false) {
  const rootReducer = combineReducers({
    todos: todosSlice(buggy).reducer,
    meta: (state: { version: number } = { version: 1 }) => state,
  });
  return configureStore({ reducer: withIronbirdRestore(rootReducer) });
}

// Command names are the slice's action types, so the default `toAction` needs no mapping.
export const todoCommands = defineCommands({
  'todos/add': z.object({ text: z.string().min(1).max(20) }).describe('Add a to-do; the list holds at most three'),
  'todos/toggle': z.object({ index: z.number().int().min(0).max(4) }).describe('Toggle the to-do at index; an index past the end does nothing'),
  'todos/clearDone': z.object({}).describe('Remove every finished to-do'),
});

export const todoStateSchema = z.object({
  todos: z.object({ items: z.array(z.object({ text: z.string().min(1).max(20), done: z.boolean() })) }),
  meta: z.object({ version: z.number().int() }),
});

export const todoApp = defineHeadless(({ env }) => {
  const store = createTodoStore(env['BUG'] === '1');
  return {
    target: fromStore(store, { commands: todoCommands, select: (state) => state.todos, restore: { schema: todoStateSchema } }),
  };
});
