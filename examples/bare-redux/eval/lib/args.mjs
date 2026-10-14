// The proxy session's `claude -p` command line, environment, and prompt (M5 design D11). Like the M3
// session, but with no MCP server and no skill (the app has no ironbird yet), the commands an
// integration needs, and read access to the session's copy of the docs.
import { rulePath, STRIPPED_ENV } from '../../../checkout/eval/lib/claude-args.mjs';

export const PROXY_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep';
export const PROXY_BASH = ['npm install*', 'npm test*', 'npm run *', 'npx ironbird *', 'npx react-native bundle *', 'npx tsc*', 'git status*', 'git diff*', 'git log*', 'ls*', 'mkdir *'];

/** Bash limited to PROXY_BASH; Read (and so Glob and Grep) in the project and the docs; Edit (and so Write) in the project only. */
export function proxyAllowedTools({ projectDir, docsDir }) {
  return [...PROXY_BASH.map((pattern) => `Bash(${pattern})`), `Read(${rulePath(projectDir)}/**)`, `Read(${rulePath(docsDir)}/**)`, `Edit(${rulePath(projectDir)}/**)`];
}

/**
 * The arguments after `claude`. `--strict-mcp-config` with no `--mcp-config` loads no MCP server.
 * The prompt goes to stdin and `--allowedTools` comes last, as in the M3 harness (lib/claude-args.mjs).
 */
export function proxyArgs({ projectDir, docsDir, settings, budgetUsd, model, extraAllow = [] }) {
  return [
    '-p',
    '--model',
    model,
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--tools',
    PROXY_TOOLS,
    '--permission-prompts',
    'none',
    '--settings',
    JSON.stringify(settings),
    '--max-budget-usd',
    String(budgetUsd),
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--allowedTools',
    ...proxyAllowedTools({ projectDir, docsDir }),
    ...extraAllow,
  ];
}

/** The environment for claude and for the grader's processes: the M3 removals, plus anything naming ironbird or a planted flag, with auto-update off so the version matches the baseline. */
export function proxyEnv(base) {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (STRIPPED_ENV.includes(name) || name.startsWith('npm_') || /IRONBIRD|PLANT/.test(name)) delete env[name];
  }
  return { ...env, DISABLE_AUTOUPDATER: '1' };
}

/** Replaces `{{docs}}` and `{{repo}}` in a prompt. */
export function fillPrompt(text, { docs, repo }) {
  return text.replaceAll('{{docs}}', docs).replaceAll('{{repo}}', repo);
}
