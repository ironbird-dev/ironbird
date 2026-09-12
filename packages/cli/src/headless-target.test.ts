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

  it('describe lists wired fakes with their controls', async () => {
    const fakeControls = defineCommands({ emit: z.object({ event: z.string() }) });
    const withFake = defineHeadless(({ clock }) => {
      const target = createTarget({ commands: defineCommands({ 'x.go': z.object({}) }), dispatch: () => {}, getState: () => ({ now: clock.now() }) });
      const fake = { name: 'reader', description: 'Fake reader', port: {}, controls: fakeControls, control: async () => {}, calls: () => [] };
      return { target, fakes: [fake] };
    });
    const t = await createHeadlessTarget({ definition: withFake, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    const description = (await t.run('describe', {})) as { fakes: Record<string, { description?: string; controls: Record<string, unknown> }>; capabilities: string[] };
    expect(description.capabilities).toContain('fakes');
    expect(description.fakes['reader']?.description).toBe('Fake reader');
    expect(Object.keys(description.fakes['reader']?.controls ?? {})).toEqual(['emit']);
    await t.dispose();
  });

  it('rejects a malformed matches pattern with INVALID_PAYLOAD', async () => {
    const t = await boot();
    const error = await t.run('waitFor', { path: 'status', matches: '[', timeoutMs: 10 }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('INVALID_PAYLOAD');
  });

  it('keeps accepting mutating operations after one fails', async () => {
    const t = await boot({ WHO: 'now' });
    await expect(t.run('dispatch', { name: 'boom.now' })).rejects.toMatchObject({ code: 'DISPATCH_FAILED' });
    const result = (await t.run('dispatch', { name: 'counter.add', payload: { by: 1 }, path: 'count' })) as { state: number };
    expect(result.state).toBe(1);
  });

  it('reset recovers a target whose dispatch never settles', async () => {
    const stuck = defineHeadless(() => {
      let count = 0;
      const target = createTarget({
        commands: defineCommands({ 'hang.forever': z.object({}), 'count.add': z.object({}) }),
        dispatch: ({ name }) => {
          if (name === 'hang.forever') return new Promise<void>(() => {});
          count += 1;
        },
        getState: () => ({ count }),
      });
      return { target };
    });
    const t = await createHeadlessTarget({ definition: stuck, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    const hanging = t.run('dispatch', { name: 'hang.forever' });
    const queued = t.run('dispatch', { name: 'count.add' });
    const reset = await t.run('reset', {});
    expect(reset).toEqual({ rev: 0, path: '', value: { count: 0 } });
    const after = (await t.run('dispatch', { name: 'count.add', path: 'count' })) as { state: number };
    expect(after.state).toBe(1);
    void hanging;
    await expect(queued).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
    await t.dispose();
  });

  it('rejects queued and in-flight operations that a reset abandons', async () => {
    let release: (() => void) | undefined;
    const slow = defineHeadless(() => {
      let count = 0;
      const target = createTarget({
        commands: defineCommands({ 'slow.add': z.object({}), 'count.add': z.object({}) }),
        dispatch: ({ name }) => {
          if (name === 'slow.add')
            return new Promise<void>((resolve) => {
              release = () => {
                count += 1;
                resolve();
              };
            });
          count += 1;
        },
        getState: () => ({ count }),
      });
      return { target };
    });
    const t = await createHeadlessTarget({ definition: slow, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    const inFlight = t.run('dispatch', { name: 'slow.add' });
    const queued = t.run('dispatch', { name: 'count.add' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.run('reset', {});
    release?.();
    await expect(inFlight).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
    await expect(queued).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
    expect(await t.run('getState', { path: 'count' })).toMatchObject({ value: 0 });
    await t.dispose();
  });

  it('collapses concurrent resets and disposes every session exactly once', async () => {
    const disposed: number[] = [];
    let created = 0;
    const counted = defineHeadless(() => {
      const id = ++created;
      const target = createTarget({ commands: defineCommands({ 'x.go': z.object({}) }), dispatch: () => {}, getState: () => ({ id }) });
      return {
        target,
        dispose: () => {
          disposed.push(id);
        },
      };
    });
    const t = await createHeadlessTarget({ definition: counted, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    const [a, b] = await Promise.all([t.run('reset', {}), t.run('reset', {})]);
    expect(a).toEqual(b);
    expect(created).toBe(2);
    expect(disposed).toEqual([1]);
    await t.dispose();
    expect(disposed).toEqual([1, 2]);
    await expect(t.run('reset', {})).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
