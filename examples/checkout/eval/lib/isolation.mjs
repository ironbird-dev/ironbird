// The D9 isolation check (M3 design §7.2 step 4), read from a session's own init event: only
// Claude Code's bundled skills and built-in plugins, the ironbird skill, and the ironbird MCP
// server may be loaded, and the auto-memory folder must be empty. The bundled skills are recorded
// once by `prepare` from a session in an empty folder (the baseline).

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

/** Problems that make a baseline unusable: it must load no MCP server, no ironbird skill, and only built-in plugins, on the pinned model. */
export function checkBaseline(baseline, model) {
  const problems = [];
  if (baseline.mcpServers.length > 0) problems.push(`the baseline session loaded MCP servers: ${baseline.mcpServers.join(', ')}`);
  if (baseline.skills.includes('ironbird')) problems.push('the baseline session loaded an ironbird skill');
  if (baseline.skills.length === 0) problems.push('the baseline session reported no skills; the init event format may have changed');
  for (const plugin of baseline.plugins) if (!isBuiltIn(plugin)) problems.push(`the baseline session loaded a plugin that is not built in: ${JSON.stringify(plugin)}`);
  if (baseline.model !== model) problems.push(`the baseline session ran on ${baseline.model}, not ${model}`);
  return problems;
}

function isBuiltIn(plugin) {
  const source = typeof plugin === 'string' ? plugin : plugin?.source;
  return typeof source === 'string' && source.endsWith('@builtin');
}

/**
 * Checks a session's init event. `memoryEntries` lists the auto-memory folder the event reports
 * (empty when the folder is absent or empty). Returns every problem, not only the first.
 */
export function checkIsolation(init, baseline, { memoryEntries, model }) {
  if (!init) return { valid: false, problems: ['the stream has no init event'] };
  const problems = [];

  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  for (const name of names(servers)) if (name !== 'ironbird') problems.push(`MCP server ${name} is loaded`);
  const ironbird = servers.find((server) => nameOf(server) === 'ironbird');
  if (!ironbird) problems.push('the ironbird MCP server is not loaded');
  else if (typeof ironbird === 'object' && ironbird.status !== undefined && ironbird.status !== 'connected') problems.push(`the ironbird MCP server is ${ironbird.status}`);

  const allowed = new Set([...baseline.skills, 'ironbird']);
  const skills = names(init.skills);
  for (const skill of skills) if (!allowed.has(skill)) problems.push(`skill ${skill} is loaded`);
  if (!skills.includes('ironbird')) problems.push('the ironbird skill is not loaded');

  for (const plugin of Array.isArray(init.plugins) ? init.plugins : []) if (!isBuiltIn(plugin)) problems.push(`plugin ${JSON.stringify(plugin)} is not built in`);

  if (memoryEntries.length > 0) problems.push(`the auto-memory folder ${init.memory_paths?.auto} is not empty: ${memoryEntries.join(', ')}`);
  if (init.model !== model) problems.push(`the session runs on ${init.model}, not ${model}`);

  return { valid: problems.length === 0, problems };
}
