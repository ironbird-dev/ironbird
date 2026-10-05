// The session's filesystem boundary. Permission rules only govern Claude Code's own tools: a test
// run, an `npx ironbird` command, or the MCP server's `ironbird_run_scenario` with an absolute path
// could still read the repository. So `claude -p` runs under macOS `sandbox-exec`, and everything it
// starts (the MCP server, every Bash child) inherits the sandbox. The harness's daemon and Metro run
// outside it.
//
// SBPL evaluates every rule and the last matching one wins, so the profile allows everything, then
// denies reading and writing the repository and the eval home, then re-allows stat on the session
// folder's ancestors inside the eval home (so resolving the working directory never fails) and
// full access to the session folder itself.
import path from 'node:path';

/** An SBPL string literal. */
export function sbplString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const isWithin = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** The folders from `inner` up to and including `outer`, innermost first. `inner` must be inside `outer`. */
export function ancestorsWithin(inner, outer) {
  const found = [];
  for (let current = path.dirname(inner); isWithin(current, outer); current = path.dirname(current)) {
    found.push(current);
    if (current === outer) break;
  }
  return found;
}

/**
 * The profile text. `denied` and `allowed` are real (symlink-free) absolute paths, since the
 * sandbox matches resolved paths. Throws when a path is relative or an allowed folder is outside
 * every denied one (the rule would be pointless and probably a mistake).
 */
export function sandboxProfile({ denied, allowed }) {
  for (const dir of [...denied, ...allowed]) if (!path.isAbsolute(dir)) throw new Error(`sandbox paths must be absolute: ${dir}`);
  const lines = ['(version 1)', '(allow default)'];
  for (const dir of denied) lines.push(`(deny file-read* file-write* (subpath ${sbplString(dir)}))`);
  for (const dir of allowed) {
    const outer = denied.find((candidate) => isWithin(dir, candidate));
    if (!outer) throw new Error(`${dir} is not inside a denied folder`);
    for (const ancestor of ancestorsWithin(dir, outer)) lines.push(`(allow file-read-metadata (literal ${sbplString(ancestor)}))`);
  }
  for (const dir of allowed) lines.push(`(allow file-read* file-write* (subpath ${sbplString(dir)}))`);
  return `${lines.join('\n')}\n`;
}

/** The command and arguments that run `command args...` inside the profile. */
export function sandboxed(profile, command, args) {
  return { command: 'sandbox-exec', args: ['-p', profile, command, ...args] };
}
