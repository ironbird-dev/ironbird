import { isIronbirdError } from '@ironbird/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTypeScriptModule } from './bundle';

const fixtures = path.resolve(__dirname, '../test/fixtures');
let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'ironbird-bundle-'));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('loadTypeScriptModule', () => {
  it('bundles TypeScript, honors tsconfig paths, and returns the module namespace', async () => {
    const loaded = await loadTypeScriptModule(path.join(fixtures, 'good/entry.ts'), { outDir, label: 'good' });
    expect(loaded.exports['default']).toEqual({ answer: 42 });
    expect(loaded.exports['named']).toBe('ok');
    expect(loaded.bundlePath.startsWith(outDir)).toBe(true);
  });

  it('reloads fresh on every call', async () => {
    const first = await loadTypeScriptModule(path.join(fixtures, 'good/entry.ts'), { outDir, label: 'good' });
    const second = await loadTypeScriptModule(path.join(fixtures, 'good/entry.ts'), { outDir, label: 'good' });
    expect(first.exports).not.toBe(second.exports);
  });

  it('fails with HEADLESS_LOAD_FAILED and the import chain when a forbidden module is imported', async () => {
    const error = await loadTypeScriptModule(path.join(fixtures, 'bad/entry.ts'), { outDir, label: 'bad', forbidden: ['react-native'] }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('HEADLESS_LOAD_FAILED');
    expect(isIronbirdError(error) && error.details).toEqual({
      entry: path.join(fixtures, 'bad/entry.ts'),
      message: 'react-native is imported in the headless graph',
      importChain: ['entry.ts', 'pricing.ts', 'react-native'],
    });
  });

  it('fails with HEADLESS_LOAD_FAILED on a syntax error', async () => {
    const error = await loadTypeScriptModule(path.join(fixtures, 'syntax/entry.ts'), { outDir, label: 'syntax' }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('HEADLESS_LOAD_FAILED');
    expect(isIronbirdError(error) && (error.details as { message: string }).message).toMatch(/Expected|Unexpected/);
  });

  it('substitutes shims for bare specifiers so config files never need the built CLI', async () => {
    const loaded = await loadTypeScriptModule(path.join(fixtures, 'config/ironbird.config.ts'), {
      outDir,
      label: 'config',
      shims: { '@ironbird/cli/config': 'export const defineConfig = (config) => config;' },
    });
    expect(loaded.exports['default']).toEqual({ headless: './src/ironbird/headless.ts', appId: 'com.example.fixture', clock: { start: '2026-01-01T00:00:00.000Z' } });
  });
});
