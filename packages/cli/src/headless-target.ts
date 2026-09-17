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
  type Description,
  type EventRecorder,
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
  appId: string;
  clockStart?: string;
  settleTimeoutMs: number;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
  /**
   * Wall-clock bound on one `definition.create` call (default 30 s). Without it a factory that
   * never resolves wedges the target for good: `run` waits on `resetting`, `reset` hands back the
   * same stuck promise, and `dispose` awaits it too.
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
type ResetResult = { rev: number; path: string; value: unknown };

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export async function createHeadlessTarget(options: HeadlessTargetOptions): Promise<HeadlessTarget> {
  const log = options.log ?? ((line: string) => console.error(line));
  const eventListeners = new Set<(event: RecordedEvent) => void>();
  const stateListeners = new Set<(rev: number) => void>();
  const warned = new Set<string>();
  const queue = createOperationQueue('headless');
  let session: Session | undefined;
  let resetting: Promise<ResetResult> | undefined;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let bootError: IronbirdError | undefined;
  const connectedAt = Date.now();

  const bootTimeoutMs = options.bootTimeoutMs ?? 30_000;
  const entry = options.entryPath ?? options.appId;

  // A factory that hangs must fail the boot rather than the whole target, so `create` races a
  // timer. The abandoned factory keeps running on its own; nothing else ever reads its result.
  const createApp = async (context: Parameters<HeadlessDefinition['create']>[0]): Promise<HeadlessApp> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new IronbirdError('HEADLESS_LOAD_FAILED', `Headless app failed to start: the factory did not resolve within ${bootTimeoutMs} ms`, { entry, message: `boot timed out after ${bootTimeoutMs} ms` })), bootTimeoutMs);
    });
    timeout.catch(() => undefined);
    try {
      return await Promise.race([options.definition.create(context), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const boot = async (): Promise<Session> => {
    const clock = createManualClock({ now: options.clockStart ? Date.parse(options.clockStart) : 0 });
    const recorder = createEventRecorder({ clock });
    const tracker = createTracker({ clock });
    const app = await createApp({ clock, recorder, tracker, env: options.env });
    const offEvents = recorder.subscribe((event) => eventListeners.forEach((listener) => listener(event)));
    const offState = app.target.subscribe(() => stateListeners.forEach((listener) => listener(app.target.revision())));
    return { clock, recorder, tracker, app, unsubscribe: () => (offEvents(), offState()) };
  };

  // A boot failure is a load failure whichever boot it was: the app the config names never came
  // up. An IronbirdError from the factory itself (a bad payload, say) keeps its own code.
  const bootFailure = (error: unknown): IronbirdError =>
    error instanceof IronbirdError ? error : new IronbirdError('HEADLESS_LOAD_FAILED', `Headless app failed to start: ${messageOf(error)}`, { entry, message: messageOf(error) });

  try {
    session = await boot();
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

  // There is no session between `reset` bumping the epoch and its `boot()` returning, and none
  // at all after `dispose`. A failed reset leaves `bootError` behind so every later operation
  // reports why the target is unusable until another reset succeeds.
  const requireSession = (op: string): Session => {
    if (!session) throw bootError ?? new IronbirdError('UNSUPPORTED', 'Target is disposed', { op, target: 'headless' });
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

  // Runs a mutating step against `current`, the session that was live when the op started. If a
  // `reset` or `dispose` intervenes while `action` is in flight, the epoch no longer matches, and
  // this op must neither touch the new session nor report state read off the dead one, so every
  // await is followed by a bail-out.
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

  const performReset = (): Promise<ResetResult> => {
    const promise = (async (): Promise<ResetResult> => {
      // First statement, before any await: everything waiting or in flight is invalidated the
      // instant recovery begins, not once a new session happens to be installed.
      queue.abandon('reset');
      const previous = session;
      session = undefined;
      warned.clear();
      if (previous) {
        try {
          await disposeSession(previous);
        } catch (error) {
          // The old session is gone either way (its listeners are already detached above), but a
          // dispose that throws must not leave `bootError` unset: without this, `requireSession`
          // would fall back to its generic "Target is disposed" message for every later op, which
          // is wrong (the target isn't disposed, only this reset's teardown failed) and hides the
          // real cause. A later successful reset clears `bootError` again as usual.
          bootError = bootFailure(error);
          throw bootError;
        }
      }
      let next: Session;
      try {
        next = await boot();
      } catch (error) {
        bootError = bootFailure(error);
        throw bootError;
      }
      // `dispose` may have run while `boot()` was in flight: nothing will ever use this session,
      // so tear it down immediately rather than installing it, keeping every boot's disposal exact.
      if (disposed) {
        await disposeSession(next);
        throw new IronbirdError('UNSUPPORTED', 'Target is disposed', { op: 'reset', target: 'headless' });
      }
      session = next;
      bootError = undefined;
      return { rev: next.app.target.revision(), path: '', value: snapshotOf(next, '') };
    })().finally(() => {
      resetting = undefined;
    });
    resetting = promise;
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
        capabilities: ['settle', 'events', ...(current.app.fakes?.length ? (['fakes'] as const) : []), 'clock', 'reset', ...current.app.target.capabilities],
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
      // Through `raceAbandon` like a step's settle, so a reset or dispose rejects this read
      // immediately instead of leaving the caller to wait out its own timeout.
      const result = await queue.raceAbandon('settle', current.tracker.whenIdle({ timeoutMs: num(params['timeoutMs'], options.settleTimeoutMs), mode: 'quiescent' }));
      if (queue.epoch !== startedEpoch) throw queue.abandoned('settle');
      return result;
    },
    events: (params) => requireSession('events').recorder.since(num(params['since'], 0), num(params['limit'], Number.POSITIVE_INFINITY)),
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
    reset: () => {
      // Not queued (see `run`): a stuck dispatch must not block recovery, so reset abandons
      // whatever is still waiting in the queue instead of waiting its turn behind it.
      if (disposed) {
        throw new IronbirdError('UNSUPPORTED', 'Target is disposed', { op: 'reset', target: 'headless' });
      }
      // Two concurrent resets must not dispose the same session twice or orphan one of the two
      // freshly booted sessions, so a reset already in flight is handed back as-is.
      return resetting ?? performReset();
    },
  };

  return {
    id: 'headless',
    info: () => ({ id: 'headless', platform: 'headless', appId: options.appId, connectedAt, rev: session ? session.app.target.revision() : 0 }),
    async run(op, params) {
      const handler = ops[op];
      if (!handler) throw new IronbirdError('UNSUPPORTED', `The headless target doesn't support ${op}`, { op, target: 'headless' });
      if (disposed) throw new IronbirdError('UNSUPPORTED', 'Target is disposed', { op, target: 'headless' });
      if (op === 'reset') return handler(params);
      // A reset in progress leaves `session` cleared for its dispose/boot window. An op that
      // starts here would see no session and fail as if disposed, which is wrong and drops work,
      // so it waits its turn and then runs against whatever session the reset installs. Looping
      // covers a reset that starts during the wait too. If the reset fails, `requireSession`
      // rethrows `bootError` as it already does.
      while (resetting) await resetting.catch(() => undefined);
      // `dispose` may have run during that wait, and the ops below would otherwise report the
      // reset's `bootError` (or run against a session dispose is about to tear down).
      if (disposed) throw new IronbirdError('UNSUPPORTED', 'Target is disposed', { op, target: 'headless' });
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
        // Awaiting an in-flight reset first is what keeps the count exact: whatever session it
        // installs becomes the one this call disposes.
        await resetting?.catch(() => undefined);
        const previous = session;
        session = undefined;
        if (previous) await disposeSession(previous);
      })();
      return disposing;
    },
  };
}
