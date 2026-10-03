import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allowedTools, claudeArgs, fillPaths, probeAllow, renderSettings, sessionEnv } from './claude-args.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = '/Users/dev/.ironbird-eval/sessions/1/project';

describe('claudeArgs', () => {
  const settings = { permissions: { deny: ['Read(//Users/dev/apps/ironbird/**)'] } };
  const args = claudeArgs({ projectDir: PROJECT, settings, budgetUsd: 10, model: 'claude-sonnet-5-5' });

  it('passes the spec flags with their values', () => {
    const value = (flag) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-p');
    expect(value('--model')).toBe('claude-sonnet-5-5');
    expect(value('--setting-sources')).toBe('project');
    expect(args).toContain('--strict-mcp-config');
    expect(value('--mcp-config')).toBe(`${PROJECT}/.mcp.json`);
    expect(value('--tools')).toBe('Bash,Read,Edit,Write,Skill,Glob,Grep');
    expect(value('--permission-prompts')).toBe('none');
    expect(JSON.parse(value('--settings'))).toEqual(settings);
    expect(value('--max-budget-usd')).toBe('10');
    expect(value('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--no-session-persistence');
  });

  it('ends with the variadic allow list, one rule per argument, so nothing positional follows it', () => {
    const start = args.indexOf('--allowedTools');
    expect(args.slice(start + 1)).toEqual(allowedTools(PROJECT));
    expect(allowedTools(PROJECT)).toEqual([
      'mcp__ironbird',
      'Bash(npx ironbird *)',
      'Bash(npm test*)',
      'Bash(npx vitest *)',
      'Bash(git status*)',
      'Bash(git diff*)',
      'Bash(git log*)',
      `Read(/${PROJECT}/**)`,
      `Edit(/${PROJECT}/**)`,
      'Skill',
    ]);
  });
});

describe('the smoke probe', () => {
  it('appends allow rules that reach the repository and the eval home after the session rules', () => {
    const extraAllow = probeAllow({ repo: '/Users/dev/apps/ironbird', home: '/Users/dev/.ironbird-eval' });
    const args = claudeArgs({ projectDir: PROJECT, settings: { permissions: { deny: [] } }, budgetUsd: 2, model: 'claude-sonnet-5-5', extraAllow });
    expect(args.slice(-3)).toEqual(['Bash(head *)', 'Read(//Users/dev/apps/ironbird/**)', 'Read(//Users/dev/.ironbird-eval/**)']);
    expect(fillPaths('head -3 {{repo}}/AGENTS.md; {{template}}/x', { repo: '/r', fixture: '/t' })).toBe('head -3 /r/AGENTS.md; /t/x');
  });
});

describe('session settings', () => {
  it('denies reading and editing the repository, the template, and every extra folder', async () => {
    const template = JSON.parse(await readFile(path.join(here, '..', 'session-settings.json'), 'utf8'));
    const settings = renderSettings(template, { repo: '/Users/dev/apps/ironbird', fixture: '/Users/dev/.ironbird-eval/template', alsoDeny: ['/Users/dev/.ironbird-eval/sessions/2'] });
    expect(settings.permissions.deny).toEqual([
      'Read(//Users/dev/apps/ironbird/**)',
      'Edit(//Users/dev/apps/ironbird/**)',
      'Read(//Users/dev/.ironbird-eval/template/**)',
      'Edit(//Users/dev/.ironbird-eval/template/**)',
      'Read(//Users/dev/.ironbird-eval/sessions/2/**)',
      'Edit(//Users/dev/.ironbird-eval/sessions/2/**)',
    ]);
    expect(JSON.stringify(settings)).not.toContain('{{');
  });
});

describe('sessionEnv', () => {
  it('drops nested-session markers, npm variables, the working directory, and the race flags, and pins the simulator', () => {
    const env = sessionEnv(
      { PATH: '/usr/bin', HOME: '/Users/dev', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', npm_config_user_agent: 'pnpm', PWD: '/Users/dev/apps/ironbird', PLANT_RACE: '1', IRONBIRD_EVAL_HOME: '/x' },
      { udid: 'UDID-17' },
    );
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/dev', IRONBIRD_SIM_UDID: 'UDID-17', DISABLE_AUTOUPDATER: '1' });
  });
});
