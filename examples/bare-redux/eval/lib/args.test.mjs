import { describe, expect, it } from 'vitest';
import { fillPrompt, proxyArgs, proxyEnv } from './args.mjs';

const PROJECT = '/Users/dev/.ironbird-eval/proxy/sessions/proxy-1/project';
const DOCS = '/Users/dev/.ironbird-eval/proxy/sessions/proxy-1/docs';

describe('proxyArgs', () => {
  const settings = { permissions: { deny: ['Read(//Users/dev/apps/ironbird/**)'] } };
  const args = proxyArgs({ projectDir: PROJECT, docsDir: DOCS, settings, budgetUsd: 20, model: 'sonnet' });
  const value = (flag) => args[args.indexOf(flag) + 1];

  it('runs the model with project settings only, no MCP server at all, and the proxy tools', () => {
    expect(args[0]).toBe('-p');
    expect(value('--model')).toBe('sonnet');
    expect(value('--setting-sources')).toBe('project');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
    expect(value('--tools')).toBe('Bash,Read,Edit,Write,Glob,Grep');
    expect(value('--permission-prompts')).toBe('none');
    expect(JSON.parse(value('--settings'))).toEqual(settings);
    expect(value('--max-budget-usd')).toBe('20');
    expect(value('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--no-session-persistence');
  });

  it('ends with the allow list: what an integration runs, reads in the project and the docs, edits in the project only', () => {
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual([
      'Bash(npm install*)',
      'Bash(npm test*)',
      'Bash(npm run *)',
      'Bash(npx ironbird *)',
      'Bash(npx react-native bundle *)',
      'Bash(npx tsc*)',
      'Bash(git status*)',
      'Bash(git diff*)',
      'Bash(git log*)',
      'Bash(ls*)',
      'Bash(mkdir *)',
      `Read(/${PROJECT}/**)`,
      `Read(/${DOCS}/**)`,
      `Edit(/${PROJECT}/**)`,
    ]);
  });
});

describe('proxyEnv', () => {
  it('drops nested-session markers, npm variables, the working directory, and anything naming ironbird or a planted flag', () => {
    const env = proxyEnv({ PATH: '/usr/bin', HOME: '/Users/dev', CLAUDECODE: '1', npm_config_user_agent: 'pnpm', PWD: '/Users/dev/apps/ironbird', IRONBIRD_SIM_UDID: 'X', PLANT_SYNC_REORDER: '1', EXPO_PUBLIC_PLANT_RACE: '1' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/dev', DISABLE_AUTOUPDATER: '1' });
  });
});

describe('fillPrompt', () => {
  it('fills the docs and repository folders', () => {
    expect(fillPrompt('read {{docs}}/README.md, not {{repo}}/AGENTS.md', { docs: '/d', repo: '/r' })).toBe('read /d/README.md, not /r/AGENTS.md');
  });
});
