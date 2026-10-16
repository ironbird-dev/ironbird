import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({
  appId: 'com.example.bareredux',
  headless: './src/ironbird/headless.ts',
  defaultTarget: 'headless',
  clock: { start: '2026-01-01T00:00:00.000Z' },
  // Pins the iOS capture device when more than one simulator is booted, which otherwise makes
  // `screenshot` fail with AMBIGUOUS_DEVICE; unset, it changes nothing.
  devices: { ios: process.env['IRONBIRD_SIM_UDID'] },
});
