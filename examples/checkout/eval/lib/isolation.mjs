// The D9 isolation check (M3 design §7.2 step 4), read from a session's own init event: only
// Claude Code's bundled skills and built-in plugins, the ironbird skill, and the ironbird MCP
// server may be loaded, and the auto-memory folder must be empty.
//
// Claude Code's bundled set varies between runs (a `plugin-authoring` built-in appears in some and
// not others), so sessions are not compared with a fixed list. A skill is a leak when its name is a
// folder in ~/.claude/skills (read at run time) or carries a plugin namespace (`plugin:skill`); a
// plugin is a leak unless its source ends with `@builtin`. `prepare` still records one session's
// init event in an empty folder (the baseline), as a record and as a check of the setup.
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const nameOf = (item) => (typeof item === 'string' ? item : typeof item?.name === 'string' ? item.name : undefined);
const names = (list) => (Array.isArray(list) ? list.map(nameOf).filter((name) => name !== undefined) : []);

/** The baseline record prepare writes to baseline.json. */
export function baselineFromInit(init, claudeVersion) {
  return {
    claudeVersion,
    model: init?.model ?? null,
    skills: names(init?.skills).sort(),
    plugins: Array.isArray(init?.plugins) ? init.plugins : [],
    mcpServers: names(init?.mcp_servers),
    capturedAt: new Date().toISOString(),
  };
}

/** `model` is a pattern (MODEL_PATTERN in lib/paths.mjs), never a bare id: the `--model` alias resolves to an id the CLI picks. */
function assertPattern(model) {
  if (!(model instanceof RegExp)) throw new TypeError(`expected the model as a RegExp such as MODEL_PATTERN, got ${JSON.stringify(model)}`);
}

const runsOn = (id, model) => typeof id === 'string' && model.test(id);

/**
 * Problems that make a baseline unusable: it must load no MCP server, no ironbird skill, and only
 * built-in plugins, on a model whose id matches `model` (MODEL_PATTERN).
 */
export function checkBaseline(baseline, model) {
  assertPattern(model);
  const problems = [];
  if (baseline.mcpServers.length > 0) problems.push(`the baseline session loaded MCP servers: ${baseline.mcpServers.join(', ')}`);
  if (baseline.skills.includes('ironbird')) problems.push('the baseline session loaded an ironbird skill');
  if (baseline.skills.length === 0) problems.push('the baseline session reported no skills; the init event format may have changed');
  for (const plugin of baseline.plugins) if (!isBuiltIn(plugin)) problems.push(`the baseline session loaded a plugin that is not built in: ${JSON.stringify(plugin)}`);
  if (!runsOn(baseline.model, model)) problems.push(`the baseline session ran on ${baseline.model}, not a model matching ${model}`);
  return problems;
}

function isBuiltIn(plugin) {
  const source = typeof plugin === 'string' ? plugin : plugin?.source;
  return typeof source === 'string' && source.endsWith('@builtin');
}

/** The user's own skills: the names of the folders (or folder links) in `dir`, sorted. A missing folder has none. */
export async function userSkillNames(dir = path.join(os.homedir(), '.claude', 'skills')) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Checks a session's init event. `memoryEntries` lists the auto-memory folder the event reports
 * (empty when the folder is absent or empty); `model` is the pattern the event's model id must match
 * (MODEL_PATTERN); `userSkills` are the user's skill names (userSkillNames). Returns every
 * problem, not only the first.
 */
export function checkIsolation(init, { memoryEntries, model, userSkills }) {
  assertPattern(model);
  if (!Array.isArray(userSkills)) throw new TypeError(`expected userSkills as an array of names, got ${JSON.stringify(userSkills)}`);
  if (!init) return { valid: false, problems: ['the stream has no init event'] };
  const problems = [];

  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  for (const name of names(servers)) if (name !== 'ironbird') problems.push(`MCP server ${name} is loaded`);
  const ironbird = servers.find((server) => nameOf(server) === 'ironbird');
  if (!ironbird) problems.push('the ironbird MCP server is not loaded');
  else if (typeof ironbird !== 'object' || ironbird.status !== 'connected') problems.push(`the ironbird MCP server is ${ironbird.status ?? 'not reported as connected'}`);

  const user = new Set(userSkills);
  const skills = names(init.skills);
  for (const skill of skills) {
    if (skill.includes(':')) problems.push(`skill ${skill} is loaded from a plugin`);
    else if (user.has(skill)) problems.push(`skill ${skill} is loaded, and the user skills folder has a skill of that name`);
  }
  if (!skills.includes('ironbird')) problems.push('the ironbird skill is not loaded');

  for (const plugin of Array.isArray(init.plugins) ? init.plugins : []) if (!isBuiltIn(plugin)) problems.push(`plugin ${JSON.stringify(plugin)} is not built in`);

  if (memoryEntries.length > 0) problems.push(`the auto-memory folder ${init.memory_paths?.auto} is not empty: ${memoryEntries.join(', ')}`);
  if (!runsOn(init.model, model)) problems.push(`the session runs on ${init.model}, not a model matching ${model}`);

  return { valid: problems.length === 0, problems };
}
