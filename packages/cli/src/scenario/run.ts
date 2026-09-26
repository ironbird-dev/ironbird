import { IronbirdError, conditionHolds, isIronbirdError, suggestNames, toErrorShape, type Description, type ScenarioResult, type StepResult } from '@ironbird/core';
import path from 'node:path';
import type { DaemonClient } from '../cli/client';
import { createRunDirectory } from './artifacts';
import type { Scenario, ScenarioStep } from './parse';

export interface RunScenarioOptions {
  /** Fills `ScenarioResult.file`; the artifacts include a copy of the file at this path. */
  file: string;
  /** Overrides the scenario's own `target`. With neither, the daemon picks its default. */
  target?: string;
  /** The artifacts root the run directory goes under, or `false` to write nothing. */
  artifacts: string | false;
}

type FailedStep = NonNullable<ScenarioResult['failedStep']>;
type Failure = Omit<FailedStep, 'index' | 'step'>;

/** Stops the run with a structured failure. Thrown only inside `runScenario`, which turns it into `failedStep`. */
class StepFailed extends Error {
  constructor(readonly failure: Failure) {
    super('scenario step failed');
    this.name = 'StepFailed';
  }
}

interface Support {
  platform: string;
  capabilities: ReadonlySet<string>;
  fakes: string[];
}

/**
 * The error a step would fail with on this target, decided from `describe` before the step runs
 * (design D7, so a skipped step never half-runs), or undefined when the target supports it.
 */
function blocker(step: ScenarioStep, support: Support, target: string): IronbirdError | undefined {
  const needs = (op: string, capability: string): IronbirdError | undefined =>
    support.capabilities.has(capability) ? undefined : new IronbirdError('UNSUPPORTED', `Target ${target} does not support ${op}`, { op, target });
  switch (step.kind) {
    case 'send':
    case 'wait':
    case 'expect':
      return undefined;
    case 'clock':
      return needs('clockAdvance', 'clock');
    case 'reset':
      return needs('reset', 'reset');
    case 'screenshot':
      return support.platform === 'headless' ? new IronbirdError('UNSUPPORTED', `Target ${target} has no screen to capture`, { op: 'screenshot', target }) : undefined;
    case 'fake': {
      const missing = needs('fakeControl', 'fakes');
      if (missing) return missing;
      if (support.fakes.includes(step.fake)) return undefined;
      return new IronbirdError('UNKNOWN_FAKE', `Target ${target} has no fake ${step.fake}`, { fake: step.fake, available: support.fakes, suggestions: suggestNames(step.fake, support.fakes) });
    }
  }
}

/**
 * Runs a mutating step `times` times. A step that ends neither idle nor quiescent fails the
 * scenario (design D6) unless it opted out with `settle: false`. A failure names the repetition
 * when the step repeats.
 */
async function repeated(times: number, settle: boolean, operation: () => Promise<StepResult>): Promise<void> {
  for (let repetition = 1; repetition <= times; repetition += 1) {
    const which = times > 1 ? { repetition } : {};
    let result: StepResult;
    try {
      result = await operation();
    } catch (error) {
      throw new StepFailed({ ...which, error: toErrorShape(error) });
    }
    const outcome = result.settle;
    if (settle && outcome !== null && !outcome.idle && !outcome.quiescent) throw new StepFailed({ ...which, actual: { settle: outcome } });
  }
}

async function runStep(client: DaemonClient, target: string, step: ScenarioStep, index: number, runDir: string | null): Promise<void> {
  switch (step.kind) {
    case 'send':
      return repeated(step.repeat, step.settle, () => client.rpc<StepResult>('dispatch', { name: step.command, payload: step.payload, settle: step.settle }, target));
    case 'fake':
      return repeated(step.repeat, step.settle, () => client.rpc<StepResult>('fakeControl', { fake: step.fake, control: step.control, payload: step.payload, settle: step.settle }, target));
    case 'clock':
      return repeated(1, step.settle, () => client.rpc<StepResult>('clockAdvance', { ms: step.ms, settle: step.settle }, target));
    case 'wait':
      try {
        await client.rpc('waitFor', { path: step.path, ...step.condition, timeoutMs: step.timeoutMs }, target);
      } catch (error) {
        if (isIronbirdError(error) && error.code === 'WAIT_TIMEOUT') {
          throw new StepFailed({ expected: step.condition, actual: (error.details as { value?: unknown } | undefined)?.value });
        }
        throw error;
      }
      return;
    case 'expect': {
      const { value } = await client.rpc<{ value: unknown }>('getState', { path: step.path }, target);
      if (!conditionHolds(value, step.condition)) throw new StepFailed({ expected: step.condition, actual: value });
      return;
    }
    case 'screenshot':
      await client.rpc('screenshot', runDir === null ? {} : { out: path.join(runDir, `${index}-${step.name}.png`) }, target);
      return;
    case 'reset':
      await client.rpc('reset', {}, target);
      return;
  }
}

/**
 * Runs one scenario against the daemon: `describe` first, whose envelope pins the target for
 * every later operation, then each step as one operation. Stops at the first failing step. A
 * failure of the initial `describe` is thrown as is, so the caller can exit with its own code;
 * everything after that becomes a `ScenarioResult`.
 */
export async function runScenario(client: DaemonClient, scenario: Scenario, options: RunScenarioOptions): Promise<ScenarioResult> {
  const started = Date.now();
  const requested = options.target ?? scenario.target;
  const described = await client.call<Description>('describe', {}, requested);
  const target = described.target ?? requested;
  if (target === undefined) throw new IronbirdError('INTERNAL', 'The daemon did not report which target answered describe', { message: 'describe envelope has no target' });
  const support: Support = { platform: described.result.app.platform, capabilities: new Set(described.result.capabilities), fakes: Object.keys(described.result.fakes) };
  const runDir = options.artifacts === false ? null : await createRunDirectory(options.artifacts, scenario.name);

  const skipped: number[] = [];
  let stepsRun = 0;
  let failedStep: FailedStep | undefined;
  for (const [index, step] of scenario.steps.entries()) {
    const blocked = blocker(step, support, target);
    if (blocked) {
      if (step.optional) {
        skipped.push(index);
        continue;
      }
      failedStep = { index, step: step.raw, error: toErrorShape(blocked) };
      break;
    }
    stepsRun += 1;
    try {
      await runStep(client, target, step, index, runDir);
    } catch (error) {
      failedStep = { index, step: step.raw, ...(error instanceof StepFailed ? error.failure : { error: toErrorShape(error) }) };
      break;
    }
  }

  return {
    scenario: scenario.name,
    file: options.file,
    target,
    passed: failedStep === undefined,
    durationMs: Date.now() - started,
    stepsRun,
    ...(failedStep === undefined ? {} : { failedStep }),
    skipped,
    artifacts: runDir,
  };
}
