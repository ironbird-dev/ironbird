import { parseScenario, runScenario as runScenarioOnClient } from '@ironbird/cli/runner';
import { createTarget, defineCommands, defineHeadless, isIronbirdError, type IronbirdError } from '@ironbird/core';
import * as fc from 'fast-check';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelTest, type ModelTestOptions } from './model';
import { runScenario } from './scenario';
import type { ModelStep, RecordedStep } from './steps';
import { createTestTarget } from './target';
import { counterApp, type CounterState } from './test-app';

const CAP = 'count stays at or below the cap';
const SILENT = 'the bell never rings';
const STEPS: ModelStep[] = ['count.inc', 'count.fail', { fake: 'bell', control: 'strike' }, { clock: { maxMs: 250 } }];
const INC: RecordedStep = { send: 'count.inc', payload: {}, rejected: false };

// An app whose zero-delay timer reschedules itself forever, so any clock step runs away.
const runawayApp = defineHeadless(({ clock }) => {
  const loop = (): void => {
    clock.setTimeout(loop, 0, 'loop');
  };
  loop();
  return {
    target: createTarget({
      commands: defineCommands({ noop: z.object({}).describe('Do nothing') }),
      dispatch: () => undefined,
      getState: () => ({}),
      subscribe: () => () => undefined,
    }),
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ironbird-model-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs modelTest and returns the IronbirdError it throws; fails the test if it finds nothing. */
async function failure(options: ModelTestOptions<CounterState>): Promise<IronbirdError> {
  try {
    await modelTest(options);
  } catch (error) {
    if (isIronbirdError(error)) return error;
    throw error;
  }
  throw new Error('modelTest found nothing');
}

const detailsOf = (error: IronbirdError): Record<string, unknown> => error.details as Record<string, unknown>;

describe('modelTest', () => {
  it.each([1, 2, 3, 4, 5])('finds the planted bug and shrinks it to the minimal sequence (seed %i)', async (seed) => {
    const error = await failure({ headless: counterApp, env: { BUG: '1' }, steps: STEPS, invariants: { [CAP]: (s) => s.count <= 2 }, numRuns: 200, seed, artifacts: false });
    expect(error.code).toBe('INVARIANT_FAILED');
    const details = detailsOf(error);
    expect(details).toMatchObject({ invariant: CAP, message: 'returned false', seed, steps: [INC, INC, INC], scenarioFile: null });
    expect(Object.keys(details)).toEqual(['invariant', 'message', 'seed', 'path', 'runs', 'steps', 'scenarioFile']);
    expect(typeof details['path']).toBe('string');
    expect(details['runs']).toBeGreaterThanOrEqual(1);
    expect(error.message).toBe(`Invariant "${CAP}" failed after 3 steps (seed ${seed}, path ${String(details['path'])})`);
  });

  it('is deterministic for a seed', async () => {
    const options: ModelTestOptions<CounterState> = { headless: counterApp, steps: STEPS, invariants: { [SILENT]: (s) => s.rings === 0 }, numRuns: 200, seed: 7, artifacts: false };
    const first = detailsOf(await failure(options));
    const second = detailsOf(await failure(options));
    expect(second).toEqual(first);
  });

  it('writes a trace that parses, replays, and becomes a regression check with an expect step', async () => {
    const error = await failure({ headless: counterApp, steps: STEPS, invariants: { [SILENT]: (s) => s.rings === 0 }, numRuns: 200, seed: 3, artifacts: dir });
    const details = detailsOf(error);
    expect(typeof details['scenarioFile']).toBe('string');
    const file = details['scenarioFile'] as string;
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-the-bell-never-rings\.trace\.yaml$/);
    expect(error.message.endsWith(`; trace: ${file}`)).toBe(true);

    const text = await readFile(file, 'utf8');
    const scenario = parseScenario(text, file);
    expect(scenario.name).toBe(`Counterexample: ${SILENT}`);
    expect(scenario.steps[0]?.kind).toBe('reset');
    const applied = (details['steps'] as RecordedStep[]).filter((step) => !step.rejected).map(({ rejected: _rejected, ...step }) => step);
    expect(scenario.steps.slice(1).map((step) => step.raw)).toEqual(applied);
    expect((await runScenario(file, { headless: counterApp })).passed).toBe(true);

    const regression = path.join(dir, 'regression.yaml');
    await writeFile(regression, `${text}  - expect: rings\n    equals: 0\n`);
    const result = await runScenario(regression, { headless: counterApp });
    expect(result.passed).toBe(false);
    expect(result.failedStep?.expected).toEqual({ equals: 0 });
  });

  it('reports a rejected step in details but leaves it out of the trace, which replays to the violating state', async () => {
    // The app boots over the cap, so the cap invariant fails after the first step, which the app
    // rejects: the shrunk counterexample is that one rejected step.
    const env = { START: 'over-cap' };
    const error = await failure({ headless: counterApp, env, steps: ['count.fail'], invariants: { [CAP]: (s) => s.count <= 2 }, numRuns: 10, seed: 1, artifacts: dir });
    const details = detailsOf(error);
    expect(details).toMatchObject({ invariant: CAP, steps: [{ send: 'count.fail', payload: {}, rejected: true }] });
    expect(error.message).toContain('failed after 1 steps');

    // (a) The trace parses, with the rejected step left out.
    const file = details['scenarioFile'] as string;
    const scenario = parseScenario(await readFile(file, 'utf8'), file);
    expect(scenario.steps.map((step) => step.kind)).toEqual(['reset']);

    // (b) Replayed through the CLI runner on a fresh target it passes, and the invariant fails on the final state.
    const target = await createTestTarget({ headless: counterApp, env });
    try {
      const replayed = await runScenarioOnClient(target.client, scenario, { file, artifacts: false, reset: true });
      expect(replayed.passed).toBe(true);
      const state = await target.state<CounterState>();
      expect(state.count <= 2).toBe(false);
    } finally {
      await target.dispose();
    }
  });

  it('finds nothing in a correct app and reports what ran', async () => {
    const result = await modelTest<CounterState>({ headless: counterApp, steps: STEPS, invariants: { [CAP]: (s) => s.count <= 2 }, numRuns: 100, seed: 1, artifacts: dir });
    expect(result).toMatchObject({ runs: 100, seed: 1 });
    expect(result.stepsApplied).toBeGreaterThan(0);
    expect(result.stepsRejected).toBeGreaterThan(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('skips steps the app rejects by default, and fails on them with onStepError: fail', async () => {
    const steps: ModelStep[] = ['count.inc', 'count.fail'];
    await expect(modelTest<CounterState>({ headless: counterApp, steps, invariants: { [CAP]: (s) => s.count <= 2 }, numRuns: 50, seed: 1, artifacts: false })).resolves.toMatchObject({ runs: 50 });
    const error = await failure({ headless: counterApp, steps, invariants: { [CAP]: (s) => s.count <= 2 }, numRuns: 50, seed: 1, onStepError: 'fail', artifacts: false });
    expect(error.code).toBe('DISPATCH_FAILED');
    expect(detailsOf(error)).toMatchObject({ name: 'count.fail', seed: 1, steps: [{ send: 'count.fail', payload: {}, rejected: true }] });
    expect(error.message).toContain('seed 1');
  });

  it('always fails on INVALID_PAYLOAD, because the generator promised valid payloads', async () => {
    const error = await failure({ headless: counterApp, steps: [{ command: 'count.add', payload: [{ by: 9 }] }], invariants: {}, numRuns: 10, seed: 1, artifacts: false });
    expect(error.code).toBe('INVALID_PAYLOAD');
    expect(detailsOf(error)).toMatchObject({ name: 'count.add', seed: 1, steps: [{ send: 'count.add', payload: { by: 9 }, rejected: true }] });
  });

  it('uses payload overrides, as lists or arbitraries, including from another copy of fast-check', async () => {
    const commonjs = createRequire(import.meta.url)('fast-check') as typeof fc;
    for (const payload of [[{ by: 2 }], fc.constant({ by: 2 }), commonjs.constant({ by: 2 })]) {
      const error = await failure({ headless: counterApp, steps: [{ command: 'count.add', payload }], invariants: { 'count stays below 2': (s) => s.count < 2 }, numRuns: 10, seed: 1, artifacts: false });
      expect(detailsOf(error)['steps']).toEqual([{ send: 'count.add', payload: { by: 2 }, rejected: false }]);
    }
  });

  it.each<[string, () => unknown, string]>([
    ['throws', () => {
      throw new Error('no state');
    }, 'threw: no state'],
    ['returns undefined', () => undefined, 'returned undefined, not a boolean'],
    ['returns a promise', async () => true, 'returned a promise; invariants must be synchronous'],
    [
      'returns an object whose then getter throws',
      () => ({
        get then(): unknown {
          throw new Error('no then');
        },
      }),
      'threw: no then',
    ],
  ])('counts an invariant that %s as violated', async (_label, check, message) => {
    const error = await failure({ headless: counterApp, steps: ['count.inc'], invariants: { odd: check as unknown as (s: CounterState) => boolean }, numRuns: 5, seed: 1, artifacts: false });
    expect(detailsOf(error)).toMatchObject({ invariant: 'odd', message, steps: [INC] });
  });

  it('still throws INVARIANT_FAILED when the trace cannot be written', async () => {
    const blocker = path.join(dir, 'file');
    await writeFile(blocker, '');
    const error = await failure({ headless: counterApp, env: { BUG: '1' }, steps: ['count.inc'], invariants: { [CAP]: (s) => s.count <= 2 }, numRuns: 20, seed: 1, artifacts: path.join(blocker, 'model') });
    expect(error.code).toBe('INVARIANT_FAILED');
    const details = detailsOf(error);
    expect(details['scenarioFile']).toBeNull();
    expect(details['traceError']).toEqual(expect.stringContaining('Could not write trace'));
    expect(Object.keys(details)).toEqual(['invariant', 'message', 'seed', 'path', 'runs', 'steps', 'scenarioFile', 'traceError']);
    expect(error.message).toBe(`Invariant "${CAP}" failed after 3 steps (seed 1, path ${String(details['path'])})`);
  });

  it('fails on CLOCK_RUNAWAY whatever onStepError says, because a runaway clock is not the app declining a step', async () => {
    const error = await failure({ headless: runawayApp, steps: [{ clock: { maxMs: 10 } }], invariants: {}, numRuns: 10, seed: 1, artifacts: false });
    expect(error.code).toBe('CLOCK_RUNAWAY');
    const details = detailsOf(error);
    expect(details).toMatchObject({ labels: ['loop'], seed: 1, runs: expect.any(Number), steps: [{ clock: expect.any(Number), rejected: true }] });
    expect(typeof details['path']).toBe('string');
    expect(error.message).toContain('seed 1');
  });

  it.each<[string, Partial<ModelTestOptions<CounterState>>, Record<string, unknown>]>([
    ['an unknown command', { steps: ['count.inx'] }, { code: 'UNKNOWN_COMMAND' }],
    ['an unknown fake', { steps: [{ fake: 'bel', control: 'strike' }] }, { code: 'UNKNOWN_FAKE' }],
    ['an unknown control', { steps: [{ fake: 'bell', control: 'strik' }] }, { code: 'UNKNOWN_CONTROL' }],
    ['no steps', { steps: [] }, { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['steps'] }] } }],
    ['numRuns 0', { numRuns: 0 }, { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['numRuns'] }] } }],
    ['a fractional maxSteps', { maxSteps: 2.5 }, { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['maxSteps'] }] } }],
    ['a NaN seed', { seed: Number.NaN }, { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['seed'] }] } }],
    ['a fractional seed', { seed: 1.5 }, { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['seed'] }] } }],
    ['a seed beyond 32 bits', { seed: 2 ** 40 }, { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['seed'] }] } }],
    ['an unknown onStepError', { onStepError: 'retry' as unknown as 'skip' }, { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['onStepError'] }] } }],
  ])('rejects %s before any run', async (_label, overrides, expected) => {
    let calls = 0;
    const options: ModelTestOptions<CounterState> = {
      headless: counterApp,
      steps: ['count.inc'],
      invariants: {
        counted: () => {
          calls += 1;
          return true;
        },
      },
      numRuns: 5,
      seed: 1,
      ...overrides,
    };
    await expect(modelTest(options)).rejects.toMatchObject(expected);
    expect(calls).toBe(0);
  });
});
