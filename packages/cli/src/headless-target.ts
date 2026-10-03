import {
  IronbirdError,
  conditionHolds,
  createEventRecorder,
  createManualClock,
  createTracker,
  getAtPath,
  messageOf,
  parseCondition,
  serializeState,
  suggestNames,
  type Description,
  type EventRecorder,
  type FakeInstance,
  type HeadlessApp,
  type HeadlessDefinition,
  type ManualClock,
  type RecordedEvent,
  type SettleResult,
  type StepResult,
  type Tracker,
} from '@ironbird/core';
import { QUEUED_OPS, type DaemonTarget } from './daemon-target';
import { createOperationQueue } from './operation-queue';

export { MUTATING_OPS, QUEUED_OPS } from './daemon-target';

export interface HeadlessTargetOptions {
  definition: HeadlessDefinition;
  /**
   * Loads the headless entry again from source, for `reload`; `serve` passes one that re-bundles
   * the configured entry. Without it the target doesn't declare `reload`, and the operation fails
   * with `UNSUPPORTED`, as for a definition built inline with no file behind it.
   */
  loadDefinition?: () => Promise<HeadlessDefinition>;
  appId: string;
  clockStart?: string;
  settleTimeoutMs: number;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
  /**
   * Wall-clock bound on booting the app (default 30 s): one `definition.create` call at start and
   * on `reset`, and a reload's `loadDefinition` call and the `create` after it together, under one
   * deadline. Without it a factory or a load that never resolves wedges the target for good: `run`
   * waits on the stuck transition, and `dispose` awaits it too. The target reports it as
   * `lifecycleTimeoutMs`, so the daemon's request bound never cuts a transition short.
   */
  bootTimeoutMs?: number;
  /**
   * Path to the module `definition` was loaded from, reported as `details.entry` in a boot
   * failure so the message names the file that failed to load rather than the app's declared id.
   * Falls back to `appId` when omitted, as in tests that build a definition inline with no file
   * behind it.
   */
  entryPath?: string;
}

export interface HeadlessTarget extends DaemonTarget {
  readonly id: 'headless';
}

interface Session {
  clock: ManualClock;
  recorder: EventRecorder;
  tracker: Tracker;
  app: HeadlessApp;
  unsubscribe: () => void;
}

type Params = Record<string, unknown>;
/** The target's two lifecycle transitions (spec §4.1). */
type Transition = 'reset' | 'reload';
type ResetResult = { rev: number; path: string; value: unknown };
type ReloadResult = { rev: number };

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export async function createHeadlessTarget(options: HeadlessTargetOptions): Promise<HeadlessTarget> {
  const log = options.log ?? ((line: string) => console.error(line));
  const eventListeners = new Set<(event: RecordedEvent) => void>();
  const stateListeners = new Set<(rev: number) => void>();
  const warned = new Set<string>();
  const queue = createOperationQueue('headless');
  let session: Session | undefined;
  // The code `reset` re-runs. A reload clears it before loading and sets it only on success, so
  // after a failed reload `reset` has nothing to run and fails with the load error: resetting would
  // run code that no longer matches the source (spec D5).
  let definition: HeadlessDefinition | undefined = options.definition;
  // The last transition requested, running or waiting behind an earlier one. Transitions never
  // overlap, and every other operation waits until none is pending.
  let lifecycle: { kind: Transition; promise: Promise<ResetResult | ReloadResult> } | undefined;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let bootError: IronbirdError | undefined;
  const connectedAt = Date.now();

  const bootTimeoutMs = options.bootTimeoutMs ?? 30_000;
  const entry = options.entryPath ?? options.appId;

  // A factory or a load that hangs must fail its transition rather than the whole target, so each
  // races a timer that fires at `deadline` (a `Date.now()` value). A reload's load and boot share
  // one deadline, so the transition as a whole never outlasts `bootTimeoutMs`. The abandoned work
  // keeps running on its own; nothing else ever reads its result, so a late result can never be
  // installed.
  const beforeDeadline = async <T>(work: Promise<T>, deadline: number, timedOut: () => Error): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timedOut()), Math.max(0, deadline - Date.now()));
    });
    timeout.catch(() => undefined);
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // `afterLoad` marks the boot that follows a reload's load: the factory then had only what the load
  // left of the deadline, so the timeout names both (`reloadFailure` wraps it as HEADLESS_LOAD_FAILED).
  const createApp = async (source: HeadlessDefinition, context: Parameters<HeadlessDefinition['create']>[0], deadline: number, afterLoad: boolean): Promise<HeadlessApp> =>
    beforeDeadline(source.create(context), deadline, () =>
      afterLoad
        ? new Error(`load and boot timed out after ${bootTimeoutMs} ms`)
        : new IronbirdError('HEADLESS_LOAD_FAILED', `Headless app failed to start: the factory did not resolve within ${bootTimeoutMs} ms`, { entry, message: `boot timed out after ${bootTimeoutMs} ms` }),
    );

  const boot = async (source: HeadlessDefinition, deadline = Date.now() + bootTimeoutMs, afterLoad = false): Promise<Session> => {
    const clock = createManualClock({ now: options.clockStart ? Date.parse(options.clockStart) : 0 });
    const recorder = createEventRecorder({ clock });
    const tracker = createTracker({ clock });
    const app = await createApp(source, { clock, recorder, tracker, env: options.env }, deadline, afterLoad);
    const offEvents = recorder.subscribe((event) => eventListeners.forEach((listener) => listener(event)));
    const offState = app.target.subscribe(() => stateListeners.forEach((listener) => listener(app.target.revision())));
    return { clock, recorder, tracker, app, unsubscribe: () => (offEvents(), offState()) };
  };

  // A boot failure is a load failure whichever boot it was: the app the config names never came
  // up. An IronbirdError from the factory or the loader (a bad payload, say) keeps its own code.
  const bootFailure = (error: unknown): IronbirdError =>
    error instanceof IronbirdError ? error : new IronbirdError('HEADLESS_LOAD_FAILED', `Headless app failed to start: ${messageOf(error)}`, { entry, message: messageOf(error) });

  // A reload that fails for any reason is a load failure: the source no longer yields a running app.
  // A load error already coded HEADLESS_LOAD_FAILED passes through with its details (an import
  // chain, say); anything else, including an IronbirdError the factory threw with another code, is
  // reported under HEADLESS_LOAD_FAILED with the original code kept in the message, so an agent
  // never mistakes a broken edit for a bad payload or an unknown fake.
  const reloadFailure = (error: unknown): IronbirdError => {
    if (error instanceof IronbirdError && error.code === 'HEADLESS_LOAD_FAILED') return error;
    const message = error instanceof IronbirdError ? `${error.code}: ${error.message}` : messageOf(error);
    return new IronbirdError('HEADLESS_LOAD_FAILED', `Headless app failed to reload: ${message}`, { entry, message });
  };

  const disposedError = (op: string): IronbirdError => new IronbirdError('UNSUPPORTED', 'Target is disposed', { op, target: 'headless' });

  try {
    session = await boot(options.definition);
  } catch (error) {
    throw bootFailure(error);
  }

  const disposeSession = async (current: Session): Promise<void> => {
    current.unsubscribe();
    try {
      await current.app.dispose?.();
    } catch (error) {
      // The listeners are already detached, so the session is gone either way; the caller still
      // needs a coded error rather than whatever the app happened to throw.
      throw new IronbirdError('INTERNAL', `App dispose failed: ${messageOf(error)}`, { message: messageOf(error) });
    }
  };

  // There is no session while a transition runs, and none at all after `dispose`. A failed
  // transition leaves `bootError` behind so every later operation reports why the target is
  // unusable until another transition succeeds.
  const requireSession = (op: string): Session => {
    if (!session) throw bootError ?? disposedError(op);
    return session;
  };

  const snapshotOf = (current: Session, path: string): unknown => {
    const { value, warnings } = serializeState(getAtPath(current.app.target.getState(), path));
    for (const warning of warnings) {
      const fullPath = [path, warning.path].filter((part) => part !== '').join('.');
      if (warned.has(fullPath)) continue;
      warned.add(fullPath);
      log(`warning UNSERIALIZABLE_STATE at ${fullPath || '<root>'}: ${warning.valueKind} replaced with a placeholder`);
    }
    return value;
  };

  const settleOptions = (params: Params): { timeoutMs: number } | null => {
    const settle = params['settle'];
    if (settle === false) return null;
    const timeoutMs = typeof settle === 'object' && settle !== null ? num((settle as { timeoutMs?: unknown }).timeoutMs, options.settleTimeoutMs) : options.settleTimeoutMs;
    return { timeoutMs };
  };

  // `fakes` is a capability: an app that wires none answers UNSUPPORTED, as the remote target does
  // before a request reaches the bridge (protocol.md §5). With fakes wired, a name that isn't one of
  // them is UNKNOWN_FAKE, listing the wired names and near misses.
  const fakeNamed = (current: Session, op: string, name: string): FakeInstance => {
    const fakes = current.app.fakes ?? [];
    if (fakes.length === 0) throw new IronbirdError('UNSUPPORTED', `The headless target doesn't support ${op}: the app wires no fakes`, { op, target: 'headless' });
    const fake = fakes.find((candidate) => candidate.name === name);
    if (fake) return fake;
    const available = fakes.map((candidate) => candidate.name);
    throw new IronbirdError('UNKNOWN_FAKE', `Unknown fake ${name}`, { fake: name, available, suggestions: suggestNames(name, available) });
  };

  // Runs a mutating step against `current`, the session that was live when the op started. If a
  // transition or `dispose` intervenes while `action` is in flight, the epoch no longer matches,
  // and this op must neither touch the new session nor report state read off the dead one, so
  // every await is followed by a bail-out.
  const runStep = async (op: string, startedEpoch: number, current: Session, params: Params, action: () => Promise<void>): Promise<StepResult> => {
    const path = str(params['path']);
    const settle = settleOptions(params);
    const since = current.recorder.lastSeq();
    await queue.raceAbandon(op, action());
    if (queue.epoch !== startedEpoch) throw queue.abandoned(op);
    await current.clock.advance(0);
    if (queue.epoch !== startedEpoch) throw queue.abandoned(op);
    const settleResult: SettleResult | null = settle
      ? await queue.raceAbandon(op, current.tracker.whenIdle({ timeoutMs: settle.timeoutMs, mode: 'quiescent' }))
      : null;
    if (queue.epoch !== startedEpoch) throw queue.abandoned(op);
    return { target: 'headless', rev: current.app.target.revision(), path, state: snapshotOf(current, path), events: current.recorder.since(since).events, settle: settleResult };
  };

  const step = (op: string, params: Params, action: (current: Session) => Promise<void>): Promise<StepResult> => {
    const startedEpoch = queue.epoch;
    const current = requireSession(op);
    return runStep(op, startedEpoch, current, params, () => action(current));
  };

  // Subscribes to the session the caller started on, never to whatever `session` holds now.
  const stateChangeOrSleep = async (current: Session, ms: number): Promise<void> => {
    let off: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        off = current.app.target.subscribe(() => resolve());
        timer = setTimeout(resolve, ms);
      });
    } finally {
      off();
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // `reloadFailure` turns the timeout into HEADLESS_LOAD_FAILED "Headless app failed to reload:
  // load timed out after <n> ms", like any other failed load.
  const loadAgain = async (deadline: number): Promise<HeadlessDefinition> => {
    if (!options.loadDefinition) throw new IronbirdError('UNSUPPORTED', "The headless target doesn't support reload", { op: 'reload', target: 'headless' });
    return beforeDeadline(options.loadDefinition(), deadline, () => new Error(`load timed out after ${bootTimeoutMs} ms`));
  };

  // One lifecycle transition, shared by `reset` and `reload` (spec §4.1). Everything up to the
  // first await runs synchronously when the transition starts: the queue is abandoned, so every
  // operation waiting or in flight fails with TARGET_DISCONNECTED, and the old session is detached
  // before anything is loaded, so no failure below can leave the previous code running.
  const transition = async (kind: Transition): Promise<Session> => {
    if (disposed) throw disposedError(kind);
    const kept = definition;
    if (kind === 'reset' && kept === undefined) throw bootError ?? disposedError(kind);
    queue.abandon(kind);
    const previous = session;
    session = undefined;
    warned.clear();
    if (kind === 'reload') definition = undefined;
    let loaded: HeadlessDefinition;
    let next: Session;
    try {
      if (previous) await disposeSession(previous);
      // One deadline for the load and the boot together, so the daemon, which bounds the request
      // at `lifecycleTimeoutMs` plus a margin, never gives up on a transition that then succeeds.
      const deadline = Date.now() + bootTimeoutMs;
      loaded = kind === 'reload' ? await loadAgain(deadline) : (kept as HeadlessDefinition);
      next = await boot(loaded, deadline, kind === 'reload');
    } catch (error) {
      // Kept as the boot error so every later operation reports why the target is unusable. After
      // a failed reset a later reset may retry the same code, and the error keeps its own code as
      // it always has; after a failed reload only a reload can recover, and the error is always
      // HEADLESS_LOAD_FAILED.
      bootError = kind === 'reload' ? reloadFailure(error) : bootFailure(error);
      throw bootError;
    }
    // `dispose` may have run while this transition awaited: nothing will ever use this session, so
    // tear it down rather than installing it, keeping every boot's disposal exact.
    if (disposed) {
      await disposeSession(next);
      throw disposedError(kind);
    }
    definition = loaded;
    session = next;
    bootError = undefined;
    return next;
  };

  // Transitions run one at a time, in the order requested. A reset requested while the last
  // pending transition is also a reset shares it, since both would reset the same code, as two
  // concurrent resets always have. A reload never shares: the source may have changed since the
  // pending transition read it. A reset requested during a reload waits for it and then resets the
  // freshly loaded code.
  const requestTransition = (kind: Transition): Promise<ResetResult | ReloadResult> => {
    if (kind === 'reset' && lifecycle?.kind === 'reset') return lifecycle.promise;
    const before = lifecycle?.promise;
    const promise = (async (): Promise<ResetResult | ReloadResult> => {
      if (before) await before.catch(() => undefined);
      const next = await transition(kind);
      const rev = next.app.target.revision();
      return kind === 'reset' ? { rev, path: '', value: snapshotOf(next, '') } : { rev };
    })();
    const pending = { kind, promise };
    lifecycle = pending;
    const settled = (): void => {
      if (lifecycle === pending) lifecycle = undefined;
    };
    promise.then(settled, settled);
    return promise;
  };

  const ops: Record<string, (params: Params) => unknown | Promise<unknown>> = {
    describe: (): Description => {
      const current = requireSession('describe');
      const fakes: Description['fakes'] = {};
      for (const fake of current.app.fakes ?? []) {
        fakes[fake.name] = { ...(fake.description === undefined ? {} : { description: fake.description }), controls: fake.controls.describe() };
      }
      return {
        app: { id: options.appId, platform: 'headless' },
        commands: current.app.target.commands.describe(),
        fakes,
        capabilities: [
          'settle',
          'events',
          ...(current.app.fakes?.length ? (['fakes'] as const) : []),
          'clock',
          'reset',
          ...(options.loadDefinition ? (['reload'] as const) : []),
          ...current.app.target.capabilities,
        ],
      };
    },
    dispatch: (params) => step('dispatch', params, (current) => current.app.target.dispatch(str(params['name']), params['payload'])),
    getState: (params) => {
      const current = requireSession('getState');
      const path = str(params['path']);
      return { rev: current.app.target.revision(), path, value: snapshotOf(current, path) };
    },
    waitFor: async (params) => {
      const startedEpoch = queue.epoch;
      const current = requireSession('waitFor');
      const path = str(params['path']);
      const condition = parseCondition(params);
      const timeoutMs = num(params['timeoutMs'], 5_000);
      const started = Date.now();
      for (;;) {
        const value = snapshotOf(current, path);
        if (conditionHolds(value, condition)) return { rev: current.app.target.revision(), path, value, waitedMs: Date.now() - started };
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) {
          throw new IronbirdError('WAIT_TIMEOUT', `Condition on ${path || '<root>'} not met within ${timeoutMs} ms`, { path, value, pending: current.tracker.pending() });
        }
        await stateChangeOrSleep(current, Math.min(16, remaining));
        if (queue.epoch !== startedEpoch) throw queue.abandoned('waitFor');
      }
    },
    settle: async (params) => {
      const startedEpoch = queue.epoch;
      const current = requireSession('settle');
      // Through `raceAbandon` like a step's settle, so a transition or dispose rejects this read
      // immediately instead of leaving the caller to wait out its own timeout.
      const result = await queue.raceAbandon('settle', current.tracker.whenIdle({ timeoutMs: num(params['timeoutMs'], options.settleTimeoutMs), mode: 'quiescent' }));
      if (queue.epoch !== startedEpoch) throw queue.abandoned('settle');
      return result;
    },
    events: (params) => requireSession('events').recorder.since(num(params['since'], 0), num(params['limit'], Number.POSITIVE_INFINITY)),
    fakeControl: (params) =>
      step('fakeControl', params, async (current) => {
        const fake = fakeNamed(current, 'fakeControl', str(params['fake']));
        await fake.control(str(params['control']), params['payload']);
      }),
    fakeCalls: (params) => fakeNamed(requireSession('fakeCalls'), 'fakeCalls', str(params['fake'])).calls(num(params['since'], 0), num(params['limit'], Number.POSITIVE_INFINITY)),
    clockAdvance: async (params) => {
      const ms = params['ms'];
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
        throw new IronbirdError('INVALID_PAYLOAD', 'clockAdvance needs a non-negative ms', { name: 'clockAdvance', issues: [{ path: ['ms'], message: 'expected a non-negative number' }] });
      }
      const startedEpoch = queue.epoch;
      const current = requireSession('clockAdvance');
      const result = await runStep('clockAdvance', startedEpoch, current, params, () => current.clock.advance(ms));
      return { ...result, now: current.clock.now() };
    },
    clockNow: () => ({ now: requireSession('clockNow').clock.now() }),
    reset: () => requestTransition('reset'),
    ...(options.loadDefinition ? { reload: () => requestTransition('reload') } : {}),
  };

  return {
    id: 'headless',
    lifecycleTimeoutMs: bootTimeoutMs,
    info: () => ({ id: 'headless', platform: 'headless', appId: options.appId, connectedAt, rev: session ? session.app.target.revision() : 0 }),
    async run(op, params) {
      const handler = ops[op];
      if (!handler) throw new IronbirdError('UNSUPPORTED', `The headless target doesn't support ${op}`, { op, target: 'headless' });
      if (disposed) throw disposedError(op);
      // Not queued: a stuck dispatch must not block recovery, so a transition abandons whatever is
      // still waiting in the queue instead of waiting its turn behind it.
      if (op === 'reset' || op === 'reload') return handler(params);
      // A transition in progress leaves `session` cleared for its dispose, load, and boot. An op
      // that starts here would see no session and fail as if disposed, which is wrong and drops
      // work, so it waits and then runs against whatever session the transition installs. Looping
      // covers a transition requested during the wait too. If the transition fails,
      // `requireSession` rethrows `bootError`.
      while (lifecycle) await lifecycle.promise.catch(() => undefined);
      // `dispose` may have run during that wait, and the ops below would otherwise report the
      // transition's `bootError` (or run against a session dispose is about to tear down).
      if (disposed) throw disposedError(op);
      if (!QUEUED_OPS.has(op)) return handler(params);
      return queue.enqueue(op, async () => handler(params));
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    dispose() {
      // Idempotent, and a second caller awaits the same work rather than returning early while
      // the first call is still disposing.
      if (disposing) return disposing;
      disposed = true;
      queue.abandon('disposed');
      disposing = (async () => {
        // Waiting out every pending transition first keeps the count exact: the running one tears
        // down whatever it booted instead of installing it, and the ones queued behind it fail as
        // disposed without booting at all.
        while (lifecycle) await lifecycle.promise.catch(() => undefined);
        const previous = session;
        session = undefined;
        if (previous) await disposeSession(previous);
      })();
      return disposing;
    },
  };
}
