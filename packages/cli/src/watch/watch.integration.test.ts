import { IronbirdError, createTarget, defineCommands, defineHeadless } from '@ironbird/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDaemonClient, type CallOptions, type DaemonClient } from '../cli/client';
import { startDaemon } from '../daemon';
import type { DaemonTarget } from '../daemon-target';
import { createHeadlessTarget } from '../headless-target';
import { runWatch } from './watch';

// Spec §11's watch boundaries, against a real daemon and headless target in process.

interface WatchState {
  count: number;
  extra?: { note: string };
}

const watchApp = defineHeadless(() => {
  let state: WatchState = { count: 0 };
  const listeners = new Set<() => void>();
  const set = (next: WatchState): void => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const commands = defineCommands({
    'count.add': z.object({ by: z.number().int() }),
    'extra.set': z.object({ note: z.string() }),
    'extra.clear': z.object({}),
  });
  const target = createTarget({
    commands,
    dispatch: ({ name, payload }) => {
      if (name === 'count.add') set({ ...state, count: state.count + (payload as { by: number }).by });
      if (name === 'extra.set') set({ ...state, extra: { note: (payload as { note: string }).note } });
      if (name === 'extra.clear') set({ count: state.count });
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return { target };
});

interface Line {
  rev?: number;
  patch?: unknown[];
  error?: { code: string };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function session(): Promise<{ client: DaemonClient; send(name: string, payload?: unknown): Promise<unknown> }> {
  const target = await createHeadlessTarget({ definition: watchApp, appId: 'com.example.watch', settleTimeoutMs: 500, env: {}, log: () => {} });
  const daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', log: () => {} });
  cleanups.push(async () => {
    await daemon.close();
    await target.dispose();
  });
  const client = createDaemonClient({ url: daemon.url });
  return { client, send: (name, payload = {}) => client.rpc('dispatch', { name, payload, settle: false }) };
}

function start(client: DaemonClient, path = ''): { lines: Line[]; controller: AbortController; done: Promise<number> } {
  const lines: Line[] = [];
  const controller = new AbortController();
  const done = runWatch({ client, target: undefined, path, signal: controller.signal, write: (line) => lines.push(JSON.parse(line) as Line) });
  cleanups.push(async () => {
    controller.abort();
    await done.catch(() => undefined);
  });
  return { lines, controller, done };
}

/**
 * Wraps a client so a test can act inside the watcher's reads and see the state frames it
 * receives: `beforeRead(n)` runs before the n-th getState reaches the daemon, `afterRead(n)` after
 * its result is back but before the watcher sees it.
 */
function observed(client: DaemonClient, hooks: { beforeRead?: (n: number) => Promise<void>; afterRead?: (n: number) => Promise<void> }): { client: DaemonClient; revs: number[] } {
  const revs: number[] = [];
  let reads = 0;
  const wrapped: DaemonClient = {
    url: client.url,
    async call<T>(op: string, params?: Record<string, unknown>, target?: string, options?: CallOptions): Promise<{ target?: string; result: T }> {
      if (op !== 'getState') return client.call<T>(op, params, target, options);
      reads += 1;
      const n = reads;
      await hooks.beforeRead?.(n);
      const result = await client.call<T>(op, params, target, options);
      await hooks.afterRead?.(n);
      return result;
    },
    rpc: <T>(op: string, params?: Record<string, unknown>, target?: string, options?: CallOptions): Promise<T> => client.rpc<T>(op, params, target, options),
    stream: (options) =>
      client.stream({
        ...options,
        onMessage: (kind, data) => {
          if (kind === 'state') revs.push((data as { rev: number }).rev);
          options.onMessage(kind, data);
        },
      }),
  };
  return { client: wrapped, revs };
}

async function until(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
}

/** Longer than the daemon's 100 ms state throttle, so any frame still owed has arrived. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

const add = (value: unknown) => [{ op: 'add', path: '', value }];
const count = (value: number) => [{ op: 'replace', path: '/count', value }];

describe('watch against a daemon', () => {
  it('shows a change made before the stream opened in the first line', async () => {
    const s = await session();
    await s.send('count.add', { by: 2 });
    const w = start(s.client);
    await until(() => w.lines.length === 1, 'the first line');
    expect(w.lines).toEqual([{ rev: 1, patch: add({ count: 2 }) }]);
    await quiet();
    expect(w.lines).toHaveLength(1);
  });

  it('shows a change made between the barrier and the first read', async () => {
    const s = await session();
    const o = observed(s.client, {
      beforeRead: async (n) => {
        if (n === 1) await s.send('count.add', { by: 1 });
      },
    });
    const w = start(o.client);
    await until(() => w.lines.length === 1, 'the first line');
    expect(o.revs[0]).toBe(0);
    expect(w.lines).toEqual([{ rev: 1, patch: add({ count: 1 }) }]);
    await quiet();
    expect(w.lines).toHaveLength(1);
  });

  it('reads again after a change made during the first read', async () => {
    const s = await session();
    const o = observed(s.client, {
      afterRead: async (n) => {
        if (n !== 1) return;
        await s.send('count.add', { by: 1 });
        await until(() => o.revs.includes(1), 'the change frame during the read');
      },
    });
    const w = start(o.client);
    await until(() => w.lines.length === 2, 'both lines');
    expect(w.lines).toEqual([
      { rev: 0, patch: add({ count: 0 }) },
      { rev: 1, patch: count(1) },
    ]);
    await quiet();
    expect(w.lines).toHaveLength(2);
  });

  it('reads again after a change made during a slow later read', async () => {
    const s = await session();
    const o = observed(s.client, {
      afterRead: async (n) => {
        if (n !== 2) return;
        await s.send('count.add', { by: 1 });
        await until(() => o.revs.includes(2), 'the second change frame during the read');
      },
    });
    const w = start(o.client);
    await until(() => w.lines.length === 1, 'the first line');
    await s.send('count.add', { by: 1 });
    await until(() => w.lines.length === 3, 'both changes');
    expect(w.lines).toEqual([
      { rev: 0, patch: add({ count: 0 }) },
      { rev: 1, patch: count(1) },
      { rev: 2, patch: count(2) },
    ]);
  });

  it('follows a reset that moves the revision backwards', async () => {
    const s = await session();
    const w = start(s.client);
    await until(() => w.lines.length === 1, 'the first line');
    for (let i = 0; i < 3; i += 1) await s.send('count.add', { by: 1 });
    await until(() => w.lines.at(-1)?.rev === 3, 'revision 3');
    const before = w.lines.length;
    await s.client.rpc('reset');
    await until(() => w.lines.length > before, 'the reset');
    expect(w.lines.at(-1)).toEqual({ rev: 0, patch: count(0) });
  });

  it('watches one path: [] while missing, add when it appears, nothing for changes elsewhere, remove when it disappears', async () => {
    const s = await session();
    const w = start(s.client, 'extra');
    await until(() => w.lines.length === 1, 'the first line');
    expect(w.lines).toEqual([{ rev: 0, patch: [] }]);
    await s.send('extra.set', { note: 'a' });
    await until(() => w.lines.length === 2, 'the path to appear');
    expect(w.lines[1]).toEqual({ rev: 1, patch: add({ note: 'a' }) });
    await s.send('count.add', { by: 1 });
    await quiet();
    expect(w.lines).toHaveLength(2);
    await s.send('extra.clear');
    await until(() => w.lines.length === 3, 'the path to disappear');
    expect(w.lines[2]).toEqual({ rev: 3, patch: [{ op: 'remove', path: '' }] });
  });

  it('ends with exit 0 when interrupted and prints nothing after', async () => {
    const s = await session();
    const w = start(s.client);
    await until(() => w.lines.length === 1, 'the first line');
    w.controller.abort();
    expect(await w.done).toBe(0);
    await s.send('count.add', { by: 1 });
    await quiet();
    expect(w.lines).toHaveLength(1);
  });

  it('ends on the daemon error frame with its exit code', async () => {
    let eventsCalls = 0;
    const flaky: DaemonTarget = {
      id: 'stub',
      info: () => ({ id: 'stub', platform: 'headless', appId: 'com.example.watch', connectedAt: 0, rev: 0 }),
      async run(op) {
        if (op === 'events') {
          eventsCalls += 1;
          // The watcher's own cursor read succeeds; the stream's backlog read finds the target gone.
          if (eventsCalls === 1) return { events: [], nextSeq: 0, truncated: false };
          throw new IronbirdError('TARGET_DISCONNECTED', 'Target stub disconnected', { target: 'stub', op: 'events' });
        }
        return { rev: 0, path: '', value: {} };
      },
      onEvent: () => () => {},
      onState: () => () => {},
      dispose: async () => {},
    };
    const daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', targets: [flaky], defaultTarget: 'stub', log: () => {} });
    cleanups.push(() => daemon.close());
    const w = start(createDaemonClient({ url: daemon.url }));
    expect(await w.done).toBe(1);
    expect(w.lines).toEqual([{ error: { code: 'TARGET_DISCONNECTED', message: 'Target stub disconnected', details: { target: 'stub', op: 'events' } } }]);
  });
});
