import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addedScenarios, ancestorInstructionFiles, isInside, listFiles, scenarioFiles } from './tree.mjs';

const made = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tree(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-tree-'));
  made.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), content);
  }
  return dir;
}

describe('tree helpers', () => {
  it('lists files with forward slashes and skips dependencies, git, artifacts, and caches', async () => {
    const dir = await tree({ 'src/a.ts': 'a', 'node_modules/x/index.js': 'x', '.git/HEAD': 'h', '.ironbird/runs/r/result.json': '{}', '.expo/cache': 'c', 'README.md': 'r' });
    expect(await listFiles(dir)).toEqual(['README.md', 'src/a.ts']);
  });

  it('finds scenario files at any depth with either extension, and treats only new paths as added', async () => {
    const template = await tree({ 'ironbird/scenarios/happy.yaml': 'h' });
    const session = await tree({ 'ironbird/scenarios/happy.yaml': 'edited', 'ironbird/scenarios/bugs/zero.yml': 'z', 'ironbird/scenarios/notes.md': 'n' });
    const mine = await scenarioFiles(session);
    expect(mine).toEqual(['ironbird/scenarios/bugs/zero.yml', 'ironbird/scenarios/happy.yaml']);
    expect(addedScenarios(mine, await scenarioFiles(template))).toEqual(['ironbird/scenarios/bugs/zero.yml']);
    expect(await scenarioFiles(await tree({ 'src/a.ts': 'a' }))).toEqual([]);
  });

  it('finds AGENTS.md and CLAUDE.md in a folder and its ancestors', async () => {
    const dir = await tree({ 'AGENTS.md': '#', 'a/CLAUDE.md': '#', 'a/b/c/keep': '' });
    const found = await ancestorInstructionFiles(path.join(dir, 'a/b/c'));
    expect(found).toContain(path.join(dir, 'AGENTS.md'));
    expect(found).toContain(path.join(dir, 'a/CLAUDE.md'));
  });

  it('knows what is inside a folder', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
  });
});
