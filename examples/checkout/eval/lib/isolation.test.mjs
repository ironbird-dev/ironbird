import { describe, expect, it } from 'vitest';
import { baselineFromInit, checkBaseline, checkIsolation } from './isolation.mjs';

const MODEL = 'claude-sonnet-5-5';
const BUILTIN = [
  { name: 'agents-md', source: 'agents-md@builtin' },
  { name: 'telemetry', source: 'telemetry@builtin' },
];
const baselineInit = { type: 'system', subtype: 'init', model: MODEL, mcp_servers: [], skills: ['verify', 'debug', 'code-review'], plugins: BUILTIN, memory_paths: { auto: '/Users/dev/.claude/projects/-x-baseline/memory' } };
const baseline = baselineFromInit(baselineInit, '2.1.283 (Claude Code)');

const sessionInit = (overrides = {}) => ({
  type: 'system',
  subtype: 'init',
  model: MODEL,
  mcp_servers: [{ name: 'ironbird', status: 'connected' }],
  skills: ['verify', 'debug', 'code-review', 'ironbird'],
  plugins: BUILTIN,
  memory_paths: { auto: '/Users/dev/.claude/projects/-x-sessions-1-project/memory' },
  ...overrides,
});

describe('baseline', () => {
  it('records the bundled skills sorted, the plugins, and no MCP servers, and passes its own check', () => {
    expect(baseline).toMatchObject({ claudeVersion: '2.1.283 (Claude Code)', model: MODEL, skills: ['code-review', 'debug', 'verify'], plugins: BUILTIN, mcpServers: [] });
    expect(checkBaseline(baseline, MODEL)).toEqual([]);
  });

  it('rejects a baseline with an MCP server, a user plugin, no skills, or the wrong model', () => {
    const bad = baselineFromInit({ ...baselineInit, model: 'claude-fable-5', mcp_servers: [{ name: 'slack' }], skills: [], plugins: [...BUILTIN, { name: 'superpowers', source: 'superpowers@claude-plugins-official' }] }, 'x');
    expect(checkBaseline(bad, MODEL)).toHaveLength(4);
  });
});

describe('checkIsolation', () => {
  it('accepts bundled skills, built-in plugins, the ironbird skill and server, the pinned model, and an empty memory folder', () => {
    expect(checkIsolation(sessionInit(), baseline, { memoryEntries: [], model: MODEL })).toEqual({ valid: true, problems: [] });
  });

  it('accepts skills reported as objects with a name', () => {
    const init = sessionInit({ skills: [{ name: 'verify' }, { name: 'ironbird' }], mcp_servers: [{ name: 'ironbird', status: 'connected' }] });
    expect(checkIsolation(init, baseline, { memoryEntries: [], model: MODEL }).valid).toBe(true);
  });

  it('reports every leak at once: a user skill, another MCP server, a user plugin, memory, the wrong model', () => {
    const init = sessionInit({
      model: 'claude-fable-5',
      skills: ['verify', 'ironbird', 'superpowers:brainstorming'],
      mcp_servers: [{ name: 'ironbird', status: 'connected' }, { name: 'context7', status: 'connected' }],
      plugins: [...BUILTIN, { name: 'codex', source: 'codex@openai-codex' }],
    });
    const { valid, problems } = checkIsolation(init, baseline, { memoryEntries: ['MEMORY.md'], model: MODEL });
    expect(valid).toBe(false);
    expect(problems).toEqual([
      'MCP server context7 is loaded',
      'skill superpowers:brainstorming is loaded',
      'plugin {"name":"codex","source":"codex@openai-codex"} is not built in',
      'the auto-memory folder /Users/dev/.claude/projects/-x-sessions-1-project/memory is not empty: MEMORY.md',
      'the session runs on claude-fable-5, not claude-sonnet-5-5',
    ]);
  });

  it('is invalid when the ironbird server or skill is missing or the server failed to connect', () => {
    expect(checkIsolation(sessionInit({ mcp_servers: [], skills: ['verify'] }), baseline, { memoryEntries: [], model: MODEL }).problems).toEqual([
      'the ironbird MCP server is not loaded',
      'the ironbird skill is not loaded',
    ]);
    expect(checkIsolation(sessionInit({ mcp_servers: [{ name: 'ironbird', status: 'failed' }] }), baseline, { memoryEntries: [], model: MODEL }).problems).toEqual([
      'the ironbird MCP server is failed',
    ]);
  });

  it('requires the ironbird server to be reported as connected: a bare name or a missing status is a problem', () => {
    expect(checkIsolation(sessionInit({ mcp_servers: ['ironbird'] }), baseline, { memoryEntries: [], model: MODEL }).problems).toEqual([
      'the ironbird MCP server is not reported as connected',
    ]);
    expect(checkIsolation(sessionInit({ mcp_servers: [{ name: 'ironbird' }] }), baseline, { memoryEntries: [], model: MODEL }).problems).toEqual([
      'the ironbird MCP server is not reported as connected',
    ]);
    expect(checkIsolation(sessionInit({ mcp_servers: [{ name: 'ironbird', status: 'pending' }] }), baseline, { memoryEntries: [], model: MODEL }).problems).toEqual([
      'the ironbird MCP server is pending',
    ]);
  });

  it('is invalid without an init event', () => {
    expect(checkIsolation(undefined, baseline, { memoryEntries: [], model: MODEL })).toEqual({ valid: false, problems: ['the stream has no init event'] });
  });
});
