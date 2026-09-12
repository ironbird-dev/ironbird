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

interface Session {
  clock: ManualClock;
  recorder: EventRecorder;
  tracker: Tracker;
  app: HeadlessApp;
  unsubscribe: () => void;
}

type Params = Record<string, unknown>;

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function createHeadlessTarget(options: HeadlessTargetOptions): Promise<HeadlessTarget> {
  const log = options.log ?? ((line: string) => console.error(line));
  const eventListeners = new Set<(event: RecordedEvent) => void>();
  const stateListeners = new Set<(rev: number) => void>();
  const warned = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
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

  let session = await boot();

  const disposeSession = async (current: Session): Promise<void> => {
    current.unsubscribe();
    await current.app.dispose?.();
  };

  const snapshot = (path: string): unknown => {
    const { value, warnings } = serializeState(getAtPath(session.app.target.getState(), path));
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

  const latestSeq = (): number => session.recorder.since(0).nextSeq;

  const step = async (params: Params, action: () => Promise<void>): Promise<StepResult> => {
    const path = str(params['path']);
    const settle = settleOptions(params);
    const since = latestSeq();
    await action();
    await session.clock.advance(0);
    const settleResult: SettleResult | null = settle ? await session.tracker.whenIdle({ timeoutMs: settle.timeoutMs, mode: 'quiescent' }) : null;
    return { target: 'headless', rev: session.app.target.revision(), path, state: snapshot(path), events: session.recorder.since(since).events, settle: settleResult };
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
    dispatch: (params) => step(params, () => session.app.target.dispatch(str(params['name']), params['payload'])),
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
      const result = await step(params, () => session.clock.advance(ms));
      return { ...result, now: session.clock.now() };
    },
    clockNow: () => ({ now: session.clock.now() }),
    reset: async () => {
      // Not queued (see `run`): a stuck dispatch must not block recovery, so reset abandons
      // whatever is still waiting in the queue instead of waiting its turn behind it.
      await disposeSession(session);
      queue = Promise.resolve();
      session = await boot();
      warned.clear();
      return { rev: session.app.target.revision(), path: '', value: snapshot('') };
    },
  };

  return {
    id: 'headless',
    info: () => ({ id: 'headless', platform: 'headless', appId: options.appId, connectedAt, rev: session.app.target.revision() }),
    async run(op, params) {
      const handler = ops[op];
      if (!handler) throw new IronbirdError('UNSUPPORTED', `The headless target doesn't support ${op}`, { op, target: 'headless' });
      if (op === 'reset') return handler(params);
      if (!MUTATING_OPS.has(op)) return handler(params);
      const next = queue.then(() => handler(params));
      queue = next.catch(() => undefined);
      return next;
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
    dispose: () => disposeSession(session),
  };
}
