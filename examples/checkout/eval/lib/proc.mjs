// Child processes for the harness. Everything runs in its own process group, so stopping Metro or
// claude also stops the processes they started.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lsofCwd, parsePgid, splitOwners } from './probes.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
export const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

/** Whether any process in group `pgid` is still alive. */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Stops process group `pgid` and every descendant still in it: SIGTERM, a bounded wait until the
 * group is empty, then SIGKILL and another bounded wait. Resolves true when the group is gone.
 */
export async function reapGroup(pgid, { graceMs = 10_000, killMs = 5_000 } = {}) {
  const gone = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!groupAlive(pgid)) return true;
      await sleep(200);
    }
    return !groupAlive(pgid);
  };
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return true;
  }
  if (await gone(graceMs)) return true;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    return true;
  }
  return gone(killMs);
}

/** Signals a child's whole process group, falling back to the child alone. */
export function killGroup(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** Runs a command to completion. Resolves with its exit code and output; never rejects on a non-zero exit. */
export function run(command, args, { cwd, env = process.env, input = '', timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => killGroup(child, 'SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 128, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** Runs a command and throws with its output when it exits non-zero. */
export async function must(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.code}\n${result.stdout.slice(-2_000)}\n${result.stderr.slice(-2_000)}`);
  return result;
}

/**
 * Starts a long-running process in its own group (its pgid is its pid) with stdout and stderr
 * appended to `logFile`. `stop()` reaps the whole group, bounded.
 */
export async function startLogged(command, args, { cwd, env = process.env, logFile }) {
  await mkdir(path.dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    pgid: child.pid,
    exited,
    async stop() {
      const reaped = await reapGroup(child.pid);
      log.end();
      return reaped;
    },
  };
}

/** Polls `check` until it returns something truthy, and returns that. Throws after `timeoutMs`, naming `what`. */
export async function waitFor(check, { timeoutMs, intervalMs = 500, what }) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Pids listening on a local TCP port, from lsof. */
export async function listeners(port) {
  const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number);
}

/** A process's group, from ps. */
export async function pgidOf(pid) {
  return parsePgid((await run('ps', ['-o', 'pgid=', '-p', String(pid)])).stdout);
}

/** A process's working directory, from lsof. */
export async function processCwd(pid) {
  return lsofCwd((await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).stdout);
}

/** Every listener on `ports`, as `{ port, pid, pgid }`. */
export async function listenerOwners(ports) {
  const found = [];
  for (const port of ports) for (const pid of await listeners(port)) found.push({ port, pid, pgid: await pgidOf(pid) });
  return found;
}

const unknownOwnerMessage = (unknown) =>
  unknown.map(({ port, pid, pgid }) => `port ${port} is held by pid ${pid} (process group ${pgid}), which this harness did not start`).join('; ') +
  '. Stop it by hand (`lsof -nP -iTCP:<port> -sTCP:LISTEN`) and run again.';

/** Fails, touching nothing, when any of `ports` is in use. */
export async function assertPortsFree(ports) {
  const owners = await listenerOwners(ports);
  if (owners.length > 0) throw new Error(unknownOwnerMessage(owners));
}

/**
 * Makes `ports` free again after the harness's processes stopped: listeners in one of
 * `ownedGroups` are reaped (bounded), and the wait for the ports is bounded by `boundMs`. A
 * listener in any other group is never touched: this throws, naming it.
 */
export async function reapPorts(ports, ownedGroups, { boundMs = 15_000 } = {}) {
  const until = Date.now() + boundMs;
  for (;;) {
    const { ours, unknown } = splitOwners(await listenerOwners(ports), ownedGroups);
    if (unknown.length > 0) throw new Error(unknownOwnerMessage(unknown));
    if (ours.length === 0) return;
    if (Date.now() > until) throw new Error(`ports ${ports.join(', ')} are still held by the harness's own processes after ${boundMs} ms: ${JSON.stringify(ours)}`);
    for (const pgid of new Set(ours.map((owner) => owner.pgid))) await reapGroup(pgid, { graceMs: 2_000, killMs: 2_000 });
  }
}

/** An APFS clone of a folder (`cp -c -R`): instant, and `node_modules` comes along. `to` must not exist. */
export async function clone(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await must('cp', ['-c', '-R', from, to]);
}
