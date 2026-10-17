import { isIronbirdError, type IronbirdError } from '@ironbird/core';
import { describe, expect, it, vi } from 'vitest';
import { SAVED, plainStore, rootSchema, storeCommands, wrappedStore } from '../test/todo-store';
import { fromStore } from './from-store';

async function failure(promise: Promise<unknown>): Promise<IronbirdError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return error;
}

describe('fromStore restore', () => {
  it('is offered only with the restore option', () => {
    const target = fromStore(wrappedStore(), { commands: storeCommands, restore: { schema: rootSchema } });
    expect(target.capabilities).toEqual(['persist', 'restore']);
    expect(typeof target.restore).toBe('function');
  });

  it('replaces the root state with the parsed snapshot and moves the revision once', async () => {
    const store = wrappedStore();
    const target = fromStore(store, { commands: storeCommands, select: (state) => state.todos, restore: { schema: rootSchema } });
    await target.dispatch('todos/add', { text: 'eggs' });
    const listener = vi.fn();
    target.subscribe(listener);
    const rev = target.revision();
    await target.restore?.(structuredClone(SAVED));
    expect(store.getState()).toEqual(SAVED);
    expect(target.getState()).toEqual(SAVED.todos);
    expect(target.revision()).toBe(rev + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    // The store keeps working from the restored state.
    await target.dispatch('todos/add', { text: 'bread' });
    expect(store.getState().todos.items.map((item) => item.text)).toEqual(['milk', 'bread']);
  });

  it('fails INVALID_SNAPSHOT at the first bad path and leaves the store untouched', async () => {
    const store = wrappedStore();
    const target = fromStore(store, { commands: storeCommands, restore: { schema: rootSchema } });
    await target.dispatch('todos/add', { text: 'eggs' });
    const before = store.getState();
    const rev = target.revision();
    const error = await failure(target.restore!({ todos: { items: [{ text: '', done: false }] }, meta: { version: 1 } }));
    expect(error.code).toBe('INVALID_SNAPSHOT');
    expect(error.details).toMatchObject({ path: 'todos.items.0.text' });
    expect(typeof (error.details as { reason: unknown }).reason).toBe('string');
    expect(store.getState()).toBe(before);
    expect(target.revision()).toBe(rev);
  });

  it('fails INVALID_SNAPSHOT at the root for a snapshot that is not an object', async () => {
    const target = fromStore(wrappedStore(), { commands: storeCommands, restore: { schema: rootSchema } });
    const error = await failure(target.restore!('not a state'));
    expect(error.code).toBe('INVALID_SNAPSHOT');
    expect(error.details).toMatchObject({ path: '' });
  });

  it('fails INVALID_SNAPSHOT when the root reducer is not wrapped, and the state stays', async () => {
    const store = plainStore();
    const target = fromStore(store, { commands: storeCommands, restore: { schema: rootSchema } });
    const before = store.getState();
    const error = await failure(target.restore!(structuredClone(SAVED)));
    expect(error.code).toBe('INVALID_SNAPSHOT');
    expect(error.details).toEqual({ path: '', reason: 'the root reducer is not wrapped with withIronbirdRestore' });
    expect(store.getState()).toBe(before);
  });
});
