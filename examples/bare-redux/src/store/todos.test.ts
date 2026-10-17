import type { Reducer, UnknownAction } from '@reduxjs/toolkit';
import { describe, expect, it } from 'vitest';
import { added, createRootReducer, initialState, renamed, saveAcked, saveFailed, saveStarted, toggled, type AppState } from './todos';

const run = (reducer: Reducer<AppState>, actions: UnknownAction[], from: AppState = initialState): AppState =>
  actions.reduce<AppState>((state, action) => reducer(state, action), from);

// Two saves of t1, acknowledged newest first: the reordering the sync API produces.
const reordered: UnknownAction[] = [
  added({ title: 'Buy milk' }),
  saveStarted({ id: 't1', rev: 1 }),
  toggled({ id: 't1' }),
  saveStarted({ id: 't1', rev: 2 }),
  saveAcked({ id: 't1', rev: 2 }),
  saveAcked({ id: 't1', rev: 1 }),
];

describe('the to-do reducer', () => {
  const reducer = createRootReducer();

  it('starts empty, with ids from t1 and nothing in flight', () => {
    expect(reducer(undefined, { type: '@@init' })).toEqual({ todos: { items: [], nextId: 1 }, sync: { inFlight: 0, lastError: null } });
  });

  it('adds to-dos at revision 1, unsynced, with sequential ids', () => {
    const state = run(reducer, [added({ title: 'Buy milk' }), added({ title: 'Call Sam' })]);
    expect(state.todos).toEqual({
      items: [
        { id: 't1', title: 'Buy milk', done: false, rev: 1, syncedRev: 0 },
        { id: 't2', title: 'Call Sam', done: false, rev: 1, syncedRev: 0 },
      ],
      nextId: 3,
    });
  });

  it('bumps the revision on every toggle and rename', () => {
    const state = run(reducer, [added({ title: 'Buy milk' }), toggled({ id: 't1' }), renamed({ id: 't1', title: 'Buy oat milk' }), toggled({ id: 't1' })]);
    expect(state.todos.items[0]).toEqual({ id: 't1', title: 'Buy oat milk', done: false, rev: 4, syncedRev: 0 });
  });

  it('ignores edits to an id it does not have', () => {
    const before = run(reducer, [added({ title: 'Buy milk' })]);
    expect(run(reducer, [toggled({ id: 't9' }), renamed({ id: 't9', title: 'x' })], before)).toEqual(before);
  });

  it('counts saves in flight and keeps the highest acknowledged revision when acknowledgements arrive out of order', () => {
    const state = run(reducer, reordered);
    expect(state.sync).toEqual({ inFlight: 0, lastError: null });
    expect(state.todos.items[0]).toMatchObject({ rev: 2, syncedRev: 2 });
  });

  it('with the planted bug, lets an older acknowledgement overwrite a newer one', () => {
    const state = run(createRootReducer({ plantBug: true }), reordered);
    expect(state.sync.inFlight).toBe(0);
    expect(state.todos.items[0]).toMatchObject({ rev: 2, syncedRev: 1 });
  });

  it('never counts below zero and ignores acknowledgements for unknown ids', () => {
    const state = run(reducer, [saveAcked({ id: 't7', rev: 3 }), saveFailed({ id: 't7', rev: 3, reason: 'offline' }), saveAcked({ id: 't7', rev: 4 })]);
    expect(state.sync.inFlight).toBe(0);
    expect(state.todos.items).toEqual([]);
  });

  it('records the last failure', () => {
    const state = run(reducer, [added({ title: 'Buy milk' }), saveStarted({ id: 't1', rev: 1 }), saveFailed({ id: 't1', rev: 1, reason: 'offline' })]);
    expect(state.sync).toEqual({ inFlight: 0, lastError: 'Saving t1 failed: offline' });
  });
});
