import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Shared by the device tests. Preconditions for all of them: a booted iOS Simulator, and the
// example running in Expo Go on it via `pnpm example:ios`. Each test file starts its own daemon
// on the default bridge port, 4568, which is the port the app dials, so no other `ironbird serve`
// may be running in this directory. The simulator `reloadApp` falls back to when Metro's message
// socket is unreachable is chosen by `IRONBIRD_SIM_UDID` (defaults to `booted`, ambiguous with more
// than one booted simulator).
export const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const example = path.resolve(here, '..');
export const bin = path.resolve(example, '../../packages/cli/dist/bin.js');
const METRO_MESSAGES = process.env['IRONBIRD_METRO_URL'] ?? 'ws://127.0.0.1:8081/message';
const EXPO_GO = 'host.exp.Exponent';
const SIMULATOR = process.env['IRONBIRD_SIM_UDID'] ?? 'booted';

export interface Result {
  code: number;
  json: Record<string, unknown>;
}

export type Cli = (...args: string[]) => Promise<Result>;

/** A CLI runner bound to one environment. Every invocation runs from the example directory and parses the first line of stdout. */
export function createCli(env: NodeJS.ProcessEnv): Cli {
  return async (...args) => {
    try {
      const { stdout } = await exec('node', [bin, ...args], { cwd: example, env });
      return { code: 0, json: JSON.parse(stdout.trim().split('\n')[0] ?? '{}') as Record<string, unknown> };
    } catch (error) {
      const failure = error as { code: number; stdout: string };
      return { code: failure.code, json: JSON.parse((failure.stdout ?? '').trim().split('\n')[0] || '{}') as Record<string, unknown> };
    }
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** When the daemon registered target `id`, or undefined while it is not connected. */
export async function connectedAt(ironbird: Cli, id: string): Promise<number | undefined> {
  const status = await ironbird('status');
  const targets = (status.json['targets'] as Array<{ id: string; connectedAt: number }> | undefined) ?? [];
  return targets.find((target) => target.id === id)?.connectedAt;
}

/**
 * Waits until `id` is connected. With `after`, waits for a connection registered later than that
 * timestamp, which is how a test tells the reconnected app from the one it just reloaded: the
 * old registration can outlive a reload by a poll or two.
 */
export async function waitForTarget(ironbird: Cli, id: string, timeoutMs: number, options: { after?: number } = {}): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const at = await connectedAt(ironbird, id);
    if (at !== undefined && (options.after === undefined || at > options.after)) return;
    await sleep(500);
  }
  throw new Error(`No target ${id}${options.after === undefined ? '' : ' reconnected'} after ${timeoutMs} ms. Boot a simulator and start the app with pnpm example:ios; the daemon listens for bridges on port 4568.`);
}

/**
 * Reloads the JavaScript context the way a developer's Cmd+R does: Metro's message socket
 * accepts a reload command from any client. If Expo's dev server refuses it, Expo Go is relaunched
 * instead, which is also a fresh context.
 */
export async function reloadApp(): Promise<void> {
  const viaMetro = await new Promise<boolean>((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(METRO_MESSAGES);
    } catch {
      resolve(false);
      return;
    }
    const giveUp = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 3_000);
    socket.onopen = () => {
      socket.send(JSON.stringify({ version: 2, method: 'reload' }));
      setTimeout(() => {
        clearTimeout(giveUp);
        socket.close();
        resolve(true);
      }, 200);
    };
    socket.onerror = () => {
      clearTimeout(giveUp);
      resolve(false);
    };
  });
  if (viaMetro) return;
  await exec('xcrun', ['simctl', 'terminate', SIMULATOR, EXPO_GO]).catch(() => undefined);
  await exec('xcrun', ['simctl', 'openurl', SIMULATOR, 'exp://127.0.0.1:8081']);
}

export interface DaemonProcess {
  stop(): Promise<void>;
}

/** Spawns `ironbird serve` from the example directory with the given environment and resolves once it has printed its first line. */
export async function spawnServe(env: NodeJS.ProcessEnv): Promise<DaemonProcess> {
  const daemon = spawn('node', [bin, 'serve', '--port', '0'], { cwd: example, env, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((resolve) => {
    daemon.once('exit', (code) => resolve(code));
  });
  await new Promise<void>((resolve, reject) => {
    daemon.stdout?.once('data', () => resolve());
    void exited.then((code) => reject(new Error(`serve exited early with ${code}`)));
  });
  return {
    async stop() {
      if (daemon.exitCode === null) daemon.kill('SIGTERM');
      await exited;
    },
  };
}
