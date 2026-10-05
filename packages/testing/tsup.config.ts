import { defineConfig } from 'tsup';

// Node only (it reads and writes files), in both formats so Jest and other CommonJS runners can
// require it (M4 design D1, D9). Dependencies, including `@ironbird/cli/runner`, stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
});
