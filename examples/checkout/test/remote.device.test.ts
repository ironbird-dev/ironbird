import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Preconditions: a booted iOS Simulator, and the example running in Expo Go on it via
// `pnpm example:ios`. The daemon is started here on the default bridge port, 4568, which is the
// port the app dials.
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, '..');
const bin = path.resolve(example, '../../packages/cli/dist/bin.js');
const env = { ...process.env, IRONBIRD_TOKEN: undefined };
const METRO_MESSAGES = process.env['IRONBIRD_METRO_URL'] ?? 'ws://127.0.0.1:8081/message';
const EXPO_GO = 'host.exp.Exponent';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Result {
  code: number;
  json: Record<string, unknown>;
}

async function ironbird(...args: string[]): Promise<Result> {
  try {
    const { stdout } = await exec('node', [bin, ...args], { cwd: example, env });
    return { code: 0, json: JSON.parse(stdout.trim().split('\n')[0] ?? '{}') as Record<string, unknown> };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    return { code: failure.code, json: JSON.parse((failure.stdout ?? '').trim().split('\n')[0] || '{}') as Record<string, unknown> };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function targetIds(): Promise<string[]> {
  const status = await ironbird('status');
  return ((status.json['targets'] as Array<{ id: string }> | undefined) ?? []).map((target) => target.id);
}

async function waitForTarget(id: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await targetIds()).includes(id)) return;
    await sleep(500);
  }
  throw new Error(`No target ${id} after ${timeoutMs} ms. Boot a simulator and start the app with pnpm example:ios; the daemon listens for bridges on port 4568.`);
}

/**
 * Reloads the JavaScript context the way a developer's Cmd+R does: Metro's message socket
 * accepts a reload command from any client. If Expo's dev server refuses it, Expo Go is relaunched
 * instead, which is also a fresh context.
 */
async function reloadApp(): Promise<void> {
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
  await exec('xcrun', ['simctl', 'terminate', 'booted', EXPO_GO]).catch(() => undefined);
  await exec('xcrun', ['simctl', 'openurl', 'booted', 'exp://127.0.0.1:8081']);
}

let daemon: ChildProcess | undefined;
let exited: Promise<number | null>;

beforeAll(async () => {
  daemon = spawn('node', [bin, 'serve', '--port', '0'], { cwd: example, env, stdio: ['ignore', 'pipe', 'inherit'] });
  exited = new Promise<number | null>((resolve) => {
    daemon?.once('exit', (code) => resolve(code));
  });
  await new Promise<void>((resolve, reject) => {
    daemon?.stdout?.once('data', () => resolve());
    void exited.then((code) => reject(new Error(`serve exited early with ${code}`)));
  });
  await waitForTarget('ios', 90_000);
});

afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await exited;
  }
});

describe('remote mode on the iOS Simulator', () => {
  it('screenshot captures the booted simulator as a PNG', async () => {
    const shot = await ironbird('screenshot');
    expect(shot.code).toBe(0);
    expect(shot.json).toMatchObject({ target: 'ios' });
    const file = await readFile(shot.json['path'] as string);
    expect(file.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('step sends a command, settles, and captures after settling', async () => {
    const added = await ironbird('step', 'cart.addItem', '{"sku":"cut-45","qty":1}', '--path', 'cart');
    expect(added.code).toBe(0);
    expect(added.json).toMatchObject({ target: 'ios', settle: { idle: true }, settledBeforeCapture: true });
    expect(typeof (added.json['screenshot'] as { path: string }).path).toBe('string');
    const paid = await ironbird('step', 'payment.start', '{"method":"saved"}', '--path', 'order');
    expect(paid.code).toBe(0);
    expect(paid.json).toMatchObject({ state: { status: 'completed', totalCents: 4_500 }, settle: { idle: true } });
  });

  it('a reload fails the in-flight request with TARGET_DISCONNECTED and the next request runs under the same id', async () => {
    // The daemon's default target is the headless one configured in ironbird.config.ts
    // (`defaultTarget: 'headless'`), so `wait` and `state` need an explicit `--target ios` to
    // reach the connected app; `screenshot` and `step` above don't because they auto-select the
    // sole connected remote target regardless of the configured default.
    const waiting = ironbird('wait', 'order.orderId', '--equals', 'never', '--timeout', '30s', '--target', 'ios');
    await sleep(500);
    await reloadApp();
    const failed = await waiting;
    expect(failed.code).toBe(1);
    expect(failed.json).toMatchObject({ error: { code: 'TARGET_DISCONNECTED' } });
    await waitForTarget('ios', 60_000);
    const state = await ironbird('state', 'cart', '--target', 'ios');
    expect(state.code).toBe(0);
    expect(state.json['target']).toBe('ios');
  });
});
