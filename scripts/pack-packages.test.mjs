import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packPackages } from './pack-packages.mjs';

describe('packPackages', () => {
  it('refuses a name that is not a published ironbird package, before packing anything', () => {
    expect(() => packPackages(['core', 'checkout'], path.join(os.tmpdir(), 'ironbird-never-created'))).toThrow(
      'Unknown package checkout; expected one of core, react-native, redux, xstate, cli, testing',
    );
  });

  it('packs the bridge with real versions in place of workspace ranges', async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'ironbird-pack-'));
    try {
      const [tarball, ...rest] = packPackages(['react-native'], out);
      expect(rest).toEqual([]);
      expect(path.basename(tarball)).toMatch(/^ironbird-react-native-\d+\.\d+\.\d+\.tgz$/);
      const manifest = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout;
      expect(JSON.parse(manifest)).toMatchObject({ name: '@ironbird/react-native' });
      expect(manifest).not.toContain('workspace:');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);
});
