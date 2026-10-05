import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changedSince, TEMPLATE_SOURCES, templateFreshness } from './freshness.mjs';
import { must } from './proc.mjs';

const HEAD = 'e96f010f37981d4a81e1271027c86c49b74ccc12';
const prepared = (repo) => ({ preparedAt: '2026-10-03T22:09:02.311Z', repo });

describe('templateFreshness', () => {
  it('passes a template prepared at a commit whose template sources match HEAD', () => {
    expect(templateFreshness({ prepared: prepared({ head: HEAD, dirty: [] }), changed: [], label: 'gate' })).toEqual([]);
  });

  it('refuses a template prepared before a committed change to a file it is built from', () => {
    expect(templateFreshness({ prepared: prepared({ head: HEAD, dirty: [] }), changed: ['packages/cli/skills/ironbird/SKILL.md', 'examples/checkout/eval/grade.mjs'], label: 'pilot' })).toEqual([
      'the template was prepared at e96f010 and 2 file(s) it is built from changed since: packages/cli/skills/ironbird/SKILL.md, examples/checkout/eval/grade.mjs; run prepare.mjs again',
    ]);
  });

  it('refuses when there is no prepare record or the commits cannot be compared', () => {
    expect(templateFreshness({ prepared: null, changed: [], label: 'gate' })).toEqual(['prepare.json records no commit; run prepare.mjs again']);
    expect(templateFreshness({ prepared: prepared({ head: HEAD, dirty: [] }), changed: null, label: 'gate' })).toEqual([
      'cannot compare the prepared commit e96f010 with HEAD; run prepare.mjs again',
    ]);
  });

  it('refuses a gate session on a template prepared with uncommitted changes to its sources, but not a pilot', () => {
    const dirty = prepared({ head: HEAD, dirty: [' M packages/cli/skills/ironbird/SKILL.md', '?? docs/notes.md', 'R  examples/checkout/a.ts -> examples/checkout/b.ts'] });
    expect(templateFreshness({ prepared: dirty, changed: [], label: 'gate' })).toEqual([
      'the template was prepared with uncommitted changes to packages/cli/skills/ironbird/SKILL.md, examples/checkout/b.ts; commit them and run prepare.mjs again',
    ]);
    expect(templateFreshness({ prepared: dirty, changed: [], label: 'pilot' })).toEqual([]);
  });
});

describe('changedSince', () => {
  let repo;
  const git = (...args) => must('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo });
  const commit = async (file, text) => {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), text);
    await git('add', '-A');
    await git('commit', '-q', '-m', `edit ${file}`);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-freshness-'));
    await git('init', '-q', '-b', 'main');
  });
  afterAll(() => rm(repo, { recursive: true, force: true }));

  it('lists the template sources changed between a commit and HEAD, ignoring everything else', async () => {
    const preparedAt = await commit('packages/cli/skills/ironbird/SKILL.md', 'v1\n');
    expect(await changedSince(repo, preparedAt)).toEqual([]);
    await commit('docs/evals/record.md', 'notes\n');
    expect(await changedSince(repo, preparedAt)).toEqual([]);
    await commit('packages/cli/skills/ironbird/SKILL.md', 'v2\n');
    expect(await changedSince(repo, preparedAt)).toEqual(['packages/cli/skills/ironbird/SKILL.md']);
    const prepared = { repo: { head: preparedAt, dirty: [] } };
    expect(templateFreshness({ prepared, changed: await changedSince(repo, preparedAt), label: 'gate' })[0]).toMatch(/run prepare\.mjs again$/);
  });

  it('returns null for a commit it cannot find', async () => {
    expect(await changedSince(repo, '0123456789abcdef0123456789abcdef01234567')).toBeNull();
  });

  it('covers the fixture, the harness, the packed packages, and the root build inputs', () => {
    expect(TEMPLATE_SOURCES).toEqual(['examples/checkout', 'packages', 'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json']);
  });
});
