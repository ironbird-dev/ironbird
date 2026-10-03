import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupAlive, must, run, startLogged, waitFor } from './proc.mjs';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

describe('process helpers', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-proc-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ends a timed-out run even when the direct child exited and a descendant holds its output', async () => {
    const started = Date.now();
    const result = await run('/bin/sh', ['-c', 'sleep 30 & echo $!; exit 0'], { timeoutMs: 300 });
    const sleeper = Number(result.stdout.trim());
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(Number.isInteger(sleeper) && sleeper > 0).toBe(true);
    expect(alive(sleeper)).toBe(false);
  }, 15_000);

  it('reports a timed-out run as failed even when the child exits 0 on SIGTERM', async () => {
    const script = 'trap "exit 0" TERM; sleep 30 & wait';
    const result = await run('/bin/sh', ['-c', script], { timeoutMs: 200 });
    expect(result).toMatchObject({ timedOut: true, code: 124 });
    await expect(must('/bin/sh', ['-c', script], { timeoutMs: 200 })).rejects.toThrow(/timed out after 200 ms/);
    expect(await run('/bin/sh', ['-c', 'exit 0'], { timeoutMs: 5_000 })).toMatchObject({ timedOut: false, code: 0 });
  }, 15_000);

  it('rejects, without an unhandled error, when a logged process cannot start', async () => {
    const logFile = path.join(dir, 'missing.log');
    await expect(startLogged(path.join(dir, 'no-such-command'), [], { cwd: dir, logFile })).rejects.toThrow(/could not start .*no-such-command/);
    expect(await readFile(logFile, 'utf8')).toBe('');
  });

  it('starts a logged process in its own group and reaps it', async () => {
    const logFile = path.join(dir, 'ok.log');
    const proc = await startLogged('/bin/sh', ['-c', 'trap "echo bye; exit 0" TERM; echo hello; sleep 30 & wait'], { cwd: dir, logFile });
    await waitFor(async () => (await readFile(logFile, 'utf8')).includes('hello'), { timeoutMs: 5_000, intervalMs: 20, what: 'the first line' });
    expect(groupAlive(proc.pgid)).toBe(true);
    expect(await proc.stop()).toBe(true);
    expect(groupAlive(proc.pgid)).toBe(false);
    // What the group wrote while stopping is in the log once stop() resolves.
    expect(await readFile(logFile, 'utf8')).toBe('hello\nbye\n');
  }, 15_000);

  it('bounds a probe that never answers by the overall timeout', async () => {
    const started = Date.now();
    await expect(waitFor(() => new Promise(() => {}), { timeoutMs: 200, intervalMs: 50, what: 'a stuck probe' })).rejects.toThrow('Timed out after 200 ms waiting for a stuck probe');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns the first truthy probe value', async () => {
    let calls = 0;
    expect(await waitFor(async () => (++calls >= 2 ? 'ready' : undefined), { timeoutMs: 2_000, intervalMs: 10, what: 'x' })).toBe('ready');
  });
});
