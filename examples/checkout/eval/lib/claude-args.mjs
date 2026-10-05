// The `claude -p` command line, settings, and environment for one session (M3 design §7.2 step 3).
import path from 'node:path';

/** The spec's tools plus Glob and Grep, which are read-only and, like Read, confined to the session folder by the rules below. */
export const SESSION_TOOLS = 'Bash,Read,Edit,Write,Skill,Glob,Grep';
export const ALLOWED_BASH = ['npx ironbird *', 'npm test*', 'npm run typecheck*', 'npx vitest *', 'git status*', 'git diff*', 'git log*'];

/** A permission-rule path for an absolute path: Claude Code spells absolute paths with a leading `//`. */
export const rulePath = (absolute) => `/${absolute}`;

/**
 * The allow list. `mcp__ironbird` allows every tool of the ironbird server. Reads and edits are
 * allowed only inside the session folder: Read rules also govern Glob and Grep, and Edit rules also
 * govern Write. With `--permission-prompts none`, anything without an allow rule is denied, so a
 * read, search, or edit outside the folder is refused (and the deny rules refuse the repository and
 * the template even if a rule were wider). `--permission-mode acceptEdits` is not used: it would also
 * auto-approve file-changing shell commands that the transcript's edit timeline cannot see.
 */
export function allowedTools(projectDir) {
  return ['mcp__ironbird', ...ALLOWED_BASH.map((pattern) => `Bash(${pattern})`), `Read(${rulePath(projectDir)}/**)`, `Edit(${rulePath(projectDir)}/**)`, 'Skill'];
}

/**
 * The arguments after `claude`. The prompt is not among them: it goes to stdin, because the
 * variadic `--allowedTools` would swallow a trailing positional prompt. `--allowedTools` is last
 * for the same reason. The settings go inline as JSON: the sandbox denies the eval home, where a
 * settings file would live, to everything but the session folder.
 */
export function claudeArgs({ projectDir, settings, budgetUsd, model, extraAllow = [] }) {
  return [
    '-p',
    '--model',
    model,
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    path.join(projectDir, '.mcp.json'),
    '--tools',
    SESSION_TOOLS,
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
    ...allowedTools(projectDir),
    ...extraAllow,
  ];
}

/**
 * The session settings: session-settings.json with `{{repo}}` and `{{template}}` replaced by
 * absolute paths, plus read and edit denials for every folder in `alsoDeny` (the other sessions,
 * the grades, and the template check), which hold answers too.
 */
export function renderSettings(template, { repo, fixture, alsoDeny }) {
  const deny = [...template.permissions.deny.map((rule) => fillPaths(rule, { repo, fixture })), ...alsoDeny.flatMap((dir) => [`Read(${rulePath(dir)}/**)`, `Edit(${rulePath(dir)}/**)`])];
  return { ...template, permissions: { ...template.permissions, deny } };
}

/**
 * The smoke session's sandbox probe: allow rules that let Bash `head` and Read reach the repository
 * and the eval home, with no deny rules, so that only the sandbox stands in the way. Smoke only.
 */
export function probeAllow({ repo, home }) {
  return ['Bash(head *)', `Read(${rulePath(repo)}/**)`, `Read(${rulePath(home)}/**)`];
}

/** Replaces `{{repo}}` and `{{template}}` in a prompt or settings string. */
export function fillPaths(text, { repo, fixture }) {
  return text.replaceAll('{{repo}}', repo).replaceAll('{{template}}', fixture);
}

/** Variables removed from the session's environment: nested-session markers, and anything that names the eval, the repository (the harness runs from it), or the race. Every `npm_*` variable goes too. */
export const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PROJECT_DIR', 'IRONBIRD_TOKEN', 'IRONBIRD_EVAL_HOME', 'PLANT_RACE', 'EXPO_PUBLIC_PLANT_RACE', 'PWD', 'OLDPWD', 'INIT_CWD'];

/** The environment for claude and for the processes the harness starts: IRONBIRD_SIM_UDID pins the iPhone 17, and auto-update stays off so the version matches the baseline. */
export function sessionEnv(base, { udid }) {
  const env = { ...base };
  for (const name of Object.keys(env)) if (STRIPPED_ENV.includes(name) || name.startsWith('npm_')) delete env[name];
  return { ...env, IRONBIRD_SIM_UDID: udid, DISABLE_AUTOUPDATER: '1' };
}
