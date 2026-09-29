import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({
  appId: 'com.example.checkout',
  headless: './src/ironbird/headless.ts',
  defaultTarget: 'headless',
  clock: { start: '2026-01-01T00:00:00.000Z' },
  // Pins the iOS capture device when more than one simulator is booted, which otherwise makes
  // `screenshot`/`step` fail with AMBIGUOUS_DEVICE (packages/cli/src/devices.ts). Same variable as
  // the device tests' reload helper (examples/checkout/test/device-helpers.ts); unset, this is a
  // no-op and `resolveDevice` falls back to its normal single-booted-simulator check.
  devices: { ios: process.env['IRONBIRD_SIM_UDID'] },
});
