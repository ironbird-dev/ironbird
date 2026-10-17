import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourcesState, templateStaleness } from './freshness.mjs';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const clean = { head: HEAD, dirty: [], fingerprint: 'f0' };

describe('templateStaleness', () => {
  const now = { changed: [], fingerprint: 'f0', dirty: [] };

  it('accepts a template prepared from clean sources that have not changed since', () => {
    expect(templateStaleness({ prepared: { repo: clean }, label: 'proxy', ...now })).toEqual([]);
    expect(templateStaleness({ prepared: { repo: clean }, label: 'smoke', ...now })).toEqual([]);
  });

  it('refuses a prepare.json without a commit or without a fingerprint', () => {
    expect(templateStaleness({ prepared: null, label: 'smoke', ...now })).toEqual(['prepare.json records no commit; run prepare.mjs again']);
    expect(templateStaleness({ prepared: { repo: { head: HEAD, dirty: [] } }, label: 'smoke', ...now })).toEqual(['prepare.json records no fingerprint of its sources; run prepare.mjs again']);
  });

  it('refuses when sources were committed since, or git cannot compare', () => {
    expect(templateStaleness({ prepared: { repo: clean }, label: 'smoke', ...now, changed: ['packages/cli/src/a.ts'] })[0]).toMatch(/prepared at abcdef0 and 1 file\(s\) .* changed since: packages\/cli\/src\/a.ts/);
    expect(templateStaleness({ prepared: { repo: clean }, label: 'smoke', ...now, changed: null })[0]).toMatch(/cannot compare the prepared commit abcdef0/);
  });

  it('refuses, for either label, when uncommitted edits to the sources were made after prepare', () => {
    const edited = { ...now, fingerprint: 'f1', dirty: [' M docs/api.md', '?? packages/cli/src/new.ts'] };
    for (const label of ['proxy', 'smoke']) {
      const problems = templateStaleness({ prepared: { repo: clean }, label, ...edited });
      expect(problems.some((problem) => problem.includes('changed since prepare.mjs ran') && problem.includes('docs/api.md, packages/cli/src/new.ts'))).toBe(true);
    }
  });

  it('lets a smoke session use a template prepared from uncommitted sources that are still exactly as prepared', () => {
    const dirty = { head: HEAD, dirty: [' M docs/api.md'], fingerprint: 'f9' };
    expect(templateStaleness({ prepared: { repo: dirty }, label: 'smoke', changed: [], fingerprint: 'f9', dirty: [' M docs/api.md'] })).toEqual([]);
  });

  it('refuses a proxy session when the sources were uncommitted at prepare or are uncommitted now', () => {
    const dirty = { head: HEAD, dirty: [' M docs/api.md'], fingerprint: 'f9' };
    const atPrepare = templateStaleness({ prepared: { repo: dirty }, label: 'proxy', changed: [], fingerprint: 'f9', dirty: [' M docs/api.md'] });
    expect(atPrepare.some((problem) => problem.includes('prepared with uncommitted changes (docs/api.md)'))).toBe(true);
    expect(atPrepare.some((problem) => problem.includes('uncommitted changes now (docs/api.md)'))).toBe(true);
  });
});

describe('sourcesState', () => {
  let repo;
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'ironbird-freshness-'));
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'a.md'), 'one\n');
    await writeFile(path.join(repo, 'outside.md'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('is clean with a stable fingerprint when nothing under the sources changed', async () => {
    const first = await sourcesState(repo, ['a.md', 'src']);
    await writeFile(path.join(repo, 'outside.md'), 'changed\n');
    expect(first.dirty).toEqual([]);
    expect(await sourcesState(repo, ['a.md', 'src'])).toEqual(first);
  });

  it('changes its fingerprint on every tracked or untracked edit under the sources, even when the status lines stay the same', async () => {
    const before = await sourcesState(repo, ['a.md', 'src']);
    await writeFile(path.join(repo, 'a.md'), 'two\n');
    const tracked = await sourcesState(repo, ['a.md', 'src']);
    expect(tracked.dirty).toEqual([' M a.md']);
    expect(tracked.fingerprint).not.toBe(before.fingerprint);
    await writeFile(path.join(repo, 'a.md'), 'three\n');
    expect((await sourcesState(repo, ['a.md', 'src'])).fingerprint).not.toBe(tracked.fingerprint);

    await execFileSync('mkdir', ['-p', path.join(repo, 'src')]);
    await writeFile(path.join(repo, 'src', 'new.ts'), 'a\n');
    const untracked = await sourcesState(repo, ['a.md', 'src']);
    expect(untracked.dirty).toEqual([' M a.md', '?? src/new.ts']);
    await writeFile(path.join(repo, 'src', 'new.ts'), 'b\n');
    const edited = await sourcesState(repo, ['a.md', 'src']);
    expect(edited.dirty).toEqual(untracked.dirty);
    expect(edited.fingerprint).not.toBe(untracked.fingerprint);
  });
});
