import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  external: ['react-native', '@ironbird/core'],
  // The bridge reports its own version in the `hello` handshake. Reading package.json at runtime
  // is not possible in Hermes, so the version is baked in at build time.
  define: { __BRIDGE_VERSION__: JSON.stringify(version) },
});
