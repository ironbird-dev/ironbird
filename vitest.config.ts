import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
// The bridge reads Platform.OS from react-native; in Node it gets this stub instead.
const alias = { 'react-native': path.join(here, 'packages/react-native/test/react-native-stub.ts') };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'examples/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
          exclude: [
            '**/*.device.test.ts',
            '**/node_modules/**',
            '**/dist/**',
            'packages/cli/test/**',
            'packages/cli/src/cli/commands/serve.test.ts',
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'serial',
          // cli.integration.test.ts and cli/commands/serve.test.ts both drive real daemons
          // against the shared examples/checkout/.ironbird/daemon.json; running test files
          // in parallel lets one suite's daemon.json writes/removals race the other's.
          include: ['packages/cli/test/**/*.test.ts', 'packages/cli/src/cli/commands/serve.test.ts'],
          exclude: ['**/*.device.test.ts', '**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'device',
          include: ['**/*.device.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
