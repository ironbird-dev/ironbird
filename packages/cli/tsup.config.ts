import { defineConfig } from 'tsup';

// No `clean: true` here: tsup runs these configs in parallel, so one config's clean can delete
// another's already-written output. The `build` script removes `dist` once, up front.
export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm'], platform: 'node', target: 'node22', dts: true, sourcemap: true },
  { entry: ['src/config-entry.ts'], format: ['esm', 'cjs'], platform: 'neutral', target: 'es2022', dts: true, sourcemap: true },
  // `@ironbird/cli/runner`: the headless target and scenario engine in both formats, for CommonJS
  // callers such as Jest through @ironbird/testing (M4 design D1).
  { entry: ['src/runner.ts'], format: ['esm', 'cjs'], platform: 'node', target: 'node22', dts: true, sourcemap: true },
  { entry: ['src/bin.ts'], format: ['esm'], platform: 'node', target: 'node22', banner: { js: '#!/usr/bin/env node' }, sourcemap: true },
]);
