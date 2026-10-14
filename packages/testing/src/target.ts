import { IronbirdError, type Description, type HeadlessDefinition, type StepResult } from '@ironbird/core';
import { createHeadlessTarget, type DaemonClient } from '@ironbird/cli/runner';

export interface TestTargetOptions {
  headless: HeadlessDefinition;
  /** Reported as `app.id` by `describe`; default `'test'`. */
  appId?: string;
  /** What the definition's factory sees as `env`; default `{}`, never `process.env`, so a run doesn't depend on the shell. */
  env?: Record<string, string | undefined>;
  /** ISO time the manual clock starts at on every boot; default the Unix epoch. */
  clockStart?: string;
  /** How long a step waits to settle, in wall-clock milliseconds; default 5000. */
  settleTimeoutMs?: number;
}

export interface TestTarget {
  /** The CLI's client interface, served in process: no daemon, port, or child process. `stream` fails with UNSUPPORTED. */
  readonly client: DaemonClient;
  send(command: string, payload?: unknown): Promise<StepResult>;
  fake(fake: string, control: string, payload?: unknown): Promise<StepResult>;
  advance(ms: number): Promise<StepResult & { now: number }>;
  state<T = unknown>(path?: string): Promise<T>;
  describe(): Promise<Description>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

const TARGET_ID = 'headless';

/** A headless target behind the CLI's DaemonClient interface (M4 design §4, D2). */
export async function createTestTarget(options: TestTargetOptions): Promise<TestTarget> {
  const target = await createHeadlessTarget({
    definition: options.headless,
    appId: options.appId ?? 'test',
    env: options.env ?? {},
    settleTimeoutMs: options.settleTimeoutMs ?? 5_000,
    clockStart: options.clockStart,
  });

  // The daemon fails an unknown target id with NO_TARGET; so does this, rather than quietly
  // running a scenario meant for a device against the headless app.
  const run = async (op: string, params: Record<string, unknown>, requested: string | undefined): Promise<unknown> => {
    if (requested !== undefined && requested !== TARGET_ID) {
      throw new IronbirdError('NO_TARGET', `No target ${requested}; the in-process test target is ${TARGET_ID}`, { available: [TARGET_ID] });
    }
    return target.run(op, params);
  };

  const client: DaemonClient = {
    url: 'in-process:headless',
    async call<T = unknown>(op: string, params: Record<string, unknown> = {}, requested?: string): Promise<{ target?: string; result: T }> {
      return { target: TARGET_ID, result: (await run(op, params, requested)) as T };
    },
    async rpc<T = unknown>(op: string, params: Record<string, unknown> = {}, requested?: string): Promise<T> {
      return (await run(op, params, requested)) as T;
    },
    async stream(): Promise<void> {
      throw new IronbirdError('UNSUPPORTED', 'The in-process test target has no event stream; read events with client.rpc("events")', { op: 'stream', target: TARGET_ID });
    },
  };

  return {
    client,
    send: (command, payload) => client.rpc<StepResult>('dispatch', { name: command, payload }),
    fake: (fake, control, payload) => client.rpc<StepResult>('fakeControl', { fake, control, payload }),
    advance: (ms) => client.rpc<StepResult & { now: number }>('clockAdvance', { ms }),
    async state<T = unknown>(path = ''): Promise<T> {
      return (await client.rpc<{ value: T }>('getState', { path })).value;
    },
    describe: () => client.rpc<Description>('describe'),
    async reset(): Promise<void> {
      await client.rpc('reset');
    },
    dispose: () => target.dispose(),
  };
}
