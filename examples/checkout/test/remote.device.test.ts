import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCli, reloadApp, sleep, spawnServe, waitForTarget, type DaemonProcess } from './device-helpers';

// Preconditions: see device-helpers.ts.
const env = { ...process.env, IRONBIRD_TOKEN: undefined };
const ironbird = createCli(env);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let daemon: DaemonProcess | undefined;

beforeAll(async () => {
  daemon = await spawnServe(env);
  await waitForTarget(ironbird, 'ios', 90_000);
});

afterAll(async () => {
  await daemon?.stop();
});

describe('remote mode on the iOS Simulator', () => {
  it('screenshot captures the booted simulator as a PNG', async () => {
    const shot = await ironbird('screenshot');
    expect(shot.code).toBe(0);
    expect(shot.json).toMatchObject({ target: 'ios' });
    const file = await readFile(shot.json['path'] as string);
    expect(file.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('step sends a command, settles, and captures after settling', async () => {
    const added = await ironbird('step', 'cart.addItem', '{"sku":"cut-45","qty":1}', '--path', 'cart');
    expect(added.code).toBe(0);
    expect(added.json).toMatchObject({ target: 'ios', settle: { idle: true }, settledBeforeCapture: true });
    expect(typeof (added.json['screenshot'] as { path: string }).path).toBe('string');
    const paid = await ironbird('step', 'payment.start', '{"method":"saved"}', '--path', 'order');
    expect(paid.code).toBe(0);
    expect(paid.json).toMatchObject({ state: { status: 'completed', totalCents: 4_500 }, settle: { idle: true } });
  });

  it('a reload fails the in-flight request with TARGET_DISCONNECTED and the next request runs under the same id', async () => {
    // The daemon's default target is the headless one configured in ironbird.config.ts
    // (`defaultTarget: 'headless'`), so `wait` and `state` need an explicit `--target ios` to
    // reach the connected app; `screenshot` and `step` above don't because they auto-select the
    // sole connected remote target regardless of the configured default.
    const waiting = ironbird('wait', 'order.orderId', '--equals', 'never', '--timeout', '30s', '--target', 'ios');
    await sleep(500);
    await reloadApp();
    const failed = await waiting;
    expect(failed.code).toBe(1);
    expect(failed.json).toMatchObject({ error: { code: 'TARGET_DISCONNECTED' } });
    await waitForTarget(ironbird, 'ios', 60_000);
    const state = await ironbird('state', 'cart', '--target', 'ios');
    expect(state.code).toBe(0);
    expect(state.json['target']).toBe('ios');
  });
});
