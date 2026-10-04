import { loadScenarioFiles, runScenario as runScenarioWithClient } from '@ironbird/cli/runner';
import { createTestTarget, type ModelStep, type TestTarget } from '@ironbird/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutState } from '../src/core/checkout';
import headless from '../src/ironbird/headless';
import { RACE_INVARIANT, raceInvariants, runRaceModel } from './race-model';

// The M4 race smoke (M4 design D7). It runs in `pnpm test` (serial project), so in CI on Node 22
// and 26. The full gate, 10 seeds × 1,000 runs planted and unplanted, is model.gate.test.ts and runs
// only through `pnpm gate:m4`.

const holds = raceInvariants[RACE_INVARIANT];
const targets: TestTarget[] = [];

// `env` is passed whole, never merged with process.env.
async function boot(plant: boolean): Promise<TestTarget> {
  const target = await createTestTarget({ headless, env: plant ? { PLANT_RACE: '1' } : {} });
  targets.push(target);
  return target;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(targets.splice(0).map((target) => target.dispose()));
});

// The reliable five-step witness (§6.4): manual echo, add an item, start a saved payment, advance
// past the 300 ms submission, then deliver payment.succeeded before any order.confirmed.
async function applyWitness(target: TestTarget): Promise<CheckoutState> {
  await target.fake('api', 'setEcho', { mode: 'manual' });
  await target.send('cart.addItem', { sku: 'cut-45', qty: 1 });
  await target.send('payment.start', { method: 'saved' });
  await target.advance(300);
  const waiting = await target.state<CheckoutState['payment']>('payment');
  expect(waiting).toMatchObject({ status: 'awaitingServerEcho', paymentId: 'pay_1' });
  await target.fake('api', 'emit', { event: 'payment.succeeded' });
  return target.state<CheckoutState>();
}

// Measured by `pnpm gate:m4` on 2026-10-04 (docs/evals/m4-testing-package.md, "The CI
// smoke"): the planted seed with the fewest runs to failure, found on Node 22 and 26. Only the seed
// is pinned, with the gate's numRuns of 1,000 (raceModel); the run count and the shrunk steps are
// deliberately not, because a fast-check upgrade may change them. If this seed stops finding the
// race, re-run `pnpm gate:m4`, re-pin from its result file's `smoke` entry, and update the record.
const SMOKE_SEED = 1;

// Replays a trace through the CLI's scenario runner on a fresh target and returns the final state.
// A trace has no expect steps (M4 design §6.4), so it passes; the state is what it reproduces.
async function replay(file: string, cwd: string, plant: boolean): Promise<CheckoutState> {
  const [trace] = await loadScenarioFiles([file], cwd);
  if (!trace) throw new Error(`No trace at ${file}`);
  const target = await boot(plant);
  const result = await runScenarioWithClient(target.client, trace.scenario, { file: trace.file, artifacts: false, reset: true });
  expect(result.passed, `trace replay failed at ${JSON.stringify(result.failedStep)}`).toBe(true);
  return target.state<CheckoutState>();
}

describe('the race witness (deterministic)', () => {
  it('violates the invariant with PLANT_RACE=1', async () => {
    const state = await applyWitness(await boot(true));
    expect(state.payment.status).toBe('succeeded');
    expect(state.order).toEqual({ status: 'completed', totalCents: 0, paymentSucceeded: true });
    expect(holds(state)).toBe(false);
  }, 60_000);

  it('holds without PLANT_RACE, even when the shell sets PLANT_RACE=1', async () => {
    vi.stubEnv('PLANT_RACE', '1');
    const target = await boot(false);
    const state = await applyWitness(target);
    expect(state.payment.status).toBe('awaitingServerEcho');
    expect(state.order).toEqual({ status: 'none', totalCents: 0, paymentSucceeded: true });
    expect(holds(state)).toBe(true);

    await target.fake('api', 'emit', { event: 'order.confirmed' });
    const done = await target.state<CheckoutState>();
    expect(done.order).toEqual({ status: 'completed', orderId: 'ord_1', totalCents: 4_500, paymentSucceeded: true });
    expect(holds(done)).toBe(true);
  }, 60_000);
});

describe('the race model configuration', () => {
  it('rejects a misnamed control before any run instead of counting it as found', async () => {
    const typo: ModelStep[] = [
      { command: 'cart.addItem', payload: [{ sku: 'cut-45', qty: 1 }] },
      { fake: 'api', control: 'emitt', payload: [{ event: 'payment.succeeded' }] },
    ];
    await expect(runRaceModel({ seed: 1, plant: true, artifacts: false, steps: typo })).rejects.toMatchObject({
      code: 'UNKNOWN_CONTROL',
      details: { fake: 'api', control: 'emitt' },
    });
  }, 60_000);
});

describe('modelTest on the measured seed (D7)', () => {
  it('finds the planted race again with the measured seed, and its trace reproduces it', async () => {
    const artifacts = await mkdtemp(path.join(os.tmpdir(), 'ironbird-model-smoke-'));
    try {
      const outcome = await runRaceModel({ seed: SMOKE_SEED, plant: true, artifacts });
      expect(outcome).toMatchObject({ seed: SMOKE_SEED, found: true });
      expect(outcome.runs).toBeLessThanOrEqual(1_000);
      expect(outcome.failure).toMatchObject({ invariant: RACE_INVARIANT, seed: SMOKE_SEED });

      const file = outcome.failure?.scenarioFile;
      if (typeof file !== 'string') throw new Error('modelTest wrote no trace although artifacts was set');
      expect(path.dirname(file)).toBe(artifacts);
      expect(path.basename(file)).toMatch(/\.trace\.yaml$/);

      const plantedState = await replay(file, artifacts, true);
      expect(plantedState.order).toMatchObject({ status: 'completed', totalCents: 0 });
      expect(raceInvariants[RACE_INVARIANT](plantedState)).toBe(false);

      const cleanState = await replay(file, artifacts, false);
      expect(raceInvariants[RACE_INVARIANT](cleanState)).toBe(true);
    } finally {
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);
});
