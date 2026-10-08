import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const example = path.resolve(__dirname, '..');
const bin = path.resolve(example, '../../packages/cli/dist/bin.js');
const env = { ...process.env, IRONBIRD_TOKEN: undefined, PLANT_BUG: undefined };

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

describe('ironbird CLI against the bare-redux example', () => {
  it('serves the headless entry and lists the three commands', async () => {
    expect((await ironbird('status')).json).toMatchObject({ protocol: 1, targets: [{ id: 'headless', appId: 'com.example.bareredux' }] });
    expect(Object.keys((await ironbird('commands')).json).sort()).toEqual(['todos.add', 'todos.rename', 'todos.toggle']);
  });

  it('runs every scenario in ironbird/scenarios', async () => {
    const run = await ironbird('scenario', 'run', 'ironbird/scenarios');
    expect(run.code).toBe(0);
    const results = run.lines.map((line) => JSON.parse(line) as { scenario: string; passed: boolean });
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it('saves a snapshot, loads it back over a later edit, and refuses one that fails the schema', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-bare-redux-'));
    try {
      expect((await ironbird('reset')).code).toBe(0);
      expect((await ironbird('send', 'todos.add', '{"title":"Buy milk"}')).code).toBe(0);
      expect((await ironbird('clock', 'advance', '300')).code).toBe(0);

      const file = path.join(dir, 'saved.json');
      expect((await ironbird('snapshot', 'save', file)).code).toBe(0);
      const saved = JSON.parse(await readFile(file, 'utf8')) as { snapshot: Record<string, unknown> } & Record<string, unknown>;
      expect(saved).toMatchObject({
        app: 'com.example.bareredux',
        target: 'headless',
        snapshot: { todos: { items: [{ id: 't1', title: 'Buy milk', done: false, rev: 1, syncedRev: 1 }], nextId: 2 }, sync: { inFlight: 0, lastError: null } },
      });

      expect((await ironbird('send', 'todos.toggle', '{"id":"t1"}')).code).toBe(0);
      expect((await ironbird('snapshot', 'load', file)).code).toBe(0);
      expect((await ironbird('state', 'todos.items.0')).json).toMatchObject({ value: { done: false, rev: 1, syncedRev: 1 } });

      const bad = path.join(dir, 'bad.json');
      await writeFile(bad, JSON.stringify({ ...saved, snapshot: { ...saved.snapshot, todos: { items: 'none', nextId: 2 } } }));
      const refused = await ironbird('snapshot', 'load', bad);
      expect(refused.code).toBe(1);
      expect(refused.json).toMatchObject({ error: { code: 'INVALID_SNAPSHOT' } });
      expect((await ironbird('state', 'todos.items.0')).json).toMatchObject({ value: { done: false, rev: 1 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an edit to a missing to-do as DISPATCH_FAILED and a blank title as INVALID_PAYLOAD', async () => {
    await ironbird('reset');
    const missing = await ironbird('send', 'todos.toggle', '{"id":"t9"}');
    expect(missing.code).toBe(1);
    expect(missing.json).toMatchObject({ error: { code: 'DISPATCH_FAILED', details: { name: 'todos.toggle', message: 'No to-do with id t9' } } });

    const blank = await ironbird('send', 'todos.add', '{"title":"   "}');
    expect(blank.code).toBe(1);
    expect(blank.json).toMatchObject({ error: { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['title'] }] } } });
    expect((await ironbird('state', 'todos.items')).json).toMatchObject({ value: [] });
  });
});
