import { createEventRecorder, createRealClock, createTarget, createTracker, defineCommands, isIronbirdError, type FakeInstance, type StepResult } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { capabilitiesOf, createHandlers, type HandlerContext } from './handlers';

interface State {
  count: number;
  status: 'idle' | 'loading' | 'done';
  junk?: unknown;
}

function app(options: { persist?: boolean } = {}): HandlerContext & { warnings: Array<[string, string]>; load(): Promise<void> } {
  const clock = createRealClock();
  // timerThresholdMs: 0 keeps the tracker's real-clock timer scan from independently reporting
  // api.load's internal clock.setTimeout as a second pending item alongside the effect that
  // tracker.wrap already tracks for the same operation (both would otherwise carry the label
  // 'api.load', since wrap derives it from the port name and method).
  const tracker = createTracker({ clock, timerThresholdMs: 0 });
  const recorder = createEventRecorder({ clock });
  let state: State = { count: 0, status: 'idle' };
  const listeners = new Set<() => void>();
  const set = (next: State): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const api = tracker.wrap(
    {
      load: () =>
        new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            set({ ...state, status: 'done' });
            recorder.record('api', 'loaded');
            resolve();
          }, 30, 'api.load');
        }),
    },
    'api',
  );
  const commands = defineCommands({
    'counter.add': z.object({ by: z.number().int() }),
    'data.load': z.object({}),
    'state.junk': z.object({}),
  });
  const target = createTarget<typeof commands, State>({
    commands,
    dispatch: ({ name }) => {
      if (name === 'counter.add') set({ ...state, count: state.count + 1 });
      if (name === 'data.load') {
        set({ ...state, status: 'loading' });
        void api.load();
      }
      if (name === 'state.junk') set({ ...state, junk: new Map() });
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...(options.persist ? { persist: () => ({ count: state.count }), restore: (snapshot: unknown) => set({ ...state, count: (snapshot as { count: number }).count }) } : {}),
  });
  const warnings: Array<[string, string]> = [];
  return {
    target,
    tracker,
    recorder,
    fakes: [],
    clock,
    requestFrame: (callback) => {
      setTimeout(callback, 0);
    },
    app: { id: 'com.example.test', platform: 'ios' },
    settleDefaults: { frames: 2, timeoutMs: 500 },
    targetId: () => 'ios',
    warn: (path, kind) => {
      warnings.push([path, kind]);
    },
    warnings,
    load: () => api.load(),
  };
}

function fakeReader(): FakeInstance & { controlled: string[] } {
  const controls = defineCommands({ disconnect: z.object({}), present: z.object({ token: z.string() }) });
  const controlled: string[] = [];
  return {
    name: 'reader',
    description: 'card reader',
    port: {},
    controls,
    controlled,
    async control(name, payload) {
      controls.parse(name as 'disconnect' | 'present', payload);
      controlled.push(name);
    },
    calls: (since = 0) => [{ seq: since + 1, t: 0, fake: 'reader', method: 'collectPayment', args: [4_500], outcome: 'resolved' }],
  };
}

const failure = async (promise: Promise<unknown>): Promise<{ code: string; details: unknown }> => {
  const error = await promise.catch((caught: unknown) => caught);
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return { code: error.code, details: error.details };
};

describe('createHandlers', () => {
  it('describes the app with commands, fakes, and capabilities', async () => {
    const ctx = app();
    ctx.fakes = [fakeReader()];
    const handlers = createHandlers(ctx);
    const description = (await handlers['describe']!({})) as { app: unknown; commands: Record<string, unknown>; fakes: Record<string, { controls: Record<string, unknown> }>; capabilities: string[] };
    expect(description.app).toEqual({ id: 'com.example.test', platform: 'ios' });
    expect(Object.keys(description.commands)).toEqual(['counter.add', 'data.load', 'state.junk']);
    expect(Object.keys(description.fakes['reader']!.controls)).toEqual(['disconnect', 'present']);
    expect(description.capabilities).toEqual(['settle', 'events', 'fakes']);
    expect(capabilitiesOf(app({ persist: true }).target, [])).toEqual(['settle', 'events', 'persist', 'restore']);
  });

  it('dispatches, settles, and returns the state at a path with the events of the step', async () => {
    const handlers = createHandlers(app());
    const result = (await handlers['dispatch']!({ name: 'data.load', path: 'status' })) as StepResult;
    expect(result).toMatchObject({ target: 'ios', rev: 2, path: 'status', state: 'done' });
    expect(result.events.map((event) => event.name)).toEqual(['loaded']);
    expect(result.settle).toMatchObject({ idle: true, quiescent: false, pending: [] });
    const quick = (await handlers['dispatch']!({ name: 'counter.add', payload: { by: 1 }, settle: false })) as StepResult;
    expect(quick.settle).toBeNull();
    expect(quick.rev).toBe(3);
  });

  it('reports an unsettled step with the pending effect when the timeout is short', async () => {
    const handlers = createHandlers(app());
    const result = (await handlers['dispatch']!({ name: 'data.load', settle: { timeoutMs: 5 } })) as StepResult;
    expect(result.settle).toMatchObject({ idle: false });
    expect(result.settle?.pending.map((item) => item.label)).toEqual(['api.load']);
  });

  it('validates payloads through the registry', async () => {
    const handlers = createHandlers(app());
    expect(await failure(handlers['dispatch']!({ name: 'counter.add', payload: { by: 'x' } }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    // Order comes from @ironbird/core's suggestNames, which ranks by Levenshtein distance from
    // 'counter.plus' (ties broken alphabetically) — not from command declaration order.
    expect(await failure(handlers['dispatch']!({ name: 'counter.plus' }))).toMatchObject({ code: 'UNKNOWN_COMMAND', details: { suggestions: ['counter.add', 'state.junk', 'data.load'] } });
  });

  it('getState serializes with placeholders and reports the replaced path', async () => {
    const ctx = app();
    const handlers = createHandlers(ctx);
    await handlers['dispatch']!({ name: 'state.junk', settle: false });
    expect(await handlers['getState']!({ path: 'junk' })).toEqual({ rev: 1, path: 'junk', value: { $unserializable: 'Map' } });
    // The handlers report every replacement; startBridge is what dedupes them per path (Task 6).
    // Two calls land here: dispatch's own StepResult always serializes the state at its (default
    // root) path, which already finds the Map at 'junk', and the explicit getState call below
    // serializes it again.
    expect(ctx.warnings).toEqual([
      ['junk', 'Map'],
      ['junk', 'Map'],
    ]);
  });

  it('waitFor resolves from a subscription and times out with the pending list', async () => {
    const handlers = createHandlers(app());
    const waiting = handlers['waitFor']!({ path: 'count', equals: 1, timeoutMs: 1_000 });
    await handlers['dispatch']!({ name: 'counter.add', payload: { by: 1 }, settle: false });
    expect(await waiting).toMatchObject({ path: 'count', value: 1, rev: 1 });
    await handlers['dispatch']!({ name: 'data.load', settle: false });
    const timeout = await failure(handlers['waitFor']!({ path: 'status', equals: 'never', timeoutMs: 10 }));
    expect(timeout.code).toBe('WAIT_TIMEOUT');
    expect((timeout.details as { value: string; pending: Array<{ label: string }> }).value).toBe('loading');
    expect((timeout.details as { pending: Array<{ label: string }> }).pending.map((item) => item.label)).toEqual(['api.load']);
    expect(await failure(handlers['waitFor']!({ path: 'count' }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('events and settle read without dispatching', async () => {
    const ctx = app();
    const handlers = createHandlers(ctx);
    ctx.recorder.record('analytics', 'opened');
    expect(await handlers['events']!({ since: 0 })).toMatchObject({ events: [{ seq: 1, name: 'opened' }], nextSeq: 1, truncated: false });
    expect(await handlers['settle']!({ timeoutMs: 50 })).toMatchObject({ idle: true });
  });

  it('drives fakes and lists their calls, and names unknown fakes', async () => {
    const ctx = app();
    const reader = fakeReader();
    ctx.fakes = [reader];
    const handlers = createHandlers(ctx);
    const result = (await handlers['fakeControl']!({ fake: 'reader', control: 'present', payload: { token: 't' }, settle: false })) as StepResult;
    expect(reader.controlled).toEqual(['present']);
    expect(result).toMatchObject({ target: 'ios', settle: null });
    expect(await handlers['fakeCalls']!({ fake: 'reader', since: 2 })).toEqual({ calls: [expect.objectContaining({ seq: 3, method: 'collectPayment' })] });
    expect(await failure(handlers['fakeControl']!({ fake: 'printer', control: 'x' }))).toMatchObject({ code: 'UNKNOWN_FAKE', details: { name: 'printer', suggestions: ['reader'] } });
  });

  it('saves and restores snapshots when the target can, and refuses otherwise', async () => {
    const able = createHandlers(app({ persist: true }));
    await able['dispatch']!({ name: 'counter.add', payload: { by: 1 }, settle: false });
    expect(await able['snapshotSave']!({})).toEqual({ rev: 1, snapshot: { count: 1 } });
    expect(await able['snapshotLoad']!({ snapshot: { count: 7 } })).toMatchObject({ rev: 2, path: '', value: { count: 7 } });
    const unable = createHandlers(app());
    expect(await failure(unable['snapshotSave']!({}))).toMatchObject({ code: 'UNSUPPORTED', details: { op: 'snapshotSave', target: 'ios' } });
  });

  it('answers UNSUPPORTED for clock and reset operations', async () => {
    const handlers = createHandlers(app());
    for (const op of ['clockAdvance', 'clockNow', 'reset']) {
      expect(await failure(handlers[op]!({}))).toMatchObject({ code: 'UNSUPPORTED', details: { op, target: 'ios' } });
    }
  });
});
