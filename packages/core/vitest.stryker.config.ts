import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// StrykerJS runs core's unit tests through this file (stryker.config.json). `pnpm test` uses the
// root vitest.config.ts, whose projects also hold daemon, serial, and device tests that Stryker
// must not run. The root is the repository root, so the include glob reads like the root config's.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  root,
  test: {
    include: ['packages/core/src/**/*.test.ts'],
    exclude: ['**/*.device.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
