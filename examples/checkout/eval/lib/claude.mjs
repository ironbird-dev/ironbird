// Running `claude -p` with its stream saved verbatim, one event per line, as it arrives.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import readline from 'node:readline';
import { MODEL } from './paths.mjs';
import { guardStdin, reapGroup, run } from './proc.mjs';
import { sandboxed } from './sandbox.mjs';

export async function claudeVersion() {
  const { code, stdout } = await run('claude', ['--version']);
  if (code !== 0) throw new Error('claude --version failed; is Claude Code installed and on PATH?');
  return stdout.trim();
}

/**
 * Starts claude in `cwd` with `args` under the sandbox `profile` (lib/sandbox.mjs), writes `prompt`
 * to its stdin, saves every stdout line to `transcriptFile`, and calls `onEvent` with each line that
 * parses as JSON. `sandbox-exec` execs claude, so the child's pid is claude's and its process group
 * holds claude, the MCP server, and every Bash child. `done` resolves with the exit once the
 * transcript is flushed; `stop()` reaps the whole group, bounded.
 */
export function startClaude({ cwd, args, env, prompt, transcriptFile, stderrFile, onEvent, profile }) {
  const transcript = createWriteStream(transcriptFile, { flags: 'w' });
  const stderr = createWriteStream(stderrFile, { flags: 'w' });
  const { command, args: argv } = sandboxed(profile, 'claude', args);
  const child = spawn(command, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  child.stderr.pipe(stderr);
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    transcript.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    onEvent?.(event);
  });
  // Claude may exit before it reads the whole prompt: its exit code reports that, not an EPIPE here.
  guardStdin(child, (error) => stderr.write(`[harness] writing the prompt to claude failed: ${error.message}\n`));
  child.stdin.end(prompt);
  const done = (async () => {
    const [code, signal] = await once(child, 'close');
    transcript.end();
    await once(transcript, 'close');
    return { code, signal };
  })();
  return {
    child,
    pgid: child.pid,
    done,
    async stop(graceMs = 10_000) {
      return reapGroup(child.pid, { graceMs, killMs: 5_000 });
    },
  };
}

/**
 * The init event of a session with no project skill and no MCP server: the baseline for the D9
 * check. Claude is stopped as soon as the event arrives. The request goes out alongside the init
 * event, so the one-word answer may still complete first (about a cent, well inside the 0.5 USD cap).
 */
export async function captureBaselineInit({ cwd, env, transcriptFile, stderrFile, profile }) {
  const args = ['-p', '--model', MODEL, '--setting-sources', 'project', '--strict-mcp-config', '--tools', 'Read', '--permission-prompts', 'none', '--max-budget-usd', '0.5', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
  let init;
  const session = startClaude({
    cwd,
    args,
    env,
    prompt: 'Reply with the word OK.',
    transcriptFile,
    stderrFile,
    profile,
    onEvent: (event) => {
      if (init || event.type !== 'system' || event.subtype !== 'init') return;
      init = event;
      void session.stop(2_000);
    },
  });
  const timer = setTimeout(() => void session.stop(2_000), 60_000);
  await session.done;
  clearTimeout(timer);
  if (!init) throw new Error(`The baseline session produced no init event; see ${stderrFile}`);
  return init;
}
