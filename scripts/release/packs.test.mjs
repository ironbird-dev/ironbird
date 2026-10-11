import { describe, expect, it } from 'vitest';
import { EXPECTED_PUBLISHED, exportTargets, manifestProblems, packProblems, publishedProblems } from './packs.mjs';

const dual = (base) => ({ import: { types: `./dist/${base}.d.ts`, default: `./dist/${base}.js` }, require: { types: `./dist/${base}.d.cts`, default: `./dist/${base}.cjs` } });
const coreManifest = {
  name: '@ironbird/core',
  version: '0.1.0',
  license: 'MIT',
  main: './dist/index.cjs',
  module: './dist/index.js',
  types: './dist/index.d.ts',
  exports: { '.': dual('index') },
  peerDependencies: { zod: '^4.2.0' },
};
const coreFiles = ['LICENSE', 'README.md', 'package.json', 'dist/index.cjs', 'dist/index.cjs.map', 'dist/index.d.cts', 'dist/index.d.ts', 'dist/index.js', 'dist/index.js.map'];

describe('exportTargets', () => {
  it('collects every file package.json points at, without ./ and without ./package.json', () => {
    const manifest = { main: './dist/a.cjs', exports: { '.': { import: './dist/a.js' }, './package.json': './package.json', './bin': './dist/bin.js' }, bin: './dist/bin.js' };
    expect(exportTargets(manifest)).toEqual(['dist/a.cjs', 'dist/a.js', 'dist/bin.js']);
  });
});

describe('packProblems', () => {
  it('passes a dual-format package with declarations, README, and LICENSE', () => {
    expect(packProblems({ name: '@ironbird/core', manifest: coreManifest, files: coreFiles })).toEqual([]);
  });

  it('names a missing LICENSE or README, and a file package.json names that was not packed', () => {
    const files = coreFiles.filter((file) => !['LICENSE', 'README.md', 'dist/index.d.cts'].includes(file));
    expect(packProblems({ name: '@ironbird/core', manifest: coreManifest, files })).toEqual([
      'LICENSE is missing',
      'README.md is missing',
      'dist/index.d.cts is named in package.json but not packed',
    ]);
  });

  it('rejects sources, tests, configs, build caches, and TypeScript that is not a declaration', () => {
    const files = [...coreFiles, 'src/index.ts', 'dist/index.test.js', 'tsconfig.json', 'tsup.config.ts', 'jest.config.cjs', 'dist/x.tsbuildinfo', 'lib/extra.ts', 'dist/types.d.mts'];
    expect(packProblems({ name: '@ironbird/core', manifest: coreManifest, files })).toEqual([
      'src/index.ts should not ship (a source, test, or script folder)',
      'dist/index.test.js should not ship (a test file)',
      'tsconfig.json should not ship (a tsconfig)',
      'tsup.config.ts should not ship (a tool config)',
      'jest.config.cjs should not ship (a tool config)',
      'dist/x.tsbuildinfo should not ship (a TypeScript build cache)',
      'lib/extra.ts should not ship (TypeScript source)',
    ]);
  });

  it('requires ESM and CommonJS entries with declarations where the package publishes both', () => {
    const manifest = { ...coreManifest, exports: { '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } } } };
    expect(packProblems({ name: '@ironbird/core', manifest, files: coreFiles })).toEqual(['exports["."].require.types is missing', 'exports["."].require.default is missing']);
  });

  it("checks the CLI's dual subpaths but not its ESM-only main entry, and accepts the bin-only wrapper", () => {
    const cli = {
      name: '@ironbird/cli',
      license: 'MIT',
      exports: { '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } }, './config': dual('config-entry'), './runner': dual('runner'), './bin': './dist/bin.js' },
      bin: { ironbird: './dist/bin.js' },
    };
    const files = ['LICENSE', 'README.md', 'package.json', 'dist/index.d.ts', 'dist/index.js', 'dist/bin.js', 'skills/ironbird/SKILL.md'];
    for (const base of ['config-entry', 'runner']) files.push(`dist/${base}.js`, `dist/${base}.cjs`, `dist/${base}.d.ts`, `dist/${base}.d.cts`);
    expect(packProblems({ name: '@ironbird/cli', manifest: cli, files })).toEqual([]);
    const wrapper = { name: 'ironbird', license: 'MIT', bin: { ironbird: './bin.js' } };
    expect(packProblems({ name: 'ironbird', manifest: wrapper, files: ['LICENSE', 'README.md', 'package.json', 'bin.js'] })).toEqual([]);
  });
});

describe('manifestProblems', () => {
  const internal = EXPECTED_PUBLISHED;

  it('passes released manifests', () => {
    expect(manifestProblems({ manifest: coreManifest, internal, expectVersion: '0.1.0' })).toEqual([]);
    const cli = { name: '@ironbird/cli', version: '0.1.0', license: 'MIT', dependencies: { '@ironbird/core': '0.1.0', zod: '^4.2.0' } };
    expect(manifestProblems({ manifest: cli, internal, expectVersion: '0.1.0' })).toEqual([]);
  });

  it('names the license, the version, a stale internal dependency, an exact internal peer pin, and workspace ranges', () => {
    const manifest = { name: '@ironbird/redux', version: '0.0.9', license: 'ISC', dependencies: { '@ironbird/core': '0.0.3' }, peerDependencies: { '@ironbird/core': '0.1.0', zod: 'workspace:*' } };
    expect(manifestProblems({ manifest, internal, expectVersion: '0.1.0' })).toEqual([
      'license is ISC, not MIT',
      'version is 0.0.9, not 0.1.0',
      'dependencies.@ironbird/core is 0.0.3, not 0.1.0',
      'peerDependencies.@ironbird/core pins exactly 0.1.0; use a range',
      'peerDependencies.zod is still workspace:*',
      'peerDependencies.zod is workspace:*, not ^4.2.0 (M5 design D9)',
    ]);
  });

  it('requires the zod ^4.2.0 peer on core, the adapters, and the testing package, and on nothing else', () => {
    expect(manifestProblems({ manifest: { name: '@ironbird/xstate', license: 'MIT', peerDependencies: { zod: '^4.0.0' } }, internal })).toEqual(['peerDependencies.zod is ^4.0.0, not ^4.2.0 (M5 design D9)']);
    expect(manifestProblems({ manifest: { name: '@ironbird/react-native', license: 'MIT' }, internal })).toEqual([]);
  });
});

describe('publishedProblems', () => {
  it('names a package that would publish unexpectedly and an expected one that would not', () => {
    expect(publishedProblems(EXPECTED_PUBLISHED)).toEqual([]);
    const names = [...EXPECTED_PUBLISHED.filter((name) => name !== '@ironbird/xstate'), '@ironbird/mobx'];
    expect(publishedProblems(names)).toEqual([
      '@ironbird/mobx would be published but is not in EXPECTED_PUBLISHED',
      '@ironbird/xstate is expected to publish but no public package has that name',
    ]);
  });
});
