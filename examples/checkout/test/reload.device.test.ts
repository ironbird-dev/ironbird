import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedAt, createCli, spawnServe, waitForTarget, type DaemonProcess } from './device-helpers';

// Spec §8, device row (M3): `ironbird reload` restarts the example on the iPhone 17 through
// DevSettings.reload(), and the app comes back on the same target id with fresh state. Preconditions:
// see device-helpers.ts, with Metro started WITHOUT --ios (`pnpm --filter @ironbird-examples/checkout
// start`) and the app opened on the iPhone 17 with `xcrun simctl openurl $IRONBIRD_SIM_UDID
// exp://127.0.0.1:8081`, after `pnpm build` so the bridge declares `reload`.
const env = { ...process.env, IRONBIRD_TOKEN: undefined };
const ironbird = createCli(env);

let daemon: DaemonProcess | undefined;

beforeAll(async () => {
  daemon = await spawnServe(env);
  await waitForTarget(ironbird, 'ios', 90_000);
});

afterAll(async () => {
  // Hands the next device file a fresh app; tolerated so teardown always reaches the daemon stop.
  await ironbird('reload', '--target', 'ios', '--timeout', '45s').catch(() => undefined);
  await daemon?.stop();
});

describe('reload on the iOS Simulator', () => {
  it('reloads the app on the same id with fresh state, and a following send works', async () => {
    const added = await ironbird('send', 'cart.addItem', '{"sku":"cut-45","qty":1}', '--path', 'cart', '--target', 'ios');
    expect(added.code).toBe(0);
    expect(added.json).toMatchObject({ target: 'ios', state: { items: [{ sku: 'cut-45', qty: 1 }] } });
    const before = await connectedAt(ironbird, 'ios');
    expect(before).toBeDefined();

    const reloaded = await ironbird('reload', '--target', 'ios', '--timeout', '45s');
    expect(reloaded.code).toBe(0);
    expect(reloaded.json).toEqual({ target: 'ios', rev: expect.any(Number) });
    // A new connection, registered after the old one, holds the same id.
    expect(await connectedAt(ironbird, 'ios')).toBeGreaterThan(before as number);

    const cart = await ironbird('state', 'cart', '--target', 'ios');
    expect(cart.code).toBe(0);
    expect(cart.json).toMatchObject({ target: 'ios', value: { items: [], subtotalCents: 0 } });

    const again = await ironbird('send', 'cart.addItem', '{"sku":"cut-45","qty":1}', '--path', 'cart', '--target', 'ios');
    expect(again.code).toBe(0);
    expect(again.json).toMatchObject({ target: 'ios', state: { items: [{ sku: 'cut-45', qty: 1 }] } });
  }, 120_000);
});
