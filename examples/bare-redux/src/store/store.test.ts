import { createManualClock } from '@ironbird/core';
import type { Reducer } from '@reduxjs/toolkit';
import { describe, expect, it } from 'vitest';
import type { SavedTodo, SyncAck, SyncPort } from '../sync/port';
import { SLOW_ACK_MS, createSimulatedServer } from '../sync/server';
import { createAppStore } from './store';
import { added, renamed, toggled, type AppState } from './todos';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A sync port whose saves the test acknowledges or fails by hand, by save index. */
function manualSync() {
  const saves: SavedTodo[] = [];
  const pending: Array<{ todo: SavedTodo; resolve: (ack: SyncAck) => void; reject: (error: Error) => void }> = [];
  const port: SyncPort = {
    save: (todo) => {
      saves.push(todo);
      return new Promise((resolve, reject) => {
        pending.push({ todo, resolve, reject });
      });
    },
  };
  const at = (index: number) => {
    const entry = pending[index];
    if (!entry) throw new Error(`No save #${index}`);
    return entry;
  };
  return {
    port,
    saves,
    ack: (index: number): void => {
      const { todo, resolve } = at(index);
      resolve({ id: todo.id, rev: todo.rev });
    },
    fail: (index: number, reason: string): void => at(index).reject(new Error(reason)),
  };
}

describe('the app store', () => {
  it('saves a new to-do and marks it saved when the acknowledgement arrives', async () => {
    const sync = manualSync();
    const store = createAppStore({ sync: sync.port });
    store.dispatch(added({ title: 'Buy milk' }));
    expect(sync.saves).toEqual([{ id: 't1', title: 'Buy milk', done: false, rev: 1 }]);
    expect(store.getState().sync.inFlight).toBe(1);

    sync.ack(0);
    await flush();
    expect(store.getState().sync.inFlight).toBe(0);
    expect(store.getState().todos.items[0]).toMatchObject({ rev: 1, syncedRev: 1 });
  });

  it('saves every edit at its new revision', () => {
    const sync = manualSync();
    const store = createAppStore({ sync: sync.port });
    store.dispatch(added({ title: 'Buy milk' }));
    store.dispatch(toggled({ id: 't1' }));
    store.dispatch(renamed({ id: 't1', title: 'Buy oat milk' }));
    expect(sync.saves.map((todo) => [todo.rev, todo.done, todo.title])).toEqual([
      [1, false, 'Buy milk'],
      [2, true, 'Buy milk'],
      [3, true, 'Buy oat milk'],
    ]);
    expect(store.getState().sync.inFlight).toBe(3);
  });

  it('throws on an edit to a missing to-do and changes nothing', () => {
    const sync = manualSync();
    const store = createAppStore({ sync: sync.port });
    store.dispatch(added({ title: 'Buy milk' }));
    const before = store.getState();
    expect(() => store.dispatch(toggled({ id: 't9' }))).toThrow('No to-do with id t9');
    expect(() => store.dispatch(renamed({ id: 't9', title: 'x' }))).toThrow('No to-do with id t9');
    expect(store.getState()).toBe(before);
    expect(sync.saves).toHaveLength(1);
  });

  it('records a failed save and stops counting it', async () => {
    const sync = manualSync();
    const store = createAppStore({ sync: sync.port });
    store.dispatch(added({ title: 'Buy milk' }));
    sync.fail(0, 'offline');
    await flush();
    expect(store.getState().sync).toEqual({ inFlight: 0, lastError: 'Saving t1 failed: offline' });
    expect(store.getState().todos.items[0]).toMatchObject({ rev: 1, syncedRev: 0 });
  });

  it('ends saved at the latest revision when the simulated server acknowledges a quick edit first', async () => {
    const clock = createManualClock();
    const store = createAppStore({ sync: createSimulatedServer(clock) });
    store.dispatch(added({ title: 'Buy milk' }));
    store.dispatch(toggled({ id: 't1' }));
    await clock.advance(SLOW_ACK_MS);
    await flush();
    expect(store.getState().sync.inFlight).toBe(0);
    expect(store.getState().todos.items[0]).toMatchObject({ rev: 2, syncedRev: 2 });
  });

  it('with the planted bug, ends unsaved with nothing in flight after the same reordering', async () => {
    const clock = createManualClock();
    const store = createAppStore({ sync: createSimulatedServer(clock) }, { plantBug: true });
    store.dispatch(added({ title: 'Buy milk' }));
    store.dispatch(toggled({ id: 't1' }));
    await clock.advance(SLOW_ACK_MS);
    await flush();
    expect(store.getState().sync.inFlight).toBe(0);
    expect(store.getState().todos.items[0]).toMatchObject({ rev: 2, syncedRev: 1 });
  });

  it('wraps the root reducer when asked', () => {
    const seen: string[] = [];
    const wrap = (reducer: Reducer<AppState>): Reducer<AppState> => (state, action) => {
      seen.push(action.type);
      return reducer(state, action);
    };
    const store = createAppStore({ sync: manualSync().port }, { wrapReducer: wrap });
    store.dispatch(added({ title: 'Buy milk' }));
    expect(seen).toContain('todos/added');
    expect(seen).toContain('sync/saveStarted');
  });
});
