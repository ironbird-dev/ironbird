import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { budgetFrom, fillPrompt, proxyArgs, proxyEnv } from './args.mjs';

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

describe('the proxy prompt', () => {
  const prompt = fillPrompt(readFileSync(new URL('../prompt.md', import.meta.url), 'utf8').trim(), { docs: DOCS, repo: '/r' });

  it('states the layout of the docs folder and points at the guides by absolute path', () => {
    expect(prompt).toContain(`${DOCS}/docs/guides/getting-started.md`);
    expect(prompt).toContain(`${DOCS}/packages/`);
    expect(prompt).toMatch(/mirrors the repository/);
    expect(prompt).toMatch(/absolute path/);
  });

  it('leaves no placeholder unfilled', () => {
    expect(prompt).not.toMatch(/\{\{/);
  });
});

describe('budgetFrom', () => {
  it('uses the cap when no budget is given', () => {
    expect(budgetFrom(undefined, 20)).toBe(20);
  });

  it('accepts a positive decimal no greater than the cap', () => {
    expect(budgetFrom('1', 20)).toBe(1);
    expect(budgetFrom('0.5', 20)).toBe(0.5);
    expect(budgetFrom('20', 20)).toBe(20);
  });

  it('rejects zero, negatives, values above the cap, infinity, and anything that is not a plain decimal', () => {
    for (const value of ['0', '-1', '20.01', '21', 'Infinity', '1e9', 'NaN', '', ' 5', '0x10', 'abc']) {
      expect(() => budgetFrom(value, 20), value).toThrow('--max-budget-usd');
    }
  });
});
