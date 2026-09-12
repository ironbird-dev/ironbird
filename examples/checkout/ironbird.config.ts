import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({
  appId: 'com.example.checkout',
  headless: './src/ironbird/headless.ts',
  defaultTarget: 'headless',
  clock: { start: '2026-01-01T00:00:00.000Z' },
});
