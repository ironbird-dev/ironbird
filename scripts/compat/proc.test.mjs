import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './proc.mjs';

// A command that stands in for a stalled npx or npm: unless `done` exists, it starts a grandchild that
// ignores SIGTERM and holds none of its parent's output pipes, writes the grandchild's pid, and hangs.
const STALLED = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [pidFile, doneFile] = process.argv.slice(1);
if (fs.existsSync(doneFile)) process.exit(0);
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
fs.writeFileSync(pidFile, String(grandchild.pid));
setInterval(() => {}, 1000);
`;

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

describe('run', () => {
  let dir;
  let pidFile;
  let doneFile;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ironbird-compat-proc-'));
    pidFile = path.join(dir, 'grandchild.pid');
    doneFile = path.join(dir, 'done');
  });
  afterEach(() => {
    // Leave nothing behind if an assertion failed before the tree was gone.
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('kills a timed-out command and its grandchildren, and waits for them, before beforeRetry runs', async () => {
    let grandchildRunningAtRetry;
    const result = await run(process.execPath, ['-e', STALLED, pidFile, doneFile], {
      retry: true,
      timeoutMs: 1_500,
      killGraceMs: 300,
      beforeRetry: () => {
        grandchildRunningAtRetry = isRunning(Number(readFileSync(pidFile, 'utf8')));
        writeFileSync(doneFile, '');
      },
    });
    expect(grandchildRunningAtRetry).toBe(false);
    expect(result.status).toBe(0);
  }, 15_000);

  it('rejects after a timeout it was not allowed to retry, with the tree already gone', async () => {
    await expect(run(process.execPath, ['-e', STALLED, pidFile, doneFile], { timeoutMs: 1_500, killGraceMs: 300 })).rejects.toThrow(/timed out after 1500 ms \(fetch-timeout\)$/);
    expect(isRunning(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  }, 15_000);

  it('rejects on a non-zero exit and resolves with the output on success', async () => {
    await expect(run(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow(/exited with 3 \(other\)$/);
    const result = await run(process.execPath, ['-e', "process.stdout.write('hello')"]);
    expect(result).toMatchObject({ status: 0, timedOut: false, stdout: 'hello' });
  });
});
