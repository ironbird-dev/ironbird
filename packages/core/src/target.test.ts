import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { IronbirdError, isIronbirdError } from './errors';
import { defineCommands } from './registry';
import { createTarget } from './target';

const commands = defineCommands({
  'counter.add': z.object({ by: z.number().int() }),
  'counter.explode': z.object({}),
});

function makeStore() {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    add: (by: number) => {
      value += by;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe('createTarget', () => {
  it('validates, dispatches the parsed payload, and exposes state', async () => {
    const store = makeStore();
    const dispatch = vi.fn(({ name, payload }: { name: string; payload: { by?: number } }) => {
      if (name === 'counter.add') store.add(payload.by ?? 0);
    });
    const target = createTarget({ commands, dispatch, getState: () => ({ value: store.get() }) });
    await target.dispatch('counter.add', { by: 2 });
    expect(dispatch).toHaveBeenCalledWith({ name: 'counter.add', payload: { by: 2 } });
    expect(target.getState()).toEqual({ value: 2 });
    expect(target.capabilities).toEqual([]);
  });

  it('rejects invalid payloads before calling dispatch and leaves the revision unchanged', async () => {
    const dispatch = vi.fn();
    const target = createTarget({ commands, dispatch, getState: () => 0 });
    const error = await target.dispatch('counter.add', { by: 1.5 }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('INVALID_PAYLOAD');
    expect(dispatch).not.toHaveBeenCalled();
    expect(target.revision()).toBe(0);
    const unknown = await target.dispatch('nope').catch((caught: unknown) => caught);
    expect(isIronbirdError(unknown) && unknown.code).toBe('UNKNOWN_COMMAND');
  });

  it('wraps app throws and rejections as DISPATCH_FAILED', async () => {
    const target = createTarget({
      commands,
      dispatch: async ({ name }) => {
        if (name === 'counter.explode') throw new Error('kaboom');
      },
      getState: () => 0,
    });
    const error = await target.dispatch('counter.explode').catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('DISPATCH_FAILED');
    expect(isIronbirdError(error) && error.details).toEqual({ name: 'counter.explode', message: 'kaboom' });
    expect(isIronbirdError(error) && error.message).toContain('kaboom');
  });

  it('increments the revision on every subscribe notification when subscribe is provided', async () => {
    const store = makeStore();
    const target = createTarget({
      commands,
      dispatch: ({ name, payload }) => {
        if (name === 'counter.add') {
          store.add(payload.by);
          store.add(0);
        }
      },
      getState: () => store.get(),
      subscribe: store.subscribe,
    });
    const seen: number[] = [];
    target.subscribe(() => seen.push(target.revision()));
    await target.dispatch('counter.add', { by: 1 });
    expect(target.revision()).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  it('increments the revision once per dispatch when subscribe is absent', async () => {
    const target = createTarget({ commands, dispatch: () => {}, getState: () => 0 });
    await target.dispatch('counter.add', { by: 1 });
    await target.dispatch('counter.add', { by: 1 });
    expect(target.revision()).toBe(2);
  });

  it('exposes persist and restore only when the definition provides them', async () => {
    let value = 1;
    const target = createTarget({
      commands,
      dispatch: () => {},
      getState: () => value,
      persist: () => ({ value }),
      restore: (snapshot) => {
        value = (snapshot as { value: number }).value;
      },
    });
    expect(target.capabilities).toEqual(['persist', 'restore']);
    expect(target.persist?.()).toEqual({ value: 1 });
    await target.restore?.({ value: 9 });
    expect(target.getState()).toBe(9);
    expect(target.revision()).toBe(1);
  });

  it('reports a plain error from persist or restore as INVALID_SNAPSHOT and passes IronbirdErrors through', async () => {
    let restoreError: unknown = new Error('bad shape');
    const target = createTarget({
      commands,
      dispatch: () => {},
      getState: () => 0,
      persist: () => {
        throw new Error('disk gone');
      },
      restore: () => {
        throw restoreError;
      },
    });
    let saved: unknown;
    try {
      target.persist?.();
    } catch (error) {
      saved = error;
    }
    expect(saved).toMatchObject({ code: 'INVALID_SNAPSHOT', message: 'Snapshot could not be saved: disk gone', details: { path: '', reason: 'disk gone' } });
    expect(await target.restore?.({}).catch((error: unknown) => error)).toMatchObject({
      code: 'INVALID_SNAPSHOT',
      message: 'Snapshot could not be restored: bad shape',
      details: { path: '', reason: 'bad shape' },
    });
    restoreError = new IronbirdError('INVALID_SNAPSHOT', 'Invalid snapshot at todos.0', { path: 'todos.0', reason: 'Expected string' });
    expect(await target.restore?.({}).catch((error: unknown) => error)).toBe(restoreError);
    expect(target.revision()).toBe(0);
  });

  it('classifies a thrown value that cannot be printed as INVALID_SNAPSHOT', async () => {
    const hostile = {
      toString: () => {
        throw new Error('no string');
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const thrown: unknown[] = [Object.create(null), Symbol('boom'), hostile, revoked.proxy, undefined, null];
    for (const value of thrown) {
      const target = createTarget({
        commands,
        dispatch: () => {},
        getState: () => 0,
        persist: () => {
          throw value;
        },
        restore: () => {
          throw value;
        },
      });
      let saved: unknown;
      try {
        target.persist?.();
      } catch (error) {
        saved = error;
      }
      expect(saved).toBeInstanceOf(IronbirdError);
      expect(saved).toMatchObject({ code: 'INVALID_SNAPSHOT', details: { path: '' } });
      const restored = await target.restore?.({}).catch((error: unknown) => error);
      expect(restored).toBeInstanceOf(IronbirdError);
      expect(restored).toMatchObject({ code: 'INVALID_SNAPSHOT', details: { path: '' } });
    }
    const bare = Object.create(null) as object;
    const unprintable = createTarget({ commands, dispatch: () => {}, getState: () => 0, persist: () => { throw bare; } });
    expect(() => unprintable.persist?.()).toThrow('Snapshot could not be saved: [unprintable error]');
  });
});

describe('listener isolation', () => {
  it('a throwing subscriber does not stop later subscribers or fail the dispatch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const commands = defineCommands({ 'n.set': z.object({ value: z.number() }) });
    let state = 0;
    const target = createTarget({ commands, dispatch: ({ payload }) => void (state = payload.value), getState: () => state });
    const seen: number[] = [];
    target.subscribe(() => {
      throw new Error('subscriber broke');
    });
    target.subscribe(() => seen.push(target.revision()));
    await expect(target.dispatch('n.set', { value: 3 })).resolves.toBeUndefined();
    expect(seen).toEqual([1]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('subscriber broke'));
    warn.mockRestore();
  });
});
