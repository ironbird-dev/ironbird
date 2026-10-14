import { isIronbirdError } from '@ironbird/core';
import { modelTest, type ModelStep, type ModelTestOptions } from '@ironbird/testing';
import { performance } from 'node:perf_hooks';
import type { CheckoutState } from '../src/core/checkout';
import headless from '../src/ironbird/headless';

// The M4 race gate's configuration (M4 design §6.4), shared by the CI smoke (model.smoke.test.ts)
// and the gate (model.gate.test.ts), so the seed the smoke pins was measured under exactly this
// configuration. No scenario file is involved: the roadmap's criterion is that model-based testing
// finds the race "with the planted scenario removed".
//
// Change nothing here except a step's `weight`, and only through the fallback procedure recorded in
// docs/evals/m4-testing-package.md. Any change means re-running `pnpm gate:m4` and re-pinning the
// smoke's seed from the new result file.

export const RACE_INVARIANT = 'completed orders have a non-zero total';

export const raceInvariants = {
  [RACE_INVARIANT]: (state: CheckoutState): boolean => !(state.order.status === 'completed' && state.order.totalCents === 0),
};

// The SKUs come from the catalog (src/core/catalog.ts), not from the schema, because `sku` is a free
// string; this is what payload overrides exist for.
export const RACE_STEPS: ModelStep[] = [
  { command: 'cart.addItem', payload: [{ sku: 'cut-45', qty: 1 }, { sku: 'beard-20', qty: 2 }] },
  { command: 'payment.start', payload: [{ method: 'saved' }, { method: 'card' }] },
  { fake: 'api', control: 'setEcho', payload: [{ mode: 'manual' }, { mode: 'auto' }] },
  { fake: 'api', control: 'emit', payload: [{ event: 'payment.succeeded' }, { event: 'order.confirmed' }, { event: 'payment.failed' }] },
  { clock: { maxMs: 1000 } },
];

export const RACE_NUM_RUNS = 1_000;
// modelTest's documented default, passed explicitly so the recorded configuration is exact.
export const RACE_MAX_STEPS = 20;
export const GATE_SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export interface RaceModelOptions {
  seed: number;
  /** Plant the race. The env is passed whole, so a PLANT_RACE in the shell never reaches an unplanted run. */
  plant: boolean;
  /** The directory counterexample traces go to, or false to write none. */
  artifacts: string | false;
  /** Replaces RACE_STEPS. Only the smoke's misconfiguration check uses it. */
  steps?: ModelStep[];
}

export function raceModel(options: RaceModelOptions): ModelTestOptions<CheckoutState> {
  return {
    headless,
    env: options.plant ? { PLANT_RACE: '1' } : {},
    steps: options.steps ?? RACE_STEPS,
    invariants: raceInvariants,
    maxSteps: RACE_MAX_STEPS,
    numRuns: RACE_NUM_RUNS,
    seed: options.seed,
    artifacts: options.artifacts,
  };
}

/** The details of `INVARIANT_FAILED` (M4 design D6 and §6.4). */
export interface InvariantFailure {
  invariant: string;
  message: string;
  seed: number;
  path: string;
  runs: number;
  steps: Array<Record<string, unknown>>;
  scenarioFile: string | null;
}

export interface RaceOutcome {
  seed: number;
  found: boolean;
  /** Runs until the counterexample (`details.runs`), or every run when none was found. */
  runs: number;
  /** Wall time of the whole modelTest call, shrinking included. */
  wallMs: number;
  failure?: InvariantFailure;
  stepsApplied?: number;
  stepsRejected?: number;
}

/**
 * Runs the race model once. Only INVARIANT_FAILED counts as finding the race; any other error
 * (an unknown command or control, an invalid payload) means the configuration is broken, and is
 * rethrown so the gate can never pass on it.
 */
export async function runRaceModel(options: RaceModelOptions): Promise<RaceOutcome> {
  const started = performance.now();
  const wallMs = (): number => Math.round(performance.now() - started);
  try {
    const result = await modelTest<CheckoutState>(raceModel(options));
    return { seed: options.seed, found: false, runs: result.runs, wallMs: wallMs(), stepsApplied: result.stepsApplied, stepsRejected: result.stepsRejected };
  } catch (error) {
    if (!isIronbirdError(error) || error.code !== 'INVARIANT_FAILED') throw error;
    const failure = error.details as InvariantFailure;
    return { seed: options.seed, found: true, runs: failure.runs, wallMs: wallMs(), failure };
  }
}
