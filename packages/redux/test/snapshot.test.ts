import { isIronbirdError } from '@ironbird/core';
import { createTestTarget } from '@ironbird/testing';
import { describe, expect, it } from 'vitest';
import { todoApp } from './sample-app';

describe('@ironbird/redux snapshots through the headless target', () => {
  it('saves the root state, not the projection, and loads it back', async () => {
    const target = await createTestTarget({ headless: todoApp });
    try {
      await target.send('todos/add', { text: 'milk' });
      const saved = await target.client.rpc<{ rev: number; snapshot: unknown }>('snapshotSave');
      expect(saved.snapshot).toEqual({ todos: { items: [{ text: 'milk', done: false }] }, meta: { version: 1 } });
      await target.send('todos/add', { text: 'eggs' });
      const loaded = await target.client.rpc<{ rev: number; value: unknown }>('snapshotLoad', { snapshot: saved.snapshot });
      expect(loaded.value).toEqual({ items: [{ text: 'milk', done: false }] });
      expect(await target.state()).toEqual({ items: [{ text: 'milk', done: false }] });
      // Commands keep working from the loaded state.
      await target.send('todos/add', { text: 'bread' });
      expect(await target.state('items.1.text')).toBe('bread');
    } finally {
      await target.dispose();
    }
  });

  it('fails INVALID_SNAPSHOT for a snapshot the schema rejects and keeps the state', async () => {
    const target = await createTestTarget({ headless: todoApp });
    try {
      await target.send('todos/add', { text: 'milk' });
      const before = await target.state();
      const error = await target.client.rpc('snapshotLoad', { snapshot: { todos: { items: 'none' }, meta: { version: 1 } } }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(isIronbirdError(error) ? error.code : error).toBe('INVALID_SNAPSHOT');
      expect((error as { details: unknown }).details).toMatchObject({ path: 'todos.items' });
      expect(await target.state()).toEqual(before);
    } finally {
      await target.dispose();
    }
  });
});
