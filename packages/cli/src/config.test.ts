import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findConfigFile, loadConfig } from './config';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns defaults with rootDir = cwd when no config file exists', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-config-'));
    const config = await loadConfig({ cwd: dir });
    expect(config).toMatchObject({
      rootDir: dir,
      configPath: undefined,
      headlessPath: undefined,
      defaultTarget: undefined,
      appId: 'app',
      daemon: { host: '127.0.0.1', port: 4567 },
      bridge: { port: 4568 },
      settle: { timeoutMs: 5_000 },
      scenarios: 'ironbird/scenarios',
      artifactsDir: '.ironbird',
      artifactsPath: path.join(dir, '.ironbird'),
    });
  });

  it('finds the nearest ironbird.config.ts walking up, loads it, and resolves paths against it', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-config-'));
    await mkdir(path.join(dir, 'src/deep'), { recursive: true });
    await writeFile(
      path.join(dir, 'ironbird.config.ts'),
      `import { defineConfig } from '@ironbird/cli/config';
export default defineConfig({ headless: './src/ironbird/headless.ts', appId: 'com.example.app', clock: { start: '2026-01-01T00:00:00.000Z' }, artifactsDir: 'out' });`,
    );
    expect(await findConfigFile(path.join(dir, 'src/deep'))).toBe(path.join(dir, 'ironbird.config.ts'));
    const config = await loadConfig({ cwd: path.join(dir, 'src/deep') });
    expect(config.rootDir).toBe(dir);
    expect(config.configPath).toBe(path.join(dir, 'ironbird.config.ts'));
    expect(config.headlessPath).toBe(path.join(dir, 'src/ironbird/headless.ts'));
    expect(config.defaultTarget).toBe('headless');
    expect(config.appId).toBe('com.example.app');
    expect(config.clock.start).toBe('2026-01-01T00:00:00.000Z');
    expect(config.artifactsPath).toBe(path.join(dir, 'out'));
  });

  it('rejects invalid config values with a clear message', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-config-'));
    await writeFile(path.join(dir, 'ironbird.config.ts'), `export default { daemon: { port: 'eighty' } };`);
    await expect(loadConfig({ cwd: dir })).rejects.toThrow(/daemon\.port/);
  });
});
