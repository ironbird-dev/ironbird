// Driving the ironbird CLI, Metro, and Expo Go in a fixture copy. The CLI is the copy's own packed
// build (node_modules/.bin/ironbird), the same binary the agent uses.
import { readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { freshIosTarget } from './grading.mjs';
import { DEVICE_TIMEOUT_MS, EXPO_GO, METRO_PORT, METRO_URL } from './paths.mjs';
import { expoGoRunning } from './probes.mjs';
import { listenerOwners, must, processCwd, run, startLogged, waitFor } from './proc.mjs';

export const ironbirdBin = (project) => path.join(project, 'node_modules', '.bin', 'ironbird');

/** Every line of stdout that parses as JSON. The CLI prints JSON when stdout is not a TTY. */
export function jsonLines(stdout) {
  return stdout.split('\n').flatMap((line) => {
    const text = line.trim();
    if (!text.startsWith('{')) return [];
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  });
}

/** Runs `ironbird <args> --json` in `project`. */
export async function ironbird(project, args, { env = process.env, timeoutMs = 300_000 } = {}) {
  const result = await run(ironbirdBin(project), [...args, '--json'], { cwd: project, env, timeoutMs });
  return { ...result, lines: jsonLines(result.stdout) };
}

async function readDaemonInfo(project) {
  try {
    return JSON.parse(await readFile(path.join(project, '.ironbird', 'daemon.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Starts `ironbird serve` in `project` and resolves once it has written a fresh daemon.json.
 * `ephemeral` binds both ports to 0, for headless-only grading, so no app can dial in. On any
 * failure the process group is reaped before the error is thrown.
 */
export async function startServe(project, { env = process.env, logFile, ephemeral = false, timeoutMs = 60_000 }) {
  await rm(path.join(project, '.ironbird', 'daemon.json'), { force: true });
  const launchedAt = Date.now();
  const proc = await startLogged(ironbirdBin(project), ['serve', ...(ephemeral ? ['--port', '0', '--bridge-port', '0'] : [])], { cwd: project, env, logFile });
  let ready = false;
  const early = proc.exited.then(({ code, signal }) => {
    if (!ready) throw new Error(`ironbird serve exited (${code ?? signal}) before it was ready; see ${logFile}`);
  });
  early.catch(() => {});
  try {
    const info = await Promise.race([
      waitFor(
        async () => {
          const current = await readDaemonInfo(project);
          return current && current.startedAt >= launchedAt - 1_000 ? current : undefined;
        },
        { timeoutMs, what: `ironbird serve in ${project}` },
      ),
      early,
    ]);
    ready = true;
    return { ...proc, info, launchedAt };
  } catch (error) {
    ready = true;
    await proc.stop();
    throw error;
  }
}

/**
 * Metro's environment: Expo's TypeScript setup off, because it would rewrite the copy's standalone
 * tsconfig.json (adding `extends: expo/tsconfig.base`) and every session would start with a change
 * the agent did not make.
 */
export const metroEnv = (env) => ({ ...env, EXPO_NO_TYPESCRIPT_SETUP: '1' });

/**
 * Starts Metro with a cleared cache (never `--ios`, which picks its own simulator) and resolves once
 * it answers /status and every process listening on its port is in the group the harness started,
 * with `project` as its working directory. On any failure the group is reaped before the error.
 */
export async function startMetro(project, { env = process.env, logFile, timeoutMs = 180_000 }) {
  const proc = await startLogged('npx', ['expo', 'start', '--clear', '--port', String(METRO_PORT)], { cwd: project, env: metroEnv(env), logFile });
  try {
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${METRO_PORT}/status`, { signal: AbortSignal.timeout(5_000) });
          return (await response.text()).includes('packager-status:running');
        } catch {
          return false;
        }
      },
      { timeoutMs, intervalMs: 1_000, what: `Metro on port ${METRO_PORT} (log: ${logFile})` },
    );
    const owners = await listenerOwners([METRO_PORT]);
    const foreign = owners.filter((owner) => owner.pgid !== proc.pgid);
    if (owners.length === 0 || foreign.length > 0) throw new Error(`port ${METRO_PORT} is not served by the Metro this harness started: ${JSON.stringify(owners)}`);
    const expected = await realpath(project);
    for (const pid of new Set(owners.map((owner) => owner.pid))) {
      const cwd = await processCwd(pid);
      if (cwd !== expected) throw new Error(`Metro on port ${METRO_PORT} (pid ${pid}) runs in ${cwd}, not ${expected}`);
    }
    return proc;
  } catch (error) {
    await proc.stop();
    throw error;
  }
}

/** Fails unless the simulator is booted. The harness never boots, shuts down, or erases a simulator. */
export async function assertBooted(udid) {
  const { stdout } = await must('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  const booted = Object.values(JSON.parse(stdout).devices).flat();
  if (!booted.some((device) => device.udid === udid)) throw new Error(`Simulator ${udid} is not booted. Boot the iPhone 17 (xcrun simctl boot ${udid}) and try again.`);
}

/** Whether Expo Go is running on the simulator, from its launchd jobs. */
export async function expoGoIsRunning(udid) {
  const { stdout } = await must('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list']);
  return expoGoRunning(stdout);
}

/** Terminates Expo Go on the simulator (not running is fine) and waits until it is really gone, the whole step bounded by `timeoutMs`. */
export async function terminateExpoGo(udid, { timeoutMs = 15_000 } = {}) {
  const until = Date.now() + timeoutMs;
  const terminate = await run('xcrun', ['simctl', 'terminate', udid, EXPO_GO], { timeoutMs });
  if (terminate.timedOut) throw new Error(`xcrun simctl terminate timed out after ${timeoutMs} ms`);
  await waitFor(async () => !(await expoGoIsRunning(udid)), { timeoutMs: Math.max(0, until - Date.now()), what: `Expo Go to stop on ${udid}` });
}

/** Opens the app from this Metro in Expo Go on the simulator, bounded by `timeoutMs`. */
export async function openExpoGo(udid, { timeoutMs = 30_000 } = {}) {
  await must('xcrun', ['simctl', 'openurl', udid, METRO_URL], { timeoutMs });
}

/** Waits for ios-platform target `id` (default `ios`) registered at or after `after` (ms since the epoch), polling `status`. */
export async function waitForIos(project, { after, id = 'ios', env = process.env, timeoutMs = DEVICE_TIMEOUT_MS }) {
  return waitFor(
    async () => {
      const status = await ironbird(project, ['status'], { env, timeoutMs: 15_000 });
      return freshIosTarget(status.lines[0]?.targets, after, id);
    },
    { timeoutMs, intervalMs: 1_000, what: `a fresh ${id} target` },
  );
}

/** The root state of a target, bounded by `timeoutMs`; a timed-out read throws rather than reporting no state. */
export async function readState(project, target, { env = process.env, timeoutMs = 30_000 } = {}) {
  const out = await ironbird(project, ['state', '--target', target], { env, timeoutMs });
  if (out.timedOut) throw new Error(`ironbird state --target ${target} timed out after ${timeoutMs} ms`);
  return out.lines[0]?.value;
}

/**
 * Runs one scenario file on a target with `ironbird scenario run` and reads the run's final state.
 * Resolves `{ exitCode, result, error, state }`: `result` is the ScenarioResult line, absent when
 * the command failed before running (an invalid file exits 2 with an `error` line instead).
 */
export async function runScenarioFile(project, file, target, { env = process.env } = {}) {
  const out = await ironbird(project, ['scenario', 'run', file, '--target', target], { env });
  const result = out.lines.find((line) => typeof line.passed === 'boolean');
  const error = result ? undefined : (out.lines.find((line) => line.error)?.error ?? { message: out.stderr.trim() || `exit ${out.code}` });
  let state;
  if (typeof result?.artifacts === 'string') {
    try {
      state = JSON.parse(await readFile(path.join(result.artifacts, 'state.json'), 'utf8'));
    } catch {
      state = undefined;
    }
  }
  return { exitCode: out.code, result, error, state };
}
