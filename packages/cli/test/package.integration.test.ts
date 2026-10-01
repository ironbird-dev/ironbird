import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Spec §8, packaging: `agent setup` copies the skill from the installed package, so it must be in
// the tarball users install, not only in the repository.
const exec = promisify(execFile);
const cli = path.resolve(__dirname, '..');

describe('the packed @ironbird/cli', () => {
  let dir: string | undefined;

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('ships the ironbird skill with front matter that parses', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-pack-'));
    await exec('pnpm', ['pack', '--pack-destination', dir], { cwd: cli });
    const tarball = (await readdir(dir)).find((name) => name.endsWith('.tgz'));
    if (!tarball) throw new Error(`pnpm pack wrote no tarball to ${dir}`);
    const { stdout: listing } = await exec('tar', ['-tzf', path.join(dir, tarball)]);
    const files = listing.split('\n');
    expect(files).toContain('package/skills/ironbird/SKILL.md');
    expect(files).toContain('package/skills/ironbird/references/scenarios.md');

    const { stdout: skill } = await exec('tar', ['-xOzf', path.join(dir, tarball), 'package/skills/ironbird/SKILL.md']);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(match).not.toBeNull();
    const front = parse(match?.[1] ?? '') as Record<string, unknown>;
    expect(front['name']).toBe('ironbird');
    expect(typeof front['description']).toBe('string');
  }, 60_000);
});
