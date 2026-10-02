import { IronbirdError } from '@ironbird/core';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentSetup, findPackageRoot } from './setup';

const ENTRY = { command: 'npx', args: ['ironbird', 'mcp'] };
const SKILL_V2 = '---\nname: ironbird\ndescription: v2\n---\n';

describe('agentSetup', () => {
  let root: string;
  let project: string;
  let pkg: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ironbird-agent-'));
    project = path.join(root, 'project');
    pkg = path.join(root, 'pkg');
    await mkdir(project);
    await mkdir(path.join(pkg, 'skills/ironbird/references'), { recursive: true });
    await writeFile(path.join(pkg, 'skills/ironbird/SKILL.md'), SKILL_V2);
    await writeFile(path.join(pkg, 'skills/ironbird/references/scenarios.md'), '# Scenarios v2\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const read = (file: string): Promise<string> => readFile(path.join(project, file), 'utf8');

  it('installs the skill and creates .mcp.json in a fresh project', async () => {
    expect(await agentSetup({ cwd: project, packageRoot: pkg })).toEqual({
      skill: { dir: path.join(project, '.claude/skills/ironbird'), files: ['SKILL.md', 'references/scenarios.md'] },
      mcp: { file: path.join(project, '.mcp.json'), updated: true },
    });
    expect(await read('.claude/skills/ironbird/SKILL.md')).toBe(SKILL_V2);
    expect(await read('.claude/skills/ironbird/references/scenarios.md')).toBe('# Scenarios v2\n');
    expect(await read('.mcp.json')).toBe(`${JSON.stringify({ mcpServers: { ironbird: ENTRY } }, null, 2)}\n`);
  });

  it('keeps other servers and keys, replaces only the ironbird entry, and leaves files it does not own alone', async () => {
    await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other-mcp' }, ironbird: { command: 'node', args: ['old.js'] } }, extra: true }));
    await mkdir(path.join(project, '.claude/skills/ironbird'), { recursive: true });
    await writeFile(path.join(project, '.claude/skills/ironbird/SKILL.md'), 'old skill');
    await writeFile(path.join(project, '.claude/skills/ironbird/NOTES.md'), 'mine');
    expect((await agentSetup({ cwd: project, packageRoot: pkg })).mcp.updated).toBe(true);
    expect(JSON.parse(await read('.mcp.json'))).toEqual({ mcpServers: { other: { command: 'other-mcp' }, ironbird: ENTRY }, extra: true });
    expect((await read('.mcp.json')).endsWith('}\n')).toBe(true);
    expect(await read('.claude/skills/ironbird/SKILL.md')).toBe(SKILL_V2);
    expect(await read('.claude/skills/ironbird/NOTES.md')).toBe('mine');
  });

  it('run again, updates the skill and reports updated false without rewriting an identical entry', async () => {
    await agentSetup({ cwd: project, packageRoot: pkg });
    const byHand = '{"mcpServers":{"ironbird":{"command":"npx","args":["ironbird","mcp"]}}}';
    await writeFile(path.join(project, '.mcp.json'), byHand);
    await writeFile(path.join(pkg, 'skills/ironbird/SKILL.md'), '---\nname: ironbird\ndescription: v3\n---\n');
    const again = await agentSetup({ cwd: project, packageRoot: pkg });
    expect(again.mcp.updated).toBe(false);
    expect(await read('.mcp.json')).toBe(byHand);
    expect(await read('.claude/skills/ironbird/SKILL.md')).toContain('v3');
  });

  it('puts the skill under skillsDir, relative to the project or absolute', async () => {
    const relative = await agentSetup({ cwd: project, packageRoot: pkg, skillsDir: '.agents/skills' });
    expect(relative.skill.dir).toBe(path.join(project, '.agents/skills/ironbird'));
    expect(await read('.agents/skills/ironbird/SKILL.md')).toBe(SKILL_V2);
    const elsewhere = path.join(root, 'shared-skills');
    const absolute = await agentSetup({ cwd: project, packageRoot: pkg, skillsDir: elsewhere });
    expect(absolute.skill.dir).toBe(path.join(elsewhere, 'ironbird'));
    expect(await readFile(path.join(elsewhere, 'ironbird/SKILL.md'), 'utf8')).toBe(SKILL_V2);
  });

  it.each<[string, string, string[]]>([
    ['not JSON', '{ "mcpServers": ', []],
    ['empty', '', []],
    ['an array', '[]', []],
    ['null', 'null', []],
    ['holding a list of servers', '{"mcpServers":[]}', ['mcpServers']],
  ])('fails with INVALID_CONFIG and writes nothing when .mcp.json is %s', async (_label, content, issuePath) => {
    await writeFile(path.join(project, '.mcp.json'), content);
    await expect(agentSetup({ cwd: project, packageRoot: pkg })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { file: path.join(project, '.mcp.json'), issues: [{ path: issuePath }] },
    });
    expect(await read('.mcp.json')).toBe(content);
    await expect(stat(path.join(project, '.claude'))).rejects.toThrow();
  });

  it('fails with INTERNAL naming the folder when the package has no skill', async () => {
    const empty = path.join(root, 'empty-pkg');
    await expect(agentSetup({ cwd: project, packageRoot: empty })).rejects.toMatchObject({ code: 'INTERNAL', details: { file: path.join(empty, 'skills', 'ironbird') } });
    await expect(stat(path.join(project, '.mcp.json'))).rejects.toThrow();
  });

  it('turns an unwritable skill folder into an IronbirdError naming the file, and leaves .mcp.json untouched', async () => {
    // A regular file where a folder must go fails mkdir on every platform, even when run as root.
    await writeFile(path.join(project, 'blocker'), 'not a folder');
    const attempt = agentSetup({ cwd: project, packageRoot: pkg, skillsDir: 'blocker/skills' });
    await expect(attempt).rejects.toBeInstanceOf(IronbirdError);
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL', details: { file: path.join(project, 'blocker/skills/ironbird/SKILL.md'), message: expect.any(String) } });
    await expect(stat(path.join(project, '.mcp.json'))).rejects.toThrow();
  });
});

describe('findPackageRoot', () => {
  it('walks up to the @ironbird/cli package', async () => {
    expect(await findPackageRoot(__dirname)).toBe(path.resolve(__dirname, '../..'));
  });

  it('fails with INTERNAL outside the package', async () => {
    await expect(findPackageRoot(tmpdir())).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
