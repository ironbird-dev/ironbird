import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pickTarballs, standaloneManifest, standaloneTsconfig, VITEST_CONFIG } from './manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, '../..');
const repo = path.resolve(example, '../..');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const TARBALLS = { core: 'ironbird-core-0.0.4.tgz', reactNative: 'ironbird-react-native-0.0.3.tgz', cli: 'ironbird-cli-0.0.4.tgz' };

describe('pickTarballs', () => {
  it('finds the three tarballs and ignores other files', () => {
    expect(pickTarballs(['README', 'ironbird-cli-0.0.4.tgz', 'ironbird-core-0.0.4.tgz', 'ironbird-react-native-0.0.3.tgz'])).toEqual(TARBALLS);
  });

  it('fails on a missing or doubled tarball', () => {
    expect(() => pickTarballs(['ironbird-core-0.0.4.tgz', 'ironbird-cli-0.0.4.tgz'])).toThrow('ironbird-react-native-');
    expect(() => pickTarballs(['ironbird-core-0.0.3.tgz', ...Object.values(TARBALLS)])).toThrow('found 2');
  });
});

describe('standaloneManifest', () => {
  it('rewrites the real example manifest into one npm can install outside the workspace', async () => {
    const root = await readJson(path.join(repo, 'package.json'));
    const versions = { vitest: root.devDependencies.vitest, typescript: root.devDependencies.typescript, typesNode: root.devDependencies['@types/node'] };
    const manifest = standaloneManifest(await readJson(path.join(example, 'package.json')), { tarballs: TARBALLS, versions });
    expect(JSON.stringify(manifest)).not.toContain('workspace:');
    expect(manifest.name).toBe('checkout');
    expect(manifest.scripts.test).toBe('vitest run');
    expect(manifest.scripts.measure).toBeUndefined();
    expect(manifest.scripts['start:ios']).toBeUndefined();
    expect(manifest.scripts['start:android']).toBeUndefined();
    expect(manifest.scripts.start).toBe('expo start');
    expect(manifest.dependencies['@ironbird/core']).toBe('file:vendor/ironbird-core-0.0.4.tgz');
    expect(manifest.dependencies['@ironbird/react-native']).toBe('file:vendor/ironbird-react-native-0.0.3.tgz');
    expect(manifest.devDependencies['@ironbird/cli']).toBe('file:vendor/ironbird-cli-0.0.4.tgz');
    expect(manifest.devDependencies.vitest).toBe(root.devDependencies.vitest);
    expect(manifest.devDependencies.typescript).toBe(root.devDependencies.typescript);
    expect(manifest.devDependencies['@ironbird/testing']).toBeUndefined();
    expect(manifest.devDependencies.pngjs).toBeUndefined();
    expect(manifest.devDependencies['@types/pngjs']).toBeUndefined();
    expect(manifest.overrides).toEqual({ '@ironbird/core': '$@ironbird/core', '@ironbird/react-native': '$@ironbird/react-native' });
    expect(manifest.dependencies.expo).toBeDefined();
  });

  it('adds pins to overrides next to the tarball overrides', () => {
    const example = { scripts: {}, dependencies: {}, devDependencies: {} };
    const manifest = standaloneManifest(example, { tarballs: TARBALLS, versions: { vitest: '1', typescript: '1', typesNode: '1' }, pins: { 'react-native-screens': '4.18.0' } });
    expect(manifest.overrides).toEqual({ 'react-native-screens': '4.18.0', '@ironbird/core': '$@ironbird/core', '@ironbird/react-native': '$@ironbird/react-native' });
  });

  it('refuses a manifest that would keep a workspace dependency', () => {
    const example = { scripts: {}, dependencies: { '@ironbird/extra': 'workspace:*' }, devDependencies: {} };
    expect(() => standaloneManifest(example, { tarballs: TARBALLS, versions: { vitest: '1', typescript: '1', typesNode: '1' } })).toThrow('@ironbird/extra');
  });
});

describe('standaloneTsconfig', () => {
  it('inlines the base options, keeps the example overrides, and drops extends and test/', async () => {
    const tsconfig = standaloneTsconfig(await readJson(path.join(example, 'tsconfig.json')), await readJson(path.join(repo, 'tsconfig.base.json')));
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions).toMatchObject({ strict: true, moduleResolution: 'Bundler', jsx: 'react-jsx', noEmit: true });
    expect(tsconfig.include).not.toContain('test/**/*.ts');
    expect(tsconfig.include).toContain('src/**/*.ts');
  });

  it('writes a Vitest config that runs src tests and never device tests', () => {
    expect(VITEST_CONFIG).toContain("include: ['src/**/*.test.ts']");
    expect(VITEST_CONFIG).toContain('*.device.test.ts');
  });
});
