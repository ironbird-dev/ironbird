import { isIronbirdError, type IronbirdError } from '@ironbird/core';
import { describe, expect, it, vi } from 'vitest';
import { SAVED, storeCommands, todos, wrappedStore } from '../test/todo-store';
import { fromStore } from './from-store';
import { RESTORE_ACTION_TYPE } from './restore';

async function failure(promise: Promise<unknown>): Promise<IronbirdError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return error;
}

describe('fromStore', () => {
  it('validates, then dispatches { type: name, payload } by default, which Redux Toolkit slices accept', async () => {
    const store = wrappedStore();
    const target = fromStore(store, { commands: storeCommands });
    await target.dispatch('todos/add', { text: 'milk' });
    expect(store.getState().todos.items).toEqual([{ text: 'milk', done: false }]);
  });

  it('rejects an invalid payload and an unknown command before the store sees them', async () => {
    const store = wrappedStore();
    const before = store.getState();
    const target = fromStore(store, { commands: storeCommands });
    expect((await failure(target.dispatch('todos/add', { text: '' }))).code).toBe('INVALID_PAYLOAD');
    expect((await failure(target.dispatch('todos/remove', {}))).code).toBe('UNKNOWN_COMMAND');
    expect(store.getState()).toBe(before);
  });

  it('uses toAction when given', async () => {
    const store = wrappedStore();
    const toAction = vi.fn((command: { name: string; payload: unknown }) => todos.actions.add({ text: `custom ${command.name}` }));
    const target = fromStore(store, { commands: storeCommands, toAction });
    await target.dispatch('todos/noop');
    expect(toAction).toHaveBeenCalledWith({ name: 'todos/noop', payload: {} });
    expect(store.getState().todos.items).toEqual([{ text: 'custom todos/noop', done: false }]);
  });

  it('refuses a command that maps to the restore action, so no command bypasses the snapshot schema', async () => {
    const store = wrappedStore();
    const before = store.getState();
    const target = fromStore(store, { commands: storeCommands, toAction: () => ({ type: RESTORE_ACTION_TYPE, payload: SAVED }) });
    const error = await failure(target.dispatch('todos/noop'));
    expect(error.code).toBe('DISPATCH_FAILED');
    expect(error.message).toContain(RESTORE_ACTION_TYPE);
    expect(store.getState()).toBe(before);
  });

  it('shows the whole state by default and the projection with select', () => {
    const store = wrappedStore();
    expect(fromStore(store, { commands: storeCommands }).getState()).toEqual({ todos: { items: [] }, meta: { version: 1 } });
    expect(fromStore(store, { commands: storeCommands, select: (state) => state.todos }).getState()).toEqual({ items: [] });
  });

  it('moves the revision and notifies only when the state changes', async () => {
    const store = wrappedStore();
    const target = fromStore(store, { commands: storeCommands });
    const listener = vi.fn();
    target.subscribe(listener);
    await target.dispatch('todos/add', { text: 'milk' });
    expect(target.revision()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    // Redux notifies its subscribers for these dispatches too, but the state didn't change.
    await target.dispatch('todos/noop');
    await target.dispatch('todos/toggle', { index: 5 });
    expect(target.revision()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    // A change made outside ironbird counts too: the target watches the store, not its own dispatches.
    store.dispatch(todos.actions.toggle({ index: 0 }));
    expect(target.revision()).toBe(2);
  });

  it('persists the root state even with a select projection', async () => {
    const store = wrappedStore();
    const target = fromStore(store, { commands: storeCommands, select: (state) => state.todos.items.length });
    await target.dispatch('todos/add', { text: 'milk' });
    expect(target.getState()).toBe(1);
    expect(target.persist?.()).toBe(store.getState());
    expect(target.persist?.()).toEqual({ todos: { items: [{ text: 'milk', done: false }] }, meta: { version: 1 } });
  });

  it('offers persist but not restore without the restore option', () => {
    const target = fromStore(wrappedStore(), { commands: storeCommands });
    expect(target.capabilities).toEqual(['persist']);
    expect(target.restore).toBeUndefined();
  });
});
