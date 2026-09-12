import {
  IronbirdError,
  createEventRecorder,
  createManualClock,
  createTracker,
  getAtPath,
  messageOf,
  serializeState,
  type Description,
  type EventRecorder,
  type HeadlessApp,
  type HeadlessDefinition,
  type ManualClock,
  type RecordedEvent,
  type SettleResult,
  type StepResult,
  type TargetInfo,
  type Tracker,
} from '@ironbird/core';
import { conditionHolds, parseCondition } from './conditions';

export interface HeadlessTargetOptions {
  definition: HeadlessDefinition;
  appId: string;
  clockStart?: string;
  settleTimeoutMs: number;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface HeadlessTarget {
  readonly id: 'headless';
  info(): TargetInfo;
  run(op: string, params: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: RecordedEvent) => void): () => void;
  onState(listener: (rev: number) => void): () => void;
  dispose(): Promise<void>;
}

export const MUTATING_OPS: ReadonlySet<string> = new Set(['dispatch', 'fakeControl', 'clockAdvance', 'reset', 'snapshotLoad']);

// `reset` is not queued (see `run`), so it isn't one of the ops that waits its turn behind
// whatever else is in flight.
export const QUEUED_OPS: ReadonlySet<string> = new Set([...MUTATING_OPS].filter((op) => op !== 'reset'));

interface Session {
  clock: ManualClock;
  recorder: EventRecorder;
  tracker: Tracker;
  app: HeadlessApp;
  unsubscribe: () => void;
}

type Params = Record<string, unknown>;
type ResetResult = { rev: number; path: string; value: unknown };

interface PendingOp {
  op: string;
  enqueuedEpoch: number;
  reject: (error: unknown) => void;
}

interface InFlightOp {
  op: string;
  reject: (error: unknown) => void;
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export async function createHeadlessTarget(options: HeadlessTargetOptions): Promise<HeadlessTarget> {
  const log = options.log ?? ((line: string) => console.error(line));
  const eventListeners = new Set<(event: RecordedEvent) => void>();
  const stateListeners = new Set<(rev: number) => void>();
  const warned = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const pendingOps = new Set<PendingOp>();
  // Ops whose action is actually executing against the app, as opposed to still waiting its turn
  // in `pendingOps`. `reset` and `dispose` reject these too, so a mutating call whose app promise
  // never settles (a wedged `dispatch`) doesn't stay pending forever.
  const inFlight = new Set<InFlightOp>();
  // `epoch` is the one source of truth for which session an operation belongs to. Both `reset`
  // and `dispose` bump it as their first statement, before any await, so every operation that
  // started earlier is invalidated the instant recovery begins rather than once a new session
  // happens to be installed.
  let epoch = 0;
  let session: Session | undefined;
  let resetting: Promise<ResetResult> | undefined;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let bootError: IronbirdError | undefined;
  const connectedAt = Date.now();

  const boot = async (): Promise<Session> => {
    const clock = createManualClock({ now: options.clockStart ? Date.parse(options.clockStart) : 0 });
    const recorder = createEventRecorder({ clock });
    const tracker = createTracker({ clock });
    const app = await options.definition.create({ clock, recorder, tracker, env: options.env });
    const offEvents = recorder.subscribe((event) => eventListeners.forEach((listener) => listener(event)));
    const offState = app.target.subscribe(() => stateListeners.forEach((listener) => listener(app.target.revision())));
    return { clock, recorder, tracker, app, unsubscribe: () => (offEvents(), offState()) };
  };

  session = await boot();

  const disposeSession = async (current: Session): Promise<void> => {
    current.unsubscribe();
    await current.app.dispose?.();
  };

  // There is no session between `reset` bumping the epoch and its `boot()` returning, and none
  // at all after `dispose`. A failed reset leaves `bootError` behind so every later operation
  // reports why the target is unusable until another reset succeeds.
  const requireSession = (op: string): Session => {
    if (!session) throw bootError ?? new IronbirdError('UNSUPPORTED', 'Target is disposed', { op, target: 'headless' });
    return session;
  };

  const abandoned = (op: string, cause: 'reset' | 'dispose'): IronbirdError =>
    new IronbirdError('TARGET_DISCONNECTED', `Target was ${cause === 'reset' ? 'reset' : 'disposed'} before ${op} completed`, { target: 'headless', op });

  // Once `disposed` is true it never becomes false again, so it tells the epoch-mismatch fallback
  // checks (reached when an action settles on its own rather than via `inFlight` abandonment)
  // which of the two invalidated it.
  const abandonCause = (): 'reset' | 'dispose' => (disposed ? 'dispose' : 'reset');

  // Wraps a promise so that a `reset` or `dispose` racing against it rejects it immediately
  // instead of leaving it to settle (or hang) on its own. The entry is removed once either side
  // wins; an abandonment that arrives after the real promise already won is a no-op.
  const raceAbandon = <T>(op: string, promise: Promise<T>): Promise<T> => {
    const entry: InFlightOp = { op, reject: () => {} };
    const abandon = new Promise<never>((_, reject) => {
      entry.reject = reject;
    });
    abandon.catch(() => undefined);
    inFlight.add(entry);
    return Promise.race([promise, abandon]).finally(() => {
      inFlight.delete(entry);
    });
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
    const since = current.recorder.since(0).nextSeq;
    await raceAbandon(op, action());
    if (epoch !== startedEpoch) throw abandoned(op, abandonCause());
    await current.clock.advance(0);
    if (epoch !== startedEpoch) throw abandoned(op, abandonCause());
    const settleResult: SettleResult | null = settle
      ? await raceAbandon(op, current.tracker.whenIdle({ timeoutMs: settle.timeoutMs, mode: 'quiescent' }))
      : null;
    if (epoch !== startedEpoch) throw abandoned(op, abandonCause());
    return { target: 'headless', rev: current.app.target.revision(), path, state: snapshotOf(current, path), events: current.recorder.since(since).events, settle: settleResult };
  };

  const step = (op: string, params: Params, action: (current: Session) => Promise<void>): Promise<StepResult> => {
    const startedEpoch = epoch;
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
      epoch += 1;
      const previous = session;
      session = undefined;
      // Future enqueues chain onto this fresh queue; an op that was still ahead in the old one
      // keeps running (or hanging) on its own and is caught by an epoch check once/if it ever
      // resolves, but must not block ops enqueued from here on.
      queue = Promise.resolve();
      // Anything still waiting for its turn is abandoned outright: whether or not the op ahead of
      // it ever settles, it must not run against the freshly booted session.
      const waiting = [...pendingOps];
      pendingOps.clear();
      for (const entry of waiting) entry.reject(abandoned(entry.op, 'reset'));
      // Same for anything already executing against the session being torn down: a wedged
      // `dispatch` must not stay pending forever just because reset is recovering the target.
      const executing = [...inFlight];
      inFlight.clear();
      for (const entry of executing) entry.reject(abandoned(entry.op, 'reset'));
      warned.clear();
      if (previous) await disposeSession(previous);
      let next: Session;
      try {
        next = await boot();
      } catch (error) {
        bootError = error instanceof IronbirdError ? error : new IronbirdError('INTERNAL', `Reset failed: ${messageOf(error)}`, { message: messageOf(error) });
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
      const startedEpoch = epoch;
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
        if (epoch !== startedEpoch) throw abandoned('waitFor', abandonCause());
      }
    },
    settle: async (params) => {
      const startedEpoch = epoch;
      const current = requireSession('settle');
      const result = await current.tracker.whenIdle({ timeoutMs: num(params['timeoutMs'], options.settleTimeoutMs), mode: 'quiescent' });
      if (epoch !== startedEpoch) throw abandoned('settle', abandonCause());
      return result;
    },
    events: (params) => requireSession('events').recorder.since(num(params['since'], 0), num(params['limit'], Number.POSITIVE_INFINITY)),
    clockAdvance: async (params) => {
      const ms = params['ms'];
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
        throw new IronbirdError('INVALID_PAYLOAD', 'clockAdvance needs a non-negative ms', { name: 'clockAdvance', issues: [{ path: ['ms'], message: 'expected a non-negative number' }] });
      }
      const startedEpoch = epoch;
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
      // covers a reset that starts during the wait too. If the reset fails, `requireSession` below
      // rethrows `bootError` as it already does.
      while (resetting) await resetting.catch(() => undefined);
      if (!QUEUED_OPS.has(op)) return handler(params);
      const myTurn = queue;
      return new Promise((resolve, reject) => {
        const entry: PendingOp = { op, enqueuedEpoch: epoch, reject };
        pendingOps.add(entry);
        // `myTurn` is the previous queued op's turn, not its result: if that op never settles
        // (e.g. a wedged dispatch), this callback never runs, and `reset` and `dispose` reach in
        // via `pendingOps` to reject `entry` instead of leaving it stuck behind it forever.
        queue = myTurn
          .then(async () => {
            pendingOps.delete(entry);
            if (epoch !== entry.enqueuedEpoch) {
              reject(abandoned(op, abandonCause()));
              return;
            }
            try {
              resolve(await handler(params));
            } catch (error) {
              reject(error);
            }
          })
          .catch(() => undefined);
      });
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
      epoch += 1;
      const waiting = [...pendingOps];
      pendingOps.clear();
      for (const entry of waiting) entry.reject(abandoned(entry.op, 'dispose'));
      const executing = [...inFlight];
      inFlight.clear();
      for (const entry of executing) entry.reject(abandoned(entry.op, 'dispose'));
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
