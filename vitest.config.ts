import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'examples/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
          exclude: ['**/*.device.test.ts', '**/node_modules/**', '**/dist/**'],
          // cli.integration.test.ts and cli/commands/serve.test.ts both drive real daemons
          // against the shared examples/checkout/.ironbird/daemon.json; running test files
          // in parallel lets one suite's daemon.json writes/removals race the other's.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'device',
          include: ['**/*.device.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
});
