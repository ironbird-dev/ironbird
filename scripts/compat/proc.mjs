// I/O helpers for the compat legs: run a command with its output echoed, a time limit when asked,
// and one retry after a fetch failure or a fetch timeout when asked; run verify-bundle without
// throwing; and add a table to the step summary.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { classifyFailure, retryOnFetchFailure } from './lib.mjs';

function once(command, args, options) {
  const started = Date.now();
  // spawnSync kills the command with SIGTERM at `timeout` (npm and npx pass it on to their children)
  // and reports it as an ETIMEDOUT error, which is a result here rather than an exception.
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (result.error && !timedOut) throw result.error;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const note = timedOut ? `\n[compat] ${command} timed out after ${options.timeoutMs} ms` : '';
  console.log(`[compat] ${[command, ...args].slice(0, 4).join(' ')} took ${Math.round((Date.now() - started) / 1000)} s${timedOut ? ' (timed out)' : ''}`);
  return { status: timedOut ? 1 : (result.status ?? 1), timedOut, stdout, output: `${stdout}\n${stderr}${note}` };
}

/**
 * Runs a command and throws on a non-zero exit or a timeout. `timeoutMs` kills it at that limit.
 * `retry: true` allows one more attempt after a fetch failure or a fetch timeout (classifyFailure),
 * calling `beforeRetry()` first so a half-finished attempt can be cleared away.
 */
export function run(command, args, options = {}) {
  const attempt = (number) => {
    if (number > 1) options.beforeRetry?.();
    console.log(`\n$ ${[command, ...args].join(' ')}${number > 1 ? '   # retry after a fetch failure or timeout' : ''}`);
    return once(command, args, options);
  };
  const result = options.retry ? retryOnFetchFailure(attempt) : attempt(1);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} ${result.timedOut ? `timed out after ${options.timeoutMs} ms` : `exited with ${result.status}`} (${classifyFailure(result)})`);
  return result;
}

/** `ironbird verify-bundle <target>` from the workspace build; returns its exit status and output. */
export function verifyBundle(cliBin, target) {
  console.log(`\n$ ironbird verify-bundle ${target} --json`);
  return once(process.execPath, [cliBin, 'verify-bundle', target, '--json'], {});
}

export function writeSummary(markdown) {
  console.log(`\n${markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
