import { defineConfig } from 'tsup';

// No `clean: true` here: tsup runs these three configs in parallel, so one config's clean can
// delete another's already-written output. The `build` script removes `dist` once, up front.
export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm'], platform: 'node', target: 'node22', dts: true, sourcemap: true },
  { entry: ['src/config-entry.ts'], format: ['esm', 'cjs'], platform: 'neutral', target: 'es2022', dts: true, sourcemap: true },
  { entry: ['src/bin.ts'], format: ['esm'], platform: 'node', target: 'node22', banner: { js: '#!/usr/bin/env node' }, sourcemap: true },
]);
