import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedAt, createCli, example, reloadApp, spawnServe, waitForTarget, type DaemonProcess } from './device-helpers';

// Gate criterion 2 (docs/roadmap.md, M2): the race scenario, with its clock step optional, ends in
// the same state on iOS and on headless. Preconditions: see device-helpers.ts, plus Metro must be
// running WITHOUT EXPO_PUBLIC_PLANT_RACE, since that flag is baked into the bundle (M2 design D12).
// PLANT_RACE is cleared from the daemon's environment so the headless side is unplanted too.
const env = { ...process.env, IRONBIRD_TOKEN: undefined, PLANT_RACE: undefined };
const ironbird = createCli(env);
const SCENARIO = path.join(example, 'ironbird/scenarios/race-success-before-confirmation.yaml');

let daemon: DaemonProcess | undefined;

beforeAll(async () => {
  daemon = await spawnServe(env);
  await waitForTarget(ironbird, 'ios', 90_000);
});

afterAll(async () => {
  await daemon?.stop();
});

describe('the race scenario across targets', () => {
  it('reaches the same final state on a freshly reloaded iOS app and a freshly reset headless target', async () => {
    // A reload recreates the JS runtime, the fakes, and their id counters (D10), so pay_1 and
    // ord_1 match the headless run. Nothing is sent before the scenario; it reduces motion itself,
    // so `ui` matches too.
    const before = await connectedAt(ironbird, 'ios');
    await reloadApp();
    await waitForTarget(ironbird, 'ios', 60_000, { after: before });

    const ios = await ironbird('scenario', 'run', SCENARIO, '--target', 'ios');
    expect(ios.code).toBe(0);
    expect(ios.json).toMatchObject({ scenario: 'Payment success arrives before order confirmation', target: 'ios', passed: true, stepsRun: 9, skipped: [4] });
    const iosState = await ironbird('state', '--target', 'ios');
    expect(iosState.code).toBe(0);

    expect((await ironbird('reset', '--target', 'headless')).code).toBe(0);
    const headless = await ironbird('scenario', 'run', SCENARIO, '--target', 'headless');
    expect(headless.code).toBe(0);
    expect(headless.json).toMatchObject({ target: 'headless', passed: true, stepsRun: 10, skipped: [] });
    const headlessState = await ironbird('state', '--target', 'headless');
    expect(headlessState.code).toBe(0);

    expect(iosState.json['value']).toEqual({
      cart: { items: [{ sku: 'cut-45', name: 'Haircut', qty: 1, unitCents: 4_500 }], subtotalCents: 4_500 },
      payment: { status: 'succeeded', method: 'saved', token: 'saved-card', paymentId: 'pay_1' },
      order: { status: 'completed', orderId: 'ord_1', totalCents: 4_500, paymentSucceeded: true },
      reader: { connected: true },
      ui: { motion: 'reduced' },
    });
    expect(iosState.json['value']).toEqual(headlessState.json['value']);
  });
});
