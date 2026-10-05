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
          include: ['packages/*/src/**/*.test.ts', 'examples/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'examples/*/eval/**/*.test.mjs'],
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
          // model.smoke.test.ts is the M4 race smoke (M4 design D7): in process, no daemon, and
          // here so CI runs it one file at a time rather than beside the CPU-bound unit files.
          include: ['packages/cli/test/**/*.test.ts', 'packages/cli/src/cli/commands/serve.test.ts', 'examples/checkout/test/model.smoke.test.ts'],
          exclude: ['**/*.device.test.ts', '**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'gate',
          // The M4 race gate (M4 design §1 and D7): 10 seeds × 1,000 model runs, planted and unplanted.
          // It measured about 2 s of Vitest time on Node 26 (11 to 13 s with the build), but it is a
          // milestone measurement, so it runs only through `pnpm gate:m4` and is in neither
          // `pnpm test` nor CI. Its tests pass their own timeouts.
          include: ['examples/checkout/test/model.gate.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
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
