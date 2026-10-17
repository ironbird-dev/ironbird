import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './proc.mjs';

const PROC_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'proc.mjs')).href;

// A command whose grandchild ignores SIGINT and SIGTERM, so only SIGKILL ends it; it writes
// `<child pid> <grandchild pid>` once both are running, and hangs.
const STUBBORN = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [pidFile] = process.argv.slice(1);
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
fs.writeFileSync(pidFile, process.pid + ' ' + grandchild.pid);
setInterval(() => {}, 1000);
`;

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
      for (const pid of readFileSync(pidFile, 'utf8').split(' ').map(Number)) if (pid > 0 && isRunning(pid)) process.kill(pid, 'SIGKILL');
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

  // A leg script runs each command in its own process group, so a Ctrl-C in the terminal, which
  // reaches only the leg's group, has to be forwarded.
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('forwards %s to the running command\'s group, kills what ignores it, then exits %i', async (signal, exitCode) => {
    const leg = path.join(dir, 'leg.mjs');
    writeFileSync(leg, `import { run } from ${JSON.stringify(PROC_URL)};\nawait run(process.execPath, ['-e', ${JSON.stringify(STUBBORN)}, ${JSON.stringify(pidFile)}], { killGraceMs: 300 });\nconsole.log('run returned');\n`);
    const script = spawn(process.execPath, [leg], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    script.stdout.on('data', (chunk) => (output += chunk));
    script.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise((resolve) => script.once('exit', (code, sig) => resolve({ code, signal: sig })));
    for (let waited = 0; !existsSync(pidFile) || readFileSync(pidFile, 'utf8').split(' ').length < 2; waited += 25) {
      if (waited > 10_000) throw new Error(`the command never started: ${output}`);
      await sleep(25);
    }
    const [child, grandchild] = readFileSync(pidFile, 'utf8').split(' ').map(Number);
    script.kill(signal);
    expect(await exited).toEqual({ code: exitCode, signal: null });
    expect(isRunning(child)).toBe(false);
    expect(isRunning(grandchild)).toBe(false);
    expect(output).not.toContain('run returned');
  }, 15_000);
});
