import { defineConfig } from 'tsup';

// Runs in Node and Hermes like core, so a neutral platform and ES2022. The peers stay external;
// `redux` and `zod` are type imports and vanish from the output (M5 design D3).
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  external: ['@ironbird/core', 'redux', 'zod'],
});
