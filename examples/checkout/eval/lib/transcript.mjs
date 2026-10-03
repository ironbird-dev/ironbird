// Reading a session's `claude -p --output-format stream-json --verbose` transcript: one JSON event
// per line. The first is the `system`/`init` event; assistant events carry `tool_use` blocks, user
// events carry the matching `tool_result` blocks, and the last is the `result` event with the cost,
// the final report, and the permission denials. Positions (line indexes) order everything: the
// stream has no timestamps, and a single agent's stream is sequential.
import path from 'node:path';

/** @typedef {{ id: string, name: string, input: Record<string, unknown>, index: number, resultIndex?: number, resultText?: string, isError?: boolean }} ToolCall */

/** Text of a tool_result's content, which is a string or an array of blocks. Image blocks are dropped. */
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
  return '';
}

/**
 * Parses a transcript. Never throws: a line that is not JSON (a session killed mid-write) becomes
 * `{ type: 'unparsed' }`, and a missing init or result event is `undefined`.
 * @returns {{ events: object[], init: object | undefined, result: object | undefined, calls: ToolCall[] }}
 */
export function parseTranscript(text) {
  const events = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: 'unparsed', line };
      }
    });
  const init = events.find((event) => event?.type === 'system' && event.subtype === 'init');
  const result = events.findLast((event) => event?.type === 'result');
  const calls = [];
  const byId = new Map();
  events.forEach((event, index) => {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (event.type === 'assistant' && block?.type === 'tool_use') {
        const call = { id: block.id, name: block.name, input: block.input ?? {}, index };
        calls.push(call);
        byId.set(block.id, call);
      } else if (event.type === 'user' && block?.type === 'tool_result') {
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.resultIndex = index;
        call.resultText = resultText(block.content);
        call.isError = block.is_error === true;
      }
    }
  });
  return { events, init, result, calls };
}

/** The session's final report: the result event's text, or the last assistant text when the session was cut off. */
export function finalReport(parsed) {
  if (typeof parsed.result?.result === 'string' && parsed.result.result.trim() !== '') return parsed.result.result;
  const texts = parsed.events
    .filter((event) => event?.type === 'assistant' && Array.isArray(event.message?.content))
    .flatMap((event) => event.message.content.filter((block) => block?.type === 'text').map((block) => block.text));
  return texts.at(-1) ?? '';
}

/** Denied tool calls: the result event's permission_denials, or, without a result event, error results that say they were denied. */
export function deniedCalls(parsed) {
  if (Array.isArray(parsed.result?.permission_denials)) return parsed.result.permission_denials.length;
  return parsed.calls.filter((call) => call.isError && /permission|denied|not allowed/i.test(call.resultText ?? '')).length;
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const inside = (file, roots) => roots.some((root) => file === root || file.startsWith(root + path.sep));

/** Maps a path under any of `roots` to the same path under `roots[0]`, so paths reported under another spelling of the session folder compare equal. Other paths come back unchanged. */
export function canonicalPath(file, roots) {
  for (const root of roots) if (file === root || file.startsWith(root + path.sep)) return path.join(roots[0], path.relative(root, file));
  return file;
}

/**
 * The position of the last successful edit tool result on any file in the session folder, with
 * the file; `index` is -1 when there is none. Every edit counts, including edits later reverted:
 * a run that started before an edit returned may have run code that no longer exists.
 */
export function lastEdit(calls, roots) {
  let last = { index: -1, file: null };
  for (const call of calls) {
    if (!EDIT_TOOLS.has(call.name) || call.resultIndex === undefined || call.isError) continue;
    const raw = call.input.file_path ?? call.input.notebook_path;
    if (typeof raw !== 'string') continue;
    const file = canonicalPath(path.resolve(roots[0], raw), roots);
    if (inside(file, roots) && call.resultIndex > last.index) last = { index: call.resultIndex, file };
  }
  return last;
}

/** A call that runs scenarios: the MCP tool, or the CLI through Bash. */
export function isScenarioRun(call) {
  return call.name === 'mcp__ironbird__ironbird_run_scenario' || (call.name === 'Bash' && /\bironbird\s+scenario\s+run\b/.test(String(call.input.command ?? '')));
}

/** A call that captures the screen: ironbird_screenshot or ironbird_step, over MCP or the CLI. */
export function isScreenCapture(call) {
  return (
    call.name === 'mcp__ironbird__ironbird_screenshot' ||
    call.name === 'mcp__ironbird__ironbird_step' ||
    (call.name === 'Bash' && /\bironbird\s+(screenshot|step)\b/.test(String(call.input.command ?? '')))
  );
}

/** JSON objects in a tool result: the whole text as one JSON value, or else every line that parses as a JSON object. */
export function jsonObjects(text) {
  const trimmed = String(text ?? '').trim();
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    // Not one JSON value: the CLI prints one JSON object per line.
  }
  const found = [];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      found.push(JSON.parse(candidate));
    } catch {
      // A line that only looks like JSON.
    }
  }
  return found;
}

/**
 * The ScenarioResults a scenario-run call reported: the MCP tool's `{ results: [...] }`, or the
 * CLI's one JSON line per file. A failed scenario still reports its result (the CLI exits 4), so
 * error results are read too.
 */
export function scenarioResultsOf(call) {
  if (!isScenarioRun(call) || call.resultIndex === undefined) return [];
  return jsonObjects(call.resultText)
    .flatMap((value) => (Array.isArray(value?.results) ? value.results : [value]))
    .filter((result) => result !== null && typeof result === 'object' && typeof result.passed === 'boolean');
}

/** The scenario-run call whose reported result has `artifacts` equal to `runPath` (under `roots`), with that result. */
export function reportingCall(calls, runPath, roots) {
  for (const call of calls) {
    const result = scenarioResultsOf(call).find((candidate) => typeof candidate.artifacts === 'string' && canonicalPath(candidate.artifacts, roots) === runPath);
    if (result) return { call, result };
  }
  return undefined;
}

/** The target a screen capture ran on: its result's `target`, else its `target` input, else the CLI's `--target`. */
export function captureTarget(call) {
  const reported = jsonObjects(call.resultText).find((value) => typeof value?.target === 'string');
  if (reported) return reported.target;
  if (typeof call.input.target === 'string') return call.input.target;
  return String(call.input.command ?? '').match(/--target[= ](\S+)/)?.[1];
}

/** Whether a successful screen capture on target `ios` was requested after position `index`. */
export function iosCaptureAfter(calls, index) {
  return calls.some((call) => isScreenCapture(call) && call.index > index && call.resultIndex !== undefined && !call.isError && captureTarget(call) === 'ios');
}

/**
 * Bash calls that could write files the edit timeline cannot see: output redirection (other than
 * to /dev/null or between descriptors), `tee`, or git's `--output`. The allowlisted commands write
 * nothing else a session's source depends on.
 */
export function untrackedWrites(calls) {
  return calls.filter((call) => {
    if (call.name !== 'Bash' || typeof call.input.command !== 'string') return false;
    const command = call.input.command.replace(/\d*>&\d+/g, ' ').replace(/&?\d*>>?\s*\/dev\/null/g, ' ');
    return />/.test(command) || /\btee\b/.test(command) || /--output\b/.test(command);
  });
}

const BASH_PATH = /(?:^|[\s=('"<>])((?:~|\.\.)(?:\/[^\s'";|&<>)]*)?|\/[^\s'";|&<>)]+)/g;
const IGNORED_OUTSIDE = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

function resolvePath(raw, root, home) {
  if (raw === '~' || raw.startsWith('~/')) return path.join(home, raw.slice(1));
  return path.resolve(root, raw);
}

/** Filesystem paths a call names: file tools' paths, Glob's and Grep's search folder, an absolute Glob pattern, run_scenario's path, and path-like words in a Bash command. */
export function pathsOf(call, root, home) {
  const found = [];
  const input = call.input ?? {};
  if (typeof input.file_path === 'string') found.push(input.file_path);
  if (typeof input.notebook_path === 'string') found.push(input.notebook_path);
  if ((call.name === 'mcp__ironbird__ironbird_run_scenario' || call.name === 'Glob' || call.name === 'Grep') && typeof input.path === 'string') found.push(input.path);
  if (call.name === 'Glob' && typeof input.pattern === 'string' && /^(\/|~|\.\.)/.test(input.pattern)) found.push(input.pattern.replace(/\/?[^/]*[*?[{].*$/, '') || '/');
  if (call.name === 'Bash' && typeof input.command === 'string') for (const match of input.command.matchAll(BASH_PATH)) found.push(match[1]);
  return found.map((raw) => resolvePath(raw, root, home));
}

/** Every path a tool call named outside the session folder, as `{ index, tool, path }`. `roots[0]` is the session folder; the rest are other spellings of it. */
export function outOfFolderPaths(calls, roots, home) {
  const hits = [];
  for (const call of calls) {
    for (const file of pathsOf(call, roots[0], home)) {
      if (!inside(file, roots) && !IGNORED_OUTSIDE.has(file)) hits.push({ index: call.index, tool: call.name, path: file });
    }
  }
  return hits;
}
