import {
  IronbirdError,
  createEventRecorder,
  createManualClock,
  createTracker,
  getAtPath,
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
  generation: number;
}

type Params = Record<string, unknown>;
type ResetResult = { rev: number; path: string; value: unknown };

interface PendingOp {
  op: string;
  enqueuedFor: number;
  reject: (error: unknown) => void;
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function createHeadlessTarget(options: HeadlessTargetOptions): Promise<HeadlessTarget> {
  const log = options.log ?? ((line: string) => console.error(line));
  const eventListeners = new Set<(event: RecordedEvent) => void>();
  const stateListeners = new Set<(rev: number) => void>();
  const warned = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const pendingOps = new Set<PendingOp>();
  let sessionCounter = 0;
  let resetting: Promise<ResetResult> | undefined;
  let disposed = false;
  const connectedAt = Date.now();

  const boot = async (): Promise<Session> => {
    const clock = createManualClock({ now: options.clockStart ? Date.parse(options.clockStart) : 0 });
    const recorder = createEventRecorder({ clock });
    const tracker = createTracker({ clock });
    const app = await options.definition.create({ clock, recorder, tracker, env: options.env });
    const offEvents = recorder.subscribe((event) => eventListeners.forEach((listener) => listener(event)));
    const offState = app.target.subscribe(() => stateListeners.forEach((listener) => listener(app.target.revision())));
    sessionCounter += 1;
    return { clock, recorder, tracker, app, unsubscribe: () => (offEvents(), offState()), generation: sessionCounter };
  };

  let session = await boot();

  const disposeSession = async (current: Session): Promise<void> => {
    current.unsubscribe();
    await current.app.dispose?.();
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

  const snapshot = (path: string): unknown => snapshotOf(session, path);

  const settleOptions = (params: Params): { timeoutMs: number } | null => {
    const settle = params['settle'];
    if (settle === false) return null;
    const timeoutMs = typeof settle === 'object' && settle !== null ? num((settle as { timeoutMs?: unknown }).timeoutMs, options.settleTimeoutMs) : options.settleTimeoutMs;
    return { timeoutMs };
  };

  // Runs a mutating step against `current`, the session that was live when the op started.
  // If `reset` swaps in a new session while `action` is in flight, the new session must never
  // observe this op's side effects through the target, so we bail out with TARGET_DISCONNECTED
  // instead of reading state or events off of `current` any further.
  const runStep = async (current: Session, params: Params, action: () => Promise<void>, op: string): Promise<StepResult> => {
    const path = str(params['path']);
    const settle = settleOptions(params);
    const since = current.recorder.since(0).nextSeq;
    await action();
    if (current !== session) {
      throw new IronbirdError('TARGET_DISCONNECTED', 'Target was reset while the operation was in flight', { target: 'headless', op });
    }
    await current.clock.advance(0);
    const settleResult: SettleResult | null = settle ? await current.tracker.whenIdle({ timeoutMs: settle.timeoutMs, mode: 'quiescent' }) : null;
    if (current !== session) {
      throw new IronbirdError('TARGET_DISCONNECTED', 'Target was reset while the operation was in flight', { target: 'headless', op });
    }
    return { target: 'headless', rev: current.app.target.revision(), path, state: snapshotOf(current, path), events: current.recorder.since(since).events, settle: settleResult };
  };

  const step = (params: Params, action: (current: Session) => Promise<void>, op: string): Promise<StepResult> => {
    const current = session;
    return runStep(current, params, () => action(current), op);
  };

  const waitForStateChangeOrSleep = async (ms: number): Promise<void> => {
    let off: () => void = () => {};
    const changed = new Promise<void>((resolve) => {
      off = session.app.target.subscribe(() => resolve());
    });
    try {
      await Promise.race([changed, sleep(ms)]);
    } finally {
      off();
    }
  };

  const performReset = async (): Promise<ResetResult> => {
    const previous = session;
    await disposeSession(previous);
    session = await boot();
    // Future enqueues chain onto this fresh queue; an op that was still ahead in the old one
    // keeps running (or hanging) on its own and is caught by the generation check in `runStep`
    // once/if it ever resolves, but must not block ops enqueued from here on.
    queue = Promise.resolve();
    // Anything still waiting for its turn is abandoned outright: whether or not the op ahead of
    // it ever settles, it must not run against the freshly booted session.
    const abandoned = [...pendingOps];
    pendingOps.clear();
    for (const entry of abandoned) {
      entry.reject(new IronbirdError('TARGET_DISCONNECTED', `Target was reset before ${entry.op} ran`, { target: 'headless', op: entry.op }));
    }
    warned.clear();
    return { rev: session.app.target.revision(), path: '', value: snapshot('') };
  };

  const ops: Record<string, (params: Params) => unknown | Promise<unknown>> = {
    describe: (): Description => {
      const fakes: Description['fakes'] = {};
      for (const fake of session.app.fakes ?? []) {
        fakes[fake.name] = { ...(fake.description === undefined ? {} : { description: fake.description }), controls: fake.controls.describe() };
      }
      return {
        app: { id: options.appId, platform: 'headless' },
        commands: session.app.target.commands.describe(),
        fakes,
        capabilities: ['settle', 'events', ...(session.app.fakes?.length ? (['fakes'] as const) : []), 'clock', 'reset', ...session.app.target.capabilities],
      };
    },
    dispatch: (params) => step(params, (current) => current.app.target.dispatch(str(params['name']), params['payload']), 'dispatch'),
    getState: (params) => {
      const path = str(params['path']);
      return { rev: session.app.target.revision(), path, value: snapshot(path) };
    },
    waitFor: async (params) => {
      const path = str(params['path']);
      const condition = parseCondition(params);
      const timeoutMs = num(params['timeoutMs'], 5_000);
      const started = Date.now();
      for (;;) {
        const value = snapshot(path);
        if (conditionHolds(value, condition)) return { rev: session.app.target.revision(), path, value, waitedMs: Date.now() - started };
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) {
          throw new IronbirdError('WAIT_TIMEOUT', `Condition on ${path || '<root>'} not met within ${timeoutMs} ms`, { path, value, pending: session.tracker.pending() });
        }
        await waitForStateChangeOrSleep(Math.min(16, remaining));
      }
    },
    settle: (params) => session.tracker.whenIdle({ timeoutMs: num(params['timeoutMs'], options.settleTimeoutMs), mode: 'quiescent' }),
    events: (params) => session.recorder.since(num(params['since'], 0), num(params['limit'], Number.POSITIVE_INFINITY)),
    clockAdvance: async (params) => {
      const ms = params['ms'];
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
        throw new IronbirdError('INVALID_PAYLOAD', 'clockAdvance needs a non-negative ms', { name: 'clockAdvance', issues: [{ path: ['ms'], message: 'expected a non-negative number' }] });
      }
      const current = session;
      const result = await runStep(current, params, () => current.clock.advance(ms), 'clockAdvance');
      return { ...result, now: current.clock.now() };
    },
    clockNow: () => ({ now: session.clock.now() }),
    reset: async () => {
      // Not queued (see `run`): a stuck dispatch must not block recovery, so reset abandons
      // whatever is still waiting in the queue instead of waiting its turn behind it.
      if (disposed) {
        throw new IronbirdError('UNSUPPORTED', 'Target is disposed', { op: 'reset', target: 'headless' });
      }
      // Two concurrent resets must not dispose the same session twice or orphan one of the two
      // freshly booted sessions, so a reset already in flight is handed back as-is.
      if (resetting) return resetting;
      const promise = performReset().finally(() => {
        resetting = undefined;
      });
      resetting = promise;
      return promise;
    },
  };

  return {
    id: 'headless',
    info: () => ({ id: 'headless', platform: 'headless', appId: options.appId, connectedAt, rev: session.app.target.revision() }),
    async run(op, params) {
      const handler = ops[op];
      if (!handler) throw new IronbirdError('UNSUPPORTED', `The headless target doesn't support ${op}`, { op, target: 'headless' });
      if (op === 'reset') return handler(params);
      if (!QUEUED_OPS.has(op)) return handler(params);
      const enqueuedFor = session.generation;
      const myTurn = queue;
      return new Promise((resolve, reject) => {
        const entry: PendingOp = { op, enqueuedFor, reject };
        pendingOps.add(entry);
        // `myTurn` is the previous queued op's turn, not its result: if that op never settles
        // (e.g. a wedged dispatch), this callback never runs, and `reset` reaches in via
        // `pendingOps` to reject `entry` directly instead of leaving it stuck behind it forever.
        queue = myTurn
          .then(async () => {
            pendingOps.delete(entry);
            if (session.generation !== enqueuedFor) {
              reject(new IronbirdError('TARGET_DISCONNECTED', `Target was reset before ${op} ran`, { target: 'headless', op }));
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
    async dispose() {
      disposed = true;
      if (resetting) await resetting.catch(() => undefined);
      await disposeSession(session);
    },
  };
}
