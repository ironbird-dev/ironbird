// I/O helpers for the compat legs: run a command with its output echoed, a time limit when asked,
// and one retry after a fetch failure or a fetch timeout when asked; run verify-bundle without
// throwing; and add a table to the step summary.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyFailure, retryOnFetchFailure } from './lib.mjs';

/** How long a timed-out command's process group gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 10_000;

/** True while any process in the group led by `pgid` is still alive (POSIX; the legs run on macOS and Linux). */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/**
 * SIGTERM to the whole process group, SIGKILL to whatever is left after `graceMs`, and resolves only
 * once no process in the group is alive, so nothing from a killed attempt outlives it: npx and npm
 * start children of their own, and those may hold no pipe to us.
 */
async function killGroup(pgid, graceMs) {
  signalGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  let killed = false;
  while (groupAlive(pgid)) {
    if (!killed && Date.now() >= deadline) {
      signalGroup(pgid, 'SIGKILL');
      killed = true;
    }
    await sleep(50);
  }
}

/**
 * Runs a command once in its own process group, echoing its output as it arrives. At `timeoutMs` it
 * kills the group and waits for it to be gone; that is a result here (`timedOut: true`), not an
 * exception. Resolves after the command has exited and its output streams have closed.
 */
async function once(command, args, options) {
  const started = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });

  let timedOut = false;
  let killing;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          killing = killGroup(child.pid, options.killGraceMs ?? KILL_GRACE_MS);
        }, options.timeoutMs);
  let code;
  try {
    code = await closed;
  } finally {
    clearTimeout(timer);
  }
  await killing;

  const note = timedOut ? `\n[compat] ${command} timed out after ${options.timeoutMs} ms` : '';
  console.log(`[compat] ${[command, ...args].slice(0, 4).join(' ')} took ${Math.round((Date.now() - started) / 1000)} s${timedOut ? ' (timed out)' : ''}`);
  return { status: timedOut ? 1 : (code ?? 1), timedOut, stdout, output: `${stdout}\n${stderr}${note}` };
}

/**
 * Runs a command and rejects on a non-zero exit or a timeout. `timeoutMs` kills its whole process
 * tree at that limit (`killGraceMs` between SIGTERM and SIGKILL). `retry: true` allows one more
 * attempt after a fetch failure or a fetch timeout (classifyFailure), calling `beforeRetry()` first,
 * once the first attempt's tree is gone, so a half-finished attempt can be cleared away.
 */
export async function run(command, args, options = {}) {
  const attempt = async (number) => {
    if (number > 1) await options.beforeRetry?.();
    console.log(`\n$ ${[command, ...args].join(' ')}${number > 1 ? '   # retry after a fetch failure or timeout' : ''}`);
    return once(command, args, options);
  };
  const result = options.retry ? await retryOnFetchFailure(attempt) : await attempt(1);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} ${result.timedOut ? `timed out after ${options.timeoutMs} ms` : `exited with ${result.status}`} (${classifyFailure(result)})`);
  return result;
}

/** `ironbird verify-bundle <target>` from the workspace build; resolves to its exit status and output. */
export function verifyBundle(cliBin, target) {
  console.log(`\n$ ironbird verify-bundle ${target} --json`);
  return once(process.execPath, [cliBin, 'verify-bundle', target, '--json'], {});
}

export function writeSummary(markdown) {
  console.log(`\n${markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
