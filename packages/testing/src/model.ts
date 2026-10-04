import { IronbirdError, isIronbirdError, messageOf, type ErrorCode, type HeadlessDefinition } from '@ironbird/core';
import * as fc from 'fast-check';
import { applyAction, optionsError, planSteps, toTraceStep, type Action, type ModelStep, type RecordedStep } from './steps';
import { createTestTarget } from './target';
import { writeTrace } from './trace';

export interface ModelTestOptions<S = unknown> {
  headless: HeadlessDefinition;
  /** What the definition's factory sees as `env`; default `{}`. */
  env?: Record<string, string | undefined>;
  steps: ModelStep[];
  /** Name to check; each must return `true` after every step. Anything else, or a throw, is a violation. */
  invariants: Record<string, (state: S) => boolean>;
  /** Longest generated sequence; default 20. */
  maxSteps?: number;
  /** Default 100. */
  numRuns?: number;
  /** Default: fast-check's. The result and any error report the seed used. */
  seed?: number;
  /** What a step the app rejects does to the run; default 'skip'. */
  onStepError?: 'skip' | 'fail';
  /** Where counterexample traces go, or `false` to write none; default '.ironbird/model'. */
  artifacts?: string | false;
}

export interface ModelTestResult {
  runs: number;
  seed: number;
  stepsApplied: number;
  stepsRejected: number;
}

const DEFAULT_ARTIFACTS = '.ironbird/model';

/**
 * Codes that mean the harness broke rather than the app declining a step: a payload the schema
 * rejects (the generator promised valid ones, D5), a clock advance that runs away (a timing
 * problem in the model or app, not a refusal), or a target failure. They end the run whatever
 * `onStepError` says.
 */
const ALWAYS_FAIL: ReadonlySet<ErrorCode> = new Set(['INVALID_PAYLOAD', 'CLOCK_RUNAWAY', 'INTERNAL', 'TARGET_DISCONNECTED', 'HEADLESS_LOAD_FAILED']);

/** Thrown inside the property when an invariant fails. fast-check hands back the one from the shrunk run as `errorInstance`. */
class Violation extends Error {
  constructor(
    readonly invariant: string,
    readonly reason: string,
    readonly steps: RecordedStep[],
  ) {
    super(`Invariant "${invariant}" ${reason}`);
    this.name = 'Violation';
  }
}

/** Thrown inside the property when a step's error ends the run (D5). */
class StepFailure extends Error {
  constructor(
    readonly error: IronbirdError,
    readonly steps: RecordedStep[],
  ) {
    super(error.message);
    this.name = 'StepFailure';
  }
}

function positiveInteger(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw optionsError([key], 'expected a positive integer');
  return value;
}

/** Why an invariant counts as violated, or undefined when it returned `true`. */
function verdict<S>(check: (state: S) => boolean, state: S): string | undefined {
  let result: unknown;
  let promise: boolean;
  try {
    result = check(state);
    // Inside the try: reading `then` runs a getter the invariant returned, which may throw too.
    promise = typeof (result as { then?: unknown } | null | undefined)?.then === 'function';
  } catch (error) {
    return `threw: ${messageOf(error)}`;
  }
  if (result === true) return undefined;
  if (result === false) return 'returned false';
  if (promise) return 'returned a promise; invariants must be synchronous';
  return `returned ${result === null ? 'null' : typeof result}, not a boolean`;
}

async function failureOf(details: fc.RunDetails<[Action[]]>, artifacts: string | false): Promise<IronbirdError> {
  const error = details.errorInstance;
  const where = { seed: details.seed, path: details.counterexamplePath ?? '', runs: details.numRuns };
  if (error instanceof Violation) {
    let scenarioFile: string | null = null;
    let traceError: string | undefined;
    if (artifacts !== false) {
      try {
        scenarioFile = await writeTrace(artifacts, { invariant: error.invariant, seed: where.seed, path: where.path, steps: error.steps });
      } catch (writeError) {
        // The violation is the news; a trace that can't be written must not hide it. The message
        // keeps the §6.4 form without a file, and the write failure goes in the details.
        traceError = messageOf(writeError);
      }
    }
    const trace = scenarioFile === null ? '' : `; trace: ${scenarioFile}`;
    return new IronbirdError('INVARIANT_FAILED', `Invariant "${error.invariant}" failed after ${error.steps.length} steps (seed ${where.seed}, path ${where.path})${trace}`, {
      invariant: error.invariant,
      message: error.reason,
      seed: where.seed,
      path: where.path,
      runs: where.runs,
      steps: error.steps,
      scenarioFile,
      ...(traceError === undefined ? {} : { traceError }),
    });
  }
  if (error instanceof StepFailure) {
    const original = error.error;
    const base = typeof original.details === 'object' && original.details !== null && !Array.isArray(original.details) ? (original.details as Record<string, unknown>) : {};
    return new IronbirdError(original.code, `${original.message} (modelTest step ${error.steps.length}, seed ${where.seed}, path ${where.path})`, { ...base, ...where, steps: error.steps });
  }
  if (isIronbirdError(error)) return error;
  return new IronbirdError('INTERNAL', `modelTest failed: ${messageOf(error)}`, { message: messageOf(error) });
}

/**
 * Model-based testing with the app as the model (M4 design §6): each run resets the target,
 * applies a generated sequence of steps, and checks every invariant against the whole state after
 * every step. A failure is shrunk by fast-check and thrown as INVARIANT_FAILED with a trace file.
 */
export async function modelTest<S = unknown>(options: ModelTestOptions<S>): Promise<ModelTestResult> {
  const maxSteps = positiveInteger(options.maxSteps, 'maxSteps', 20);
  const numRuns = positiveInteger(options.numRuns, 'numRuns', 100);
  // fast-check coerces a seed to a 32-bit integer without a word (NaN runs as 0, 1.5 as another
  // seed), so the reported seed would not reproduce the run; refuse anything else.
  const seed = options.seed;
  if (seed !== undefined && (!Number.isInteger(seed) || seed < -0x80000000 || seed > 0x7fffffff)) throw optionsError(['seed'], 'expected a 32-bit integer');
  const onStepError = options.onStepError ?? 'skip';
  if (onStepError !== 'skip' && onStepError !== 'fail') throw optionsError(['onStepError'], "expected 'skip' or 'fail'");
  if (typeof options.invariants !== 'object' || options.invariants === null) throw optionsError(['invariants'], 'expected an object of named functions');
  const invariants = Object.entries(options.invariants);
  for (const [name, check] of invariants) {
    if (typeof check !== 'function') throw optionsError(['invariants', name], 'expected a function');
  }
  const artifacts = options.artifacts ?? DEFAULT_ARTIFACTS;

  const target = await createTestTarget({ headless: options.headless, env: options.env ?? {} });
  try {
    // Checked against describe() before any run, so a typo costs nothing (§6.1).
    const step = fc.oneof(...planSteps(options.steps, await target.describe()));
    let stepsApplied = 0;
    let stepsRejected = 0;
    const property = fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: maxSteps }), async (actions) => {
      // Every execution, including every shrink attempt, starts from a fresh app and clock.
      await target.reset();
      // The executed prefix, each step marked rejected or not: details.steps reports all of it,
      // and the trace keeps only the applied ones (a rejected step would fail its replay).
      const applied: RecordedStep[] = [];
      for (const action of actions) {
        const recorded: RecordedStep = { ...toTraceStep(action), rejected: false };
        applied.push(recorded);
        try {
          await applyAction(target, action);
          stepsApplied += 1;
        } catch (error) {
          if (!isIronbirdError(error)) throw error;
          recorded.rejected = true;
          if (onStepError === 'fail' || ALWAYS_FAIL.has(error.code)) throw new StepFailure(error, [...applied]);
          stepsRejected += 1;
        }
        const state = await target.state<S>();
        for (const [name, check] of invariants) {
          const reason = verdict(check, state);
          if (reason !== undefined) throw new Violation(name, reason, [...applied]);
        }
      }
    });
    const details = await fc.check(property, { numRuns, ...(seed === undefined ? {} : { seed }) });
    if (!details.failed) return { runs: details.numRuns, seed: details.seed, stepsApplied, stepsRejected };
    throw await failureOf(details, artifacts);
  } finally {
    await target.dispose();
  }
}
