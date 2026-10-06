import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const bin = path.resolve(__dirname, '../dist/bin.js');
const example = path.resolve(__dirname, '../../../examples/checkout');
const env = { ...process.env, IRONBIRD_TOKEN: undefined, PLANT_RACE: undefined };

interface Result {
  code: number;
  json: Record<string, unknown>;
  lines: string[];
}

async function ironbird(...args: string[]): Promise<Result> {
  try {
    const { stdout } = await exec('node', [bin, ...args], { cwd: example, env });
    const lines = stdout.trim().split('\n');
    return { code: 0, json: JSON.parse(lines[0] ?? '{}') as Record<string, unknown>, lines };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    const lines = (failure.stdout ?? '').trim().split('\n');
    return { code: failure.code, json: JSON.parse(lines[0] || '{}') as Record<string, unknown>, lines };
  }
}

let daemon: ChildProcess | undefined;
let exited: Promise<number | null>;

beforeAll(async () => {
  daemon = spawn('node', [bin, 'serve', '--port', '0', '--bridge-port', '0'], { cwd: example, env, stdio: ['ignore', 'pipe', 'inherit'] });
  exited = new Promise<number | null>((resolve) => {
    daemon?.once('exit', (code) => resolve(code));
  });
  await new Promise<void>((resolve, reject) => {
    daemon?.stdout?.once('data', () => resolve());
    void exited.then((code) => reject(new Error(`serve exited early with ${code}`)));
  });
}, 30_000);

afterAll(async () => {
  if (daemon) {
    if (daemon.exitCode === null) daemon.kill('SIGTERM');
    await exited;
  }
  await rm(path.join(example, '.ironbird/daemon.json'), { force: true });
});

describe('ironbird CLI against the example app', () => {
  it('drives cart → payment → receipt headlessly using only the CLI', async () => {
    expect(Object.keys((await ironbird('commands')).json)).toEqual(['cart.addItem', 'cart.clear', 'payment.start', 'ui.setMotion']);
    expect((await ironbird('status')).json).toMatchObject({ protocol: 1, targets: [{ id: 'headless', appId: 'com.example.checkout' }] });

    await ironbird('reset');
    const added = await ironbird('send', 'cart.addItem', '{"sku":"cut-45","qty":1}', '--path', 'cart');
    expect(added.code).toBe(0);
    expect(added.json).toMatchObject({ target: 'headless', state: { subtotalCents: 4_500 }, settle: { idle: true } });

    const started = await ironbird('send', 'payment.start', '{"method":"card"}', '--path', 'payment');
    expect(started.code).toBe(0);
    expect(started.json).toMatchObject({ state: { status: 'collecting' }, settle: { idle: false, quiescent: true, nextTimerInMs: 1_200 } });

    expect((await ironbird('clock', 'advance', '1200', '--path', 'payment.status')).json).toMatchObject({ state: 'submitting', now: Date.parse('2026-01-01T00:00:01.200Z') });
    expect((await ironbird('clock', 'advance', '300ms', '--path', 'payment.status')).json).toMatchObject({ state: 'awaitingServerEcho' });
    expect((await ironbird('wait', 'payment.status', '--equals', 'awaitingServerEcho', '--timeout', '1s')).code).toBe(0);

    const done = await ironbird('clock', 'advance', '1s', '--path', 'order');
    expect(done.json).toMatchObject({ state: { status: 'completed', totalCents: 4_500 }, settle: { idle: true } });
    const events = await ironbird('events');
    expect((events.json['events'] as Array<{ name: string }>).map((e) => e.name)).toContain('order.confirmed');
    expect((await ironbird('clock', 'now')).json).toEqual({ target: 'headless', now: Date.parse('2026-01-01T00:00:02.500Z') });
  });

  it('returns structured errors with the documented exit codes', async () => {
    const invalid = await ironbird('send', 'cart.addItem', '{"sku":"x","qty":0}');
    expect(invalid.code).toBe(1);
    expect(invalid.json).toMatchObject({ error: { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['qty'] }] } } });
    const unknown = await ironbird('send', 'cart.addItems');
    expect(unknown.code).toBe(1);
    expect((unknown.json['error'] as { details: { suggestions: string[] } }).details.suggestions[0]).toBe('cart.addItem');
    const timeout = await ironbird('wait', 'order.total', '--equals', '1', '--timeout', '100ms');
    expect(timeout.code).toBe(4);
    expect(timeout.json).toMatchObject({ error: { code: 'WAIT_TIMEOUT' } });
    expect((await ironbird('status', '--daemon', 'http://127.0.0.1:1')).code).toBe(5);
    expect((await ironbird('frobnicate')).code).toBe(2);
  });

  it('reset isolates runs and settle reports the current state', async () => {
    await ironbird('send', 'cart.addItem', '{"sku":"beard-20","qty":1}');
    const reset = await ironbird('reset');
    expect(reset.json).toMatchObject({ target: 'headless', rev: 0 });
    expect((await ironbird('state', 'cart.items')).json).toEqual({ target: 'headless', rev: 0, path: 'cart.items', value: [] });
    const settle = await ironbird('settle');
    expect(settle.code).toBe(0);
    expect(settle.json).toMatchObject({ target: 'headless', idle: true });
  });

  // The waits below are bounded (two 10 s polls, 5 s for the exit, 2 s to reap) and fit in this timeout,
  // so the finally block always runs before the test is abandoned.
  it('watch prints the first value and each change as JSON lines, and exits 0 on SIGINT', { timeout: 30_000 }, async () => {
    await ironbird('reset');
    const child = spawn('node', [bin, 'watch', '--path', 'cart.items'], { cwd: example, env, stdio: ['ignore', 'pipe', 'inherit'] });
    const lines: Array<{ rev: number; patch: Array<{ op: string; path: string; value?: unknown }> }> = [];
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, end)) as (typeof lines)[number]);
        buffer = buffer.slice(end + 1);
      }
    });
    const exitCode = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const exitWithin = async (ms: number): Promise<number | null | 'timeout'> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      });
      try {
        return await Promise.race([exitCode, timeout]);
      } finally {
        clearTimeout(timer);
      }
    };
    const until = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 1_000 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!ready()) throw new Error(`timed out waiting for ${what}`);
    };
    try {
      await until(() => lines.length === 1, 'the first line');
      expect(lines[0]).toEqual({ rev: 0, patch: [{ op: 'add', path: '', value: [] }] });
      await ironbird('send', 'cart.addItem', '{"sku":"cut-45","qty":1}');
      await until(() => lines.length === 2, 'the change');
      expect(lines[1]?.patch).toEqual([{ op: 'add', path: '/0', value: expect.objectContaining({ sku: 'cut-45' }) }]);
      child.kill('SIGINT');
      expect(await exitWithin(5_000)).toBe(0);
    } finally {
      // Whatever failed above, don't leave a watch process running into the rest of the serial suite.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exitWithin(2_000);
      }
    }
  });
});
