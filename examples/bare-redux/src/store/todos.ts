import { combineReducers, createAction, createReducer, type Reducer } from '@reduxjs/toolkit';

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  /** Local revision: 1 when added, plus 1 per edit. */
  rev: number;
  /** The highest revision the sync API has acknowledged; 0 before the first acknowledgement. */
  syncedRev: number;
}

export interface AppState {
  todos: { items: Todo[]; nextId: number };
  sync: { inFlight: number; lastError: string | null };
}

export const added = createAction<{ title: string }>('todos/added');
export const toggled = createAction<{ id: string }>('todos/toggled');
export const renamed = createAction<{ id: string; title: string }>('todos/renamed');
export const saveStarted = createAction<{ id: string; rev: number }>('sync/saveStarted');
export const saveAcked = createAction<{ id: string; rev: number }>('sync/saveAcked');
export const saveFailed = createAction<{ id: string; rev: number; reason: string }>('sync/saveFailed');

export const initialState: AppState = {
  todos: { items: [], nextId: 1 },
  sync: { inFlight: 0, lastError: null },
};

export interface ReducerOptions {
  /**
   * The planted bug: an acknowledgement sets syncedRev to its own revision even when a newer one
   * was already acknowledged, so a reordered pair leaves the to-do unsaved with nothing in flight.
   */
  plantBug?: boolean;
}

export function createRootReducer(options: ReducerOptions = {}): Reducer<AppState> {
  const plantBug = options.plantBug ?? false;

  const todos = createReducer(initialState.todos, (builder) => {
    builder
      .addCase(added, (state, action) => {
        state.items.push({ id: `t${state.nextId}`, title: action.payload.title, done: false, rev: 1, syncedRev: 0 });
        state.nextId += 1;
      })
      .addCase(toggled, (state, action) => {
        const todo = state.items.find((item) => item.id === action.payload.id);
        if (!todo) return;
        todo.done = !todo.done;
        todo.rev += 1;
      })
      .addCase(renamed, (state, action) => {
        const todo = state.items.find((item) => item.id === action.payload.id);
        if (!todo) return;
        todo.title = action.payload.title;
        todo.rev += 1;
      })
      .addCase(saveAcked, (state, action) => {
        const todo = state.items.find((item) => item.id === action.payload.id);
        if (!todo) return;
        todo.syncedRev = plantBug ? action.payload.rev : Math.max(todo.syncedRev, action.payload.rev);
      });
  });

  const sync = createReducer(initialState.sync, (builder) => {
    builder
      .addCase(saveStarted, (state) => {
        state.inFlight += 1;
      })
      .addCase(saveAcked, (state) => {
        state.inFlight = Math.max(0, state.inFlight - 1);
      })
      .addCase(saveFailed, (state, action) => {
        state.inFlight = Math.max(0, state.inFlight - 1);
        state.lastError = `Saving ${action.payload.id} failed: ${action.payload.reason}`;
      });
  });

  return combineReducers({ todos, sync });
}
