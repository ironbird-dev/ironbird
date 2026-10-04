import { createTestTarget, type ModelStep, type TestTarget } from '@ironbird/testing';
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
