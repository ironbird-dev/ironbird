import { defineConfig } from 'tsup';

export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm'], platform: 'node', target: 'node22', dts: true, sourcemap: true, clean: true },
  { entry: ['src/config-entry.ts'], format: ['esm', 'cjs'], platform: 'neutral', target: 'es2022', dts: true, sourcemap: true },
]);
