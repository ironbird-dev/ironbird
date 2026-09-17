import {
  IronbirdError,
  conditionHolds,
  getAtPath,
  parseCondition,
  serializeState,
  suggestNames,
  type Capability,
  type Clock,
  type Description,
  type EventRecorder,
  type FakeInstance,
  type SettleResult,
  type StepResult,
  type Target,
  type TimerId,
  type Tracker,
} from '@ironbird/core';
import type { BridgePlatform } from './messages';
import { settle, type SettleDeps } from './settle';

export interface HandlerContext {
  target: Target;
  tracker: Tracker;
  recorder: EventRecorder;
  fakes: FakeInstance[];
  clock: Clock;
  requestFrame: SettleDeps['requestFrame'];
  app: { id: string; platform: BridgePlatform; name?: string };
  settleDefaults: { frames: number; timeoutMs: number };
  /** The id the daemon assigned in `welcome`; read per call because it changes across reconnects. */
  targetId: () => string;
  /** Called once per path whose value was replaced by a placeholder (see serializeState). */
  warn: (path: string, valueKind: string) => void;
}

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;

type Params = Record<string, unknown>;

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** What a remote target declares: never `clock` or `reset` (protocol.md §5). */
export function capabilitiesOf(target: Target, fakes: FakeInstance[]): Capability[] {
  return ['settle', 'events', ...(fakes.length > 0 ? (['fakes'] as const) : []), ...target.capabilities];
}

export function createHandlers(ctx: HandlerContext): Record<string, Handler> {
  const snapshot = (path: string): unknown => {
    const { value, warnings } = serializeState(getAtPath(ctx.target.getState(), path));
    for (const warning of warnings) ctx.warn([path, warning.path].filter((part) => part !== '').join('.'), warning.valueKind);
    return value;
  };

  const settleFor = (params: Params): { timeoutMs: number } | null => {
    const option = params['settle'];
    if (option === false) return null;
    const timeoutMs = typeof option === 'object' && option !== null ? num((option as { timeoutMs?: unknown }).timeoutMs, ctx.settleDefaults.timeoutMs) : ctx.settleDefaults.timeoutMs;
    return { timeoutMs };
  };

  const runSettle = (timeoutMs: number): Promise<SettleResult> =>
    settle({ clock: ctx.clock, tracker: ctx.tracker, requestFrame: ctx.requestFrame }, { frames: ctx.settleDefaults.frames, timeoutMs });

  const step = async (params: Params, action: () => Promise<void>): Promise<StepResult> => {
    const path = str(params['path']);
    const options = settleFor(params);
    const since = ctx.recorder.lastSeq();
    await action();
    const settled = options ? await runSettle(options.timeoutMs) : null;
    return { target: ctx.targetId(), rev: ctx.target.revision(), path, state: snapshot(path), events: ctx.recorder.since(since).events, settle: settled };
  };

  const fakeNamed = (name: string): FakeInstance => {
    const fake = ctx.fakes.find((candidate) => candidate.name === name);
    if (!fake) throw new IronbirdError('UNKNOWN_FAKE', `Unknown fake ${name}`, { name, suggestions: suggestNames(name, ctx.fakes.map((candidate) => candidate.name)) });
    return fake;
  };

  const unsupported = (op: string): never => {
    throw new IronbirdError('UNSUPPORTED', `A remote target doesn't support ${op}`, { op, target: ctx.targetId() });
  };

  const waitFor = (params: Params): Promise<{ rev: number; path: string; value: unknown; waitedMs: number }> => {
    const path = str(params['path']);
    const condition = parseCondition(params);
    const timeoutMs = num(params['timeoutMs'], 5_000);
    const started = ctx.clock.now();
    return new Promise((resolve, reject) => {
      let off: () => void = () => {};
      let timer: TimerId | undefined = undefined;
      const finish = (): void => {
        off();
        if (timer !== undefined) ctx.clock.clearTimeout(timer);
      };
      const check = (): boolean => {
        const value = snapshot(path);
        if (!conditionHolds(value, condition)) return false;
        finish();
        resolve({ rev: ctx.target.revision(), path, value, waitedMs: ctx.clock.now() - started });
        return true;
      };
      if (check()) return;
      off = ctx.target.subscribe(() => {
        try {
          check();
        } catch (error) {
          finish();
          reject(error);
        }
      });
      timer = ctx.clock.setTimeout(
        () => {
          finish();
          reject(new IronbirdError('WAIT_TIMEOUT', `Condition on ${path || '<root>'} not met within ${timeoutMs} ms`, { path, value: snapshot(path), pending: ctx.tracker.pending() }));
        },
        timeoutMs,
        'ironbird.waitFor',
      );
    });
  };

  return {
    describe: async (): Promise<Description> => {
      const fakes: Description['fakes'] = {};
      for (const fake of ctx.fakes) {
        fakes[fake.name] = { ...(fake.description === undefined ? {} : { description: fake.description }), controls: fake.controls.describe() };
      }
      return { app: ctx.app, commands: ctx.target.commands.describe(), fakes, capabilities: capabilitiesOf(ctx.target, ctx.fakes) };
    },
    dispatch: (params) => step(params, () => ctx.target.dispatch(str(params['name']), params['payload'])),
    getState: async (params) => {
      const path = str(params['path']);
      return { rev: ctx.target.revision(), path, value: snapshot(path) };
    },
    waitFor: async (params) => waitFor(params),
    settle: (params) => runSettle(num(params['timeoutMs'], ctx.settleDefaults.timeoutMs)),
    events: async (params) => ctx.recorder.since(num(params['since'], 0), num(params['limit'], Number.POSITIVE_INFINITY)),
    fakeControl: async (params) => {
      const fake = fakeNamed(str(params['fake']));
      return step(params, () => fake.control(str(params['control']), params['payload']));
    },
    fakeCalls: async (params) => ({ calls: fakeNamed(str(params['fake'])).calls(num(params['since'], 0)) }),
    snapshotSave: async () => {
      if (!ctx.target.persist) return unsupported('snapshotSave');
      const { value } = serializeState(ctx.target.persist());
      return { rev: ctx.target.revision(), snapshot: value };
    },
    snapshotLoad: async (params) => {
      if (!ctx.target.restore) return unsupported('snapshotLoad');
      await ctx.target.restore(params['snapshot']);
      return { rev: ctx.target.revision(), path: '', value: snapshot('') };
    },
    clockAdvance: async () => unsupported('clockAdvance'),
    clockNow: async () => unsupported('clockNow'),
    reset: async () => unsupported('reset'),
  };
}
