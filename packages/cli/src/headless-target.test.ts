import { createTarget, defineCommands, defineHeadless, isIronbirdError, markFakePort, type HeadlessDefinition, type StepResult } from '@ironbird/core';
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

// Custom definitions boot through here too, so `afterEach` always owns disposal. `dispose` is
// idempotent, so a test may still dispose explicitly to assert on what disposal does.
async function bootWith(custom: HeadlessDefinition): Promise<HeadlessTarget> {
  target = await createHeadlessTarget({ definition: custom, appId: 'a', settleTimeoutMs: 100, env: {}, log: (line) => logs.push(line) });
  return target;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
      const app = createTarget({ commands: defineCommands({ 'x.go': z.object({}) }), dispatch: () => {}, getState: () => ({ now: clock.now() }) });
      const fake = { name: 'reader', description: 'Fake reader', port: {}, controls: fakeControls, control: async () => {}, calls: () => [] };
      return { target: app, fakes: [fake] };
    });
    const t = await bootWith(withFake);
    const description = (await t.run('describe', {})) as { fakes: Record<string, { description?: string; controls: Record<string, unknown> }>; capabilities: string[] };
    expect(description.capabilities).toContain('fakes');
    expect(description.fakes['reader']?.description).toBe('Fake reader');
    expect(Object.keys(description.fakes['reader']?.controls ?? {})).toEqual(['emit']);
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
      const app = createTarget({
        commands: defineCommands({ 'hang.forever': z.object({}), 'count.add': z.object({}) }),
        dispatch: ({ name }) => {
          if (name === 'hang.forever') return new Promise<void>(() => {});
          count += 1;
        },
        getState: () => ({ count }),
      });
      return { target: app };
    });
    const t = await bootWith(stuck);
    const hanging = t.run('dispatch', { name: 'hang.forever' });
    const queued = t.run('dispatch', { name: 'count.add' });
    // Let the wedged dispatch reach the app, so it is in flight rather than still in the queue.
    await tick();
    const reset = await t.run('reset', {});
    expect(reset).toEqual({ rev: 0, path: '', value: { count: 0 } });
    await expect(hanging).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
    const after = (await t.run('dispatch', { name: 'count.add', path: 'count' })) as { state: number };
    expect(after.state).toBe(1);
    await expect(queued).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
  });

  it('rejects queued and in-flight operations that a reset abandons', async () => {
    let release: (() => void) | undefined;
    const slow = defineHeadless(() => {
      let count = 0;
      const app = createTarget({
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
      return { target: app };
    });
    const t = await bootWith(slow);
    const inFlight = t.run('dispatch', { name: 'slow.add' });
    const queued = t.run('dispatch', { name: 'count.add' });
    await tick();
    await t.run('reset', {});
    release?.();
    await expect(inFlight).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
    await expect(queued).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
    expect(await t.run('getState', { path: 'count' })).toMatchObject({ value: 0 });
  });

  it('collapses concurrent resets and disposes every session exactly once', async () => {
    const disposed: number[] = [];
    let created = 0;
    const counted = defineHeadless(() => {
      const id = ++created;
      const app = createTarget({ commands: defineCommands({ 'x.go': z.object({}) }), dispatch: () => {}, getState: () => ({ id }) });
      return {
        target: app,
        dispose: () => {
          disposed.push(id);
        },
      };
    });
    const t = await bootWith(counted);
    const [a, b] = await Promise.all([t.run('reset', {}), t.run('reset', {})]);
    expect(a).toEqual(b);
    expect(created).toBe(2);
    expect(disposed).toEqual([1]);
    await t.dispose();
    expect(disposed).toEqual([1, 2]);
    await expect(t.run('reset', {})).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('fails an in-flight step that finishes during the reset window and leaves the new session untouched', async () => {
    let created = 0;
    let releaseDispatch: (() => void) | undefined;
    let releaseBoot: (() => void) | undefined;
    const slow = defineHeadless(async () => {
      created += 1;
      // The second boot parks inside definition.create, so the abandoned dispatch settles while
      // the target has no session at all.
      if (created === 2) await new Promise<void>((resolve) => (releaseBoot = resolve));
      let state: { count: number; junk?: unknown } = { count: 0 };
      const listeners = new Set<() => void>();
      const set = (next: typeof state): void => {
        state = next;
        listeners.forEach((l) => l());
      };
      const app = createTarget({
        commands: defineCommands({ 'slow.add': z.object({}), 'make.junk': z.object({}) }),
        dispatch: ({ name }) => {
          if (name === 'make.junk') {
            set({ ...state, junk: new Map() });
            return;
          }
          return new Promise<void>((resolve) => {
            releaseDispatch = () => {
              set({ ...state, count: state.count + 1 });
              resolve();
            };
          });
        },
        getState: () => state,
        subscribe: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      });
      return { target: app };
    });
    const t = await bootWith(slow);
    await t.run('dispatch', { name: 'make.junk' });
    expect(logs.filter((line) => line.includes('UNSERIALIZABLE_STATE'))).toHaveLength(1);
    const inFlight = t.run('dispatch', { name: 'slow.add' });
    // Reset now abandons this in-flight step immediately rather than waiting for it to settle, so
    // it rejects well before the `.rejects` assertion below attaches its handler; a plain `.catch`
    // here keeps Node from flagging the gap as an unhandled rejection.
    inFlight.catch(() => undefined);
    await tick();
    const loggedBeforeReset = logs.length;
    const resetting = t.run('reset', {});
    await tick();
    releaseDispatch?.();
    await expect(inFlight).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
    releaseBoot?.();
    expect(await resetting).toEqual({ rev: 0, path: '', value: { count: 0 } });
    expect(await t.run('getState', {})).toMatchObject({ rev: 0, value: { count: 0 } });
    // The abandoned step never read the dead session, so its `junk` warning never reappeared
    // even though `reset` cleared the warned-path set.
    expect(logs).toHaveLength(loggedBeforeReset);
  });

  it('does not resolve a waitFor issued before a reset against the new session', async () => {
    const t = await boot();
    await t.run('dispatch', { name: 'data.load' });
    const startedAt = Date.now();
    const waiting = t.run('waitFor', { path: 'status', equals: 'idle', timeoutMs: 2_000 });
    await t.run('reset', {});
    const error = await waiting.catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('TARGET_DISCONNECTED');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await t.run('getState', { path: 'status' })).toMatchObject({ value: 'idle' });
  });

  it('fails a settle spanning a reset with TARGET_DISCONNECTED', async () => {
    const releases: Array<() => void> = [];
    const busy = defineHeadless(({ tracker }) => {
      const app = createTarget({ commands: defineCommands({ 'x.go': z.object({}) }), dispatch: () => {}, getState: () => ({}) });
      void tracker.track(new Promise<void>((resolve) => releases.push(resolve)), 'real.work');
      return { target: app };
    });
    const t = await bootWith(busy);
    const settling = t.run('settle', { timeoutMs: 2_000 });
    await tick();
    await t.run('reset', {});
    releases[0]?.();
    const error = await settling.catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('TARGET_DISCONNECTED');
  });

  it('dispose rejects pending operations, is idempotent, and disposes every session once', async () => {
    const disposed: number[] = [];
    let created = 0;
    const stuck = defineHeadless(() => {
      const id = ++created;
      const app = createTarget({
        commands: defineCommands({ 'hang.forever': z.object({}), 'count.add': z.object({}) }),
        dispatch: ({ name }) => {
          if (name === 'hang.forever') return new Promise<void>(() => {});
        },
        getState: () => ({ id }),
      });
      return {
        target: app,
        dispose: () => {
          disposed.push(id);
        },
      };
    });
    const t = await bootWith(stuck);
    const hanging = t.run('dispatch', { name: 'hang.forever' });
    const queued = t.run('dispatch', { name: 'count.add' });
    await tick();
    await Promise.all([t.dispose(), t.dispose()]);
    await t.dispose();
    await expect(hanging).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED', message: expect.stringContaining('disposed') });
    await expect(queued).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
    expect(disposed).toEqual([1]);
    await expect(t.run('getState', {})).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('keeps rejecting after a failed boot during reset until a later reset succeeds', async () => {
    let created = 0;
    const flaky = defineHeadless(() => {
      created += 1;
      if (created === 2) throw new Error('boot exploded');
      const app = createTarget({ commands: defineCommands({ 'x.go': z.object({}) }), dispatch: () => {}, getState: () => ({ id: created }) });
      return { target: app };
    });
    const t = await bootWith(flaky);
    const failure = await t.run('reset', {}).catch((caught: unknown) => caught);
    expect(isIronbirdError(failure) && failure.code).toBe('INTERNAL');
    expect(isIronbirdError(failure) && failure.message).toContain('boot exploded');
    expect(await t.run('getState', {}).catch((caught: unknown) => caught)).toBe(failure);
    expect(await t.run('reset', {})).toEqual({ rev: 0, path: '', value: { id: 3 } });
    expect(await t.run('getState', {})).toMatchObject({ value: { id: 3 } });
  });

  it('runs an operation that arrives during an asynchronous reset against the new session', async () => {
    let releaseBoot: (() => void) | undefined;
    let boots = 0;
    const slowBoot = defineHeadless(async () => {
      boots += 1;
      if (boots > 1)
        await new Promise<void>((resolve) => {
          releaseBoot = resolve;
        });
      let count = 0;
      const target = createTarget({
        commands: defineCommands({ 'count.add': z.object({}) }),
        dispatch: () => {
          count += 1;
        },
        getState: () => ({ count, boot: boots }),
      });
      return { target };
    });
    const t = await createHeadlessTarget({ definition: slowBoot, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    const reset = t.run('reset', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const during = t.run('dispatch', { name: 'count.add', path: '' });
    const read = t.run('getState', { path: 'boot' });
    releaseBoot?.();
    await reset;
    expect(await during).toMatchObject({ state: { count: 1, boot: 2 } });
    expect(await read).toMatchObject({ value: 2 });
    await t.dispose();
  });

  it('disposing during a reset tears down the session that reset was about to install', async () => {
    let releaseBoot: (() => void) | undefined;
    const disposedIds: number[] = [];
    let created = 0;
    const slowBoot = defineHeadless(async () => {
      const id = ++created;
      if (id > 1)
        await new Promise<void>((resolve) => {
          releaseBoot = resolve;
        });
      const target = createTarget({ commands: defineCommands({ 'x.go': z.object({}) }), dispatch: () => {}, getState: () => ({ id }) });
      return {
        target,
        dispose: () => {
          disposedIds.push(id);
        },
      };
    });
    const t = await createHeadlessTarget({ definition: slowBoot, appId: 'a', settleTimeoutMs: 100, env: {}, log: () => {} });
    const reset = t.run('reset', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dispose = t.dispose();
    releaseBoot?.();
    await expect(reset).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await dispose;
    expect(disposedIds).toEqual([1, 2]);
  });
});
