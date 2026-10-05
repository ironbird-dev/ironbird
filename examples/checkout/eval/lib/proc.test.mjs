import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { groupAlive, guardStdin, must, run, startLogged, stopGroups, waitFor } from './proc.mjs';

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

  it('does not raise an unhandled error when the child exits without reading its input', async () => {
    // The input is far larger than a pipe buffer, so it is still being written when the child is gone.
    const input = 'x'.repeat(4 * 1024 * 1024);
    const unhandled = [];
    const record = (error) => unhandled.push(error);
    process.on('uncaughtException', record);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await run('/bin/sh', ['-c', 'exit 0'], { input, timeoutMs: 10_000 })).toMatchObject({ code: 0, timedOut: false });
      }
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('uncaughtException', record);
    }
    expect(unhandled).toEqual([]);
  }, 30_000);

  it('ignores a closed stdin pipe and surfaces any other stdin error', () => {
    const child = { stdin: new EventEmitter() };
    const seen = [];
    guardStdin(child, (error) => seen.push(error.code));
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.stdin.emit('error', Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' }));
    child.stdin.emit('error', Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    expect(seen).toEqual(['ENOSPC']);
  });

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

describe('stopGroups', () => {
  const proc = (pgid, stop) => ({ pgid, stop });

  it('stops every group even when one stop throws, and reports the error', async () => {
    const stopped = [];
    const result = await stopGroups(
      [
        { name: 'metro', proc: proc(11, async () => Promise.reject(new Error('log close failed'))) },
        { name: 'daemon', proc: proc(12, async () => stopped.push(12) && true) },
      ],
      { alive: () => false, reap: async () => true },
    );
    expect(stopped).toEqual([12]);
    expect(result).toEqual({
      stopped: [
        { name: 'metro', pgid: 11, reaped: null },
        { name: 'daemon', pgid: 12, reaped: true },
      ],
      errors: ['metro (pgid 11): stop failed: log close failed'],
      aliveGroups: [],
    });
  });

  it('reaps a group again when its stop left it alive, and reports any group that survives', async () => {
    const living = new Set([21, 22]);
    const reaped = [];
    const result = await stopGroups(
      [
        { name: 'metro', proc: proc(21, async () => false) },
        { name: 'daemon', proc: proc(22, async () => false) },
      ],
      {
        alive: (pgid) => living.has(pgid),
        reap: async (pgid) => {
          reaped.push(pgid);
          if (pgid === 21) living.delete(pgid);
          return !living.has(pgid);
        },
      },
    );
    expect(reaped).toEqual([21, 22]);
    expect(result.aliveGroups).toEqual([{ name: 'daemon', pgid: 22 }]);
    expect(result.errors).toEqual([]);
  });

  it('skips entries that never started', async () => {
    expect(await stopGroups([{ name: 'metro', proc: undefined }], { alive: () => true, reap: async () => false })).toEqual({ stopped: [], errors: [], aliveGroups: [] });
  });
});
