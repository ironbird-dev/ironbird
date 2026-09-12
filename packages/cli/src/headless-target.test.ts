import { createTarget, defineCommands, defineHeadless, isIronbirdError, markFakePort, type StepResult } from '@ironbird/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHeadlessTarget, type HeadlessTarget } from './headless-target';

interface State {
  count: number;
  status: 'idle' | 'loading' | 'done';
  junk?: unknown;
}

const definition = defineHeadless(({ clock, recorder, tracker, env }) => {
  let state: State = { count: 0, status: 'idle' };
  const listeners = new Set<() => void>();
  const set = (next: State): void => {
    state = next;
    listeners.forEach((l) => l());
  };
  const port = tracker.wrap(
    markFakePort({
      load: () =>
        new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            set({ ...state, status: 'done' });
            recorder.record('api', 'loaded');
            resolve();
          }, 500, 'api.load');
        }),
    }),
    'api',
  );
  const commands = defineCommands({
    'counter.add': z.object({ by: z.number().int() }),
    'data.load': z.object({}),
    'state.junk': z.object({}),
    'boom.now': z.object({}),
  });
  const target = createTarget({
    commands,
    dispatch: ({ name, payload }) => {
      if (name === 'counter.add') set({ ...state, count: state.count + (payload as { by: number }).by });
      if (name === 'data.load') {
        set({ ...state, status: 'loading' });
        void port.load();
      }
      if (name === 'state.junk') set({ ...state, junk: new Map() });
      if (name === 'boom.now') throw new Error(`boom ${env['WHO'] ?? ''}`.trim());
    },
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  });
  return { target };
});

let target: HeadlessTarget;
const logs: string[] = [];

afterEach(async () => {
  await target?.dispose();
  logs.length = 0;
});

async function boot(env: Record<string, string> = {}): Promise<HeadlessTarget> {
  target = await createHeadlessTarget({ definition, appId: 'com.example.test', clockStart: '2026-01-01T00:00:00.000Z', settleTimeoutMs: 500, env, log: (line) => logs.push(line) });
  return target;
}

describe('createHeadlessTarget', () => {
  it('describes the app with commands and capabilities', async () => {
    const t = await boot();
    const description = (await t.run('describe', {})) as { app: unknown; commands: Record<string, unknown>; capabilities: string[] };
    expect(description.app).toEqual({ id: 'com.example.test', platform: 'headless' });
    expect(Object.keys(description.commands)).toEqual(['counter.add', 'data.load', 'state.junk', 'boom.now']);
    expect(description.capabilities).toEqual(['settle', 'events', 'clock', 'reset']);
    expect(t.info()).toMatchObject({ id: 'headless', platform: 'headless', appId: 'com.example.test', rev: 0 });
  });

  it('dispatches, settles idle, and returns the state at a path with events from the step', async () => {
    const t = await boot();
    const result = (await t.run('dispatch', { name: 'counter.add', payload: { by: 2 }, path: 'count' })) as StepResult;
    expect(result).toMatchObject({ target: 'headless', rev: 1, path: 'count', state: 2, events: [] });
    expect(result.settle).toMatchObject({ idle: true, quiescent: false });
  });

  it('reports quiescence with the next manual timer, then completes after clockAdvance', async () => {
    const t = await boot();
    const loading = (await t.run('dispatch', { name: 'data.load' })) as StepResult;
    expect(loading.settle).toMatchObject({ idle: false, quiescent: true, nextTimerInMs: 500 });
    expect(loading.settle?.pending.map((p) => p.label)).toEqual(['api.load']);
    const advanced = (await t.run('clockAdvance', { ms: 500, path: 'status' })) as StepResult & { now: number };
    expect(advanced.state).toBe('done');
    expect(advanced.now).toBe(Date.parse('2026-01-01T00:00:00.500Z'));
    expect(advanced.events.map((e) => e.name)).toEqual(['loaded']);
    expect(advanced.settle?.idle).toBe(true);
    expect(await t.run('clockNow', {})).toEqual({ now: Date.parse('2026-01-01T00:00:00.500Z') });
  });

  it('waitFor resolves on a state change from a concurrent mutating op and never advances the clock', async () => {
    const t = await boot();
    const waiting = t.run('waitFor', { path: 'count', equals: 3, timeoutMs: 1_000 });
    await t.run('dispatch', { name: 'counter.add', payload: { by: 3 } });
    expect(await waiting).toMatchObject({ path: 'count', value: 3 });
    await t.run('dispatch', { name: 'data.load' });
    const error = await t.run('waitFor', { path: 'status', equals: 'done', timeoutMs: 50 }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('WAIT_TIMEOUT');
    expect(isIronbirdError(error) && (error.details as { value: unknown; pending: Array<{ label: string }> }).value).toBe('loading');
    expect(isIronbirdError(error) && (error.details as { pending: Array<{ label: string }> }).pending.map((p) => p.label)).toEqual(['api.load']);
    expect(await t.run('clockNow', {})).toEqual({ now: Date.parse('2026-01-01T00:00:00.000Z') });
  });

  it('serializes mutating ops in order and lets reads run alongside', async () => {
    const t = await boot();
    const order: string[] = [];
    const first = t.run('dispatch', { name: 'data.load' }).then(() => order.push('dispatch'));
    const read = t.run('getState', { path: 'status' }).then((value) => order.push(`read:${(value as { value: string }).value}`));
    const second = t.run('dispatch', { name: 'counter.add', payload: { by: 1 } }).then(() => order.push('add'));
    await Promise.all([first, read, second]);
    expect(order[0]).toMatch(/^read:/);
    expect(order.slice(1)).toEqual(['dispatch', 'add']);
  });

  it('returns UNSUPPORTED for operations the headless target lacks and wraps app throws', async () => {
    const t = await boot({ WHO: 'now' });
    const unsupported = await t.run('fakeControl', { fake: 'x', control: 'y' }).catch((caught: unknown) => caught);
    expect(isIronbirdError(unsupported) && unsupported.details).toEqual({ op: 'fakeControl', target: 'headless' });
    const failed = await t.run('dispatch', { name: 'boom.now' }).catch((caught: unknown) => caught);
    expect(isIronbirdError(failed) && failed.code).toBe('DISPATCH_FAILED');
    expect(isIronbirdError(failed) && failed.details).toEqual({ name: 'boom.now', message: 'boom now' });
  });

  it('replaces unserializable values, warns once per path, and events page with since', async () => {
    const t = await boot();
    await t.run('dispatch', { name: 'state.junk' });
    const state = (await t.run('getState', { path: 'junk' })) as { value: unknown };
    expect(state.value).toEqual({ $unserializable: 'Map' });
    await t.run('getState', { path: 'junk' });
    expect(logs.filter((line) => line.includes('UNSERIALIZABLE_STATE'))).toHaveLength(1);
    await t.run('dispatch', { name: 'data.load' });
    await t.run('clockAdvance', { ms: 500 });
    const events = (await t.run('events', { since: 0 })) as { events: Array<{ name: string }>; nextSeq: number };
    expect(events.events.map((e) => e.name)).toEqual(['loaded']);
    expect((await t.run('events', { since: events.nextSeq })) as object).toMatchObject({ events: [] });
  });

  it('reset recreates the app with a fresh clock and state', async () => {
    const t = await boot();
    await t.run('dispatch', { name: 'counter.add', payload: { by: 5 } });
    await t.run('clockAdvance', { ms: 100 });
    const after = (await t.run('reset', {})) as { rev: number; path: string; value: State };
    expect(after).toEqual({ rev: 0, path: '', value: { count: 0, status: 'idle' } });
    expect(await t.run('clockNow', {})).toEqual({ now: Date.parse('2026-01-01T00:00:00.000Z') });
  });

  it('emits event and state notifications', async () => {
    const t = await boot();
    const events: string[] = [];
    const revs: number[] = [];
    t.onEvent((event) => events.push(event.name));
    t.onState((rev) => revs.push(rev));
    await t.run('dispatch', { name: 'data.load' });
    await t.run('clockAdvance', { ms: 500 });
    expect(events).toEqual(['loaded']);
    expect(revs).toEqual([1, 2]);
  });
});
