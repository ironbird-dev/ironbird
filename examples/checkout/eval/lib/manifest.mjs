// The fixture's standalone project files (M3 design §7.1 step 3). The example resolves the ironbird
// packages through the pnpm workspace and its tsconfig extends the monorepo's base; a session runs
// outside the repository, so the fixture gets a manifest that installs the packed tarballs with npm,
// a tsconfig with the base options inlined, and its own Vitest config.

const TARBALL_PREFIXES = { core: 'ironbird-core-', reactNative: 'ironbird-react-native-', cli: 'ironbird-cli-' };

/** Picks the three `pnpm pack` tarballs out of a directory listing. Throws when one is missing or ambiguous. */
export function pickTarballs(files) {
  const picked = {};
  for (const [key, prefix] of Object.entries(TARBALL_PREFIXES)) {
    const matches = files.filter((file) => file.startsWith(prefix) && file.endsWith('.tgz') && /^\d/.test(file.slice(prefix.length)));
    if (matches.length !== 1) throw new Error(`Expected one ${prefix}<version>.tgz in vendor/, found ${matches.length}: ${matches.join(', ') || 'none'}`);
    picked[key] = matches[0];
  }
  return picked;
}

/**
 * Exact versions forced on the fixture's install through npm `overrides`, for when the registry
 * resolves a peer range differently from the monorepo (npm ERESOLVE). Each entry pins a package to
 * the version the monorepo's pnpm-lock.yaml resolves. Empty while the plain install works.
 */
export const FIXTURE_PINS = {};

/** Flags for the fixture's `npm install`. `--legacy-peer-deps` goes here only as a last resort, and prepare.json records it. */
export const NPM_INSTALL_FLAGS = ['--no-audit', '--no-fund'];

const sortKeys = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));

/**
 * The fixture's package.json: the ironbird packages point at the tarballs in vendor/, `overrides`
 * makes every nested reference to core and react-native use the same tarballs, Vitest, TypeScript,
 * and Node's types join devDependencies at the monorepo's versions (Expo checks for TypeScript when
 * a tsconfig.json exists, and the tsconfig names Node's types), `test` runs Vitest, and the
 * measurement script, the `start:ios` and `start:android` scripts, the pngjs dependencies, and `@ironbird/testing` (only the removed test/ files use it) go. `pins` (FIXTURE_PINS) join `overrides`.
 */
export function standaloneManifest(example, { tarballs, versions, pins = {} }) {
  // `start:ios` and `start:android` go too: `expo start --ios` picks the wrong simulator, so agents start Metro with `expo start`.
  const { measure: _measure, 'start:ios': _startIos, 'start:android': _startAndroid, ...scripts } = example.scripts;
  const { '@ironbird/cli': _cli, '@ironbird/testing': _testing, pngjs: _pngjs, '@types/pngjs': _typesPngjs, ...devDependencies } = example.devDependencies;
  const manifest = {
    name: 'checkout',
    private: true,
    license: example.license,
    version: example.version,
    type: example.type,
    main: example.main,
    scripts: { ...scripts, test: 'vitest run' },
    dependencies: sortKeys({
      ...example.dependencies,
      '@ironbird/core': `file:vendor/${tarballs.core}`,
      '@ironbird/react-native': `file:vendor/${tarballs.reactNative}`,
    }),
    devDependencies: sortKeys({
      ...devDependencies,
      '@ironbird/cli': `file:vendor/${tarballs.cli}`,
      '@types/node': versions.typesNode,
      typescript: versions.typescript,
      vitest: versions.vitest,
    }),
    overrides: { ...sortKeys(pins), '@ironbird/core': '$@ironbird/core', '@ironbird/react-native': '$@ironbird/react-native' },
  };
  const leftover = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([, spec]) => String(spec).startsWith('workspace:'));
  if (leftover.length > 0) throw new Error(`The fixture manifest still has workspace dependencies: ${leftover.map(([name]) => name).join(', ')}`);
  return manifest;
}

/** The fixture's tsconfig.json: the base options inlined under the example's own, no `extends`, and no test/ include (the device tests are removed). */
export function standaloneTsconfig(example, base) {
  const { extends: _extends, ...rest } = example;
  return {
    ...rest,
    compilerOptions: { ...base.compilerOptions, ...example.compilerOptions },
    include: example.include.filter((pattern) => !pattern.startsWith('test/')),
  };
}

export const VITEST_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.device.test.ts', '**/node_modules/**'],
  },
});
`;

export const GITIGNORE = `node_modules/
.ironbird/
.expo/
dist/
`;
