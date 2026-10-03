import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baselineFromInit, checkBaseline, checkIsolation, userSkillNames } from './isolation.mjs';
import { MODEL_PATTERN } from './paths.mjs';

/** What `--model sonnet` resolves to on Claude Code 2.1.283. */
const MODEL_ID = 'claude-sonnet-5';
const MODEL = MODEL_PATTERN;
const BUILTIN = [
  { name: 'agents-md', source: 'agents-md@builtin' },
  { name: 'telemetry', source: 'telemetry@builtin' },
];
const baselineInit = { type: 'system', subtype: 'init', model: MODEL_ID, mcp_servers: [], skills: ['verify', 'debug', 'code-review'], plugins: BUILTIN, memory_paths: { auto: '/Users/dev/.claude/projects/-x-baseline/memory' } };
const baseline = baselineFromInit(baselineInit, '2.1.283 (Claude Code)');

/** Directory names in ~/.claude/skills: skills with these names come from the user, not from Claude Code. */
const USER_SKILLS = ['aws-cdk', 'synced'];
const check = (init, overrides = {}) => checkIsolation(init, { memoryEntries: [], model: MODEL, userSkills: USER_SKILLS, ...overrides });

const sessionInit = (overrides = {}) => ({
  type: 'system',
  subtype: 'init',
  model: MODEL_ID,
  mcp_servers: [{ name: 'ironbird', status: 'connected' }],
  skills: ['verify', 'debug', 'code-review', 'ironbird'],
  plugins: BUILTIN,
  memory_paths: { auto: '/Users/dev/.claude/projects/-x-sessions-1-project/memory' },
  ...overrides,
});

describe('baseline', () => {
  it('records the bundled skills sorted, the plugins, and no MCP servers, and passes its own check', () => {
    expect(baseline).toMatchObject({ claudeVersion: '2.1.283 (Claude Code)', model: MODEL_ID, skills: ['code-review', 'debug', 'verify'], plugins: BUILTIN, mcpServers: [] });
    expect(checkBaseline(baseline, MODEL)).toEqual([]);
  });

  it('rejects a baseline with an MCP server, a user plugin, no skills, or the wrong model', () => {
    const bad = baselineFromInit({ ...baselineInit, model: 'claude-fable-5', mcp_servers: [{ name: 'slack' }], skills: [], plugins: [...BUILTIN, { name: 'superpowers', source: 'superpowers@claude-plugins-official' }] }, 'x');
    expect(checkBaseline(bad, MODEL)).toHaveLength(4);
    expect(checkBaseline(bad, MODEL)).toContain('the baseline session ran on claude-fable-5, not a model matching /^claude-sonnet-/');
  });

  it('accepts any Sonnet id the alias resolves to, and nothing else', () => {
    for (const id of ['claude-sonnet-5', 'claude-sonnet-5-5']) expect(checkBaseline({ ...baseline, model: id }, MODEL)).toEqual([]);
    for (const id of ['sonnet', 'claude-opus-5', null]) expect(checkBaseline({ ...baseline, model: id }, MODEL)).toHaveLength(1);
  });

  it('takes the model as a pattern, never a bare id', () => {
    expect(() => checkBaseline(baseline, 'claude-sonnet-5')).toThrow(TypeError);
    expect(() => checkIsolation(sessionInit(), { memoryEntries: [], model: 'sonnet', userSkills: [] })).toThrow(TypeError);
  });

  it('requires the user skill names, so a missing list cannot pass a session', () => {
    expect(() => checkIsolation(sessionInit(), { memoryEntries: [], model: MODEL })).toThrow(TypeError);
  });
});

describe('checkIsolation', () => {
  it('accepts bundled skills, built-in plugins, the ironbird skill and server, a Sonnet model, and an empty memory folder', () => {
    expect(check(sessionInit())).toEqual({ valid: true, problems: [] });
  });

  it('accepts skills reported as objects with a name', () => {
    const init = sessionInit({ skills: [{ name: 'verify' }, { name: 'ironbird' }], mcp_servers: [{ name: 'ironbird', status: 'connected' }] });
    expect(check(init).valid).toBe(true);
  });

  it('accepts bundled skills and built-in plugins that are not in the baseline: the built-in set varies between runs', () => {
    const init = sessionInit({
      skills: ['verify', 'plugin-authoring', 'some-new-bundled-skill', 'ironbird'],
      plugins: [...BUILTIN, { name: 'plugin-authoring', path: 'builtin', source: 'plugin-authoring@builtin' }],
    });
    expect(check(init)).toEqual({ valid: true, problems: [] });
  });

  it('rejects a skill named like a folder in ~/.claude/skills, or a plugin-namespaced skill', () => {
    const init = sessionInit({ skills: ['verify', 'ironbird', 'synced', 'superpowers:brainstorming', 'aws-cdk'] });
    expect(check(init).problems).toEqual([
      'skill synced is loaded, and the user skills folder has a skill of that name',
      'skill superpowers:brainstorming is loaded from a plugin',
      'skill aws-cdk is loaded, and the user skills folder has a skill of that name',
    ]);
  });

  it('rejects a plugin whose source is missing or not built in', () => {
    const init = sessionInit({ plugins: [...BUILTIN, { name: 'odd' }, 'codex@openai-codex', 'tool@builtin'] });
    expect(check(init).problems).toEqual(['plugin {"name":"odd"} is not built in', 'plugin "codex@openai-codex" is not built in']);
  });

  it('reports every leak at once: a user skill, another MCP server, a user plugin, memory, the wrong model', () => {
    const init = sessionInit({
      model: 'claude-fable-5',
      skills: ['verify', 'ironbird', 'superpowers:brainstorming'],
      mcp_servers: [{ name: 'ironbird', status: 'connected' }, { name: 'context7', status: 'connected' }],
      plugins: [...BUILTIN, { name: 'codex', source: 'codex@openai-codex' }],
    });
    const { valid, problems } = check(init, { memoryEntries: ['MEMORY.md'] });
    expect(valid).toBe(false);
    expect(problems).toEqual([
      'MCP server context7 is loaded',
      'skill superpowers:brainstorming is loaded from a plugin',
      'plugin {"name":"codex","source":"codex@openai-codex"} is not built in',
      'the auto-memory folder /Users/dev/.claude/projects/-x-sessions-1-project/memory is not empty: MEMORY.md',
      'the session runs on claude-fable-5, not a model matching /^claude-sonnet-/',
    ]);
  });

  it('is invalid when the ironbird server or skill is missing or the server failed to connect', () => {
    expect(check(sessionInit({ mcp_servers: [], skills: ['verify'] })).problems).toEqual([
      'the ironbird MCP server is not loaded',
      'the ironbird skill is not loaded',
    ]);
    expect(check(sessionInit({ mcp_servers: [{ name: 'ironbird', status: 'failed' }] })).problems).toEqual([
      'the ironbird MCP server is failed',
    ]);
  });

  it('requires the ironbird server to be reported as connected: a bare name or a missing status is a problem', () => {
    expect(check(sessionInit({ mcp_servers: ['ironbird'] })).problems).toEqual([
      'the ironbird MCP server is not reported as connected',
    ]);
    expect(check(sessionInit({ mcp_servers: [{ name: 'ironbird' }] })).problems).toEqual([
      'the ironbird MCP server is not reported as connected',
    ]);
    expect(check(sessionInit({ mcp_servers: [{ name: 'ironbird', status: 'pending' }] })).problems).toEqual([
      'the ironbird MCP server is pending',
    ]);
  });

  it('is invalid without an init event', () => {
    expect(check(undefined)).toEqual({ valid: false, problems: ['the stream has no init event'] });
  });
});

describe('userSkillNames', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-skills-'));
    await mkdir(path.join(dir, 'skills', 'synced'), { recursive: true });
    await mkdir(path.join(dir, 'skills', 'aws-cdk'));
    await mkdir(path.join(dir, 'elsewhere'));
    await symlink(path.join(dir, 'elsewhere'), path.join(dir, 'skills', 'linked'));
    await writeFile(path.join(dir, 'skills', '.DS_Store'), '');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists the folders and folder links in the skills folder, sorted, and no plain files', async () => {
    expect(await userSkillNames(path.join(dir, 'skills'))).toEqual(['aws-cdk', 'linked', 'synced']);
  });

  it('is empty when the skills folder does not exist', async () => {
    expect(await userSkillNames(path.join(dir, 'missing'))).toEqual([]);
  });
});
