import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IronbirdError } from '@ironbird/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKIPPED_DETAIL } from './checks';
import { FAKE_VERSION, execFailure, fakeEnvironment } from './fake-environment';
import { doctorExitCode, runDoctor } from './run';

const IDS = ['node', 'config', 'headless', 'port', 'gitignore', 'versions', 'simctl', 'adb'];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ironbird-doctor-run-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const config = (text: string): Promise<void> => writeFile(path.join(dir, 'ironbird.config.ts'), text);

describe('runDoctor', () => {
  it('runs every check in order and exits 0 when the required ones pass', async () => {
    await config(`export default { appId: 'com.example.doctor' };\n`);
    const env = fakeEnvironment();
    const report = await runDoctor({ cwd: dir, version: FAKE_VERSION, environment: env });
    expect(report.checks.map((check) => check.id)).toEqual(IDS);
    expect(report.checks.map((check) => check.required)).toEqual([true, true, true, true, true, true, false, false]);
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(doctorExitCode(report)).toBe(0);
    expect(env.log.packages).toEqual([dir]);
  });

  it('exits 1 when a required check fails, and 0 when only optional ones do', async () => {
    await config(`export default { appId: 'com.example.doctor' };\n`);
    const skewed = await runDoctor({ cwd: dir, version: '0.2.0', environment: fakeEnvironment() });
    expect(skewed.checks.find((check) => check.id === 'versions')?.ok).toBe(false);
    expect(doctorExitCode(skewed)).toBe(1);

    const noDevices = fakeEnvironment({
      platform: 'linux',
      exec: async (file) => {
        if (file === 'adb') throw execFailure('ENOENT');
        return { stdout: Buffer.from(''), stderr: '' };
      },
    });
    const optional = await runDoctor({ cwd: dir, version: FAKE_VERSION, environment: noDevices });
    expect(optional.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual(['simctl', 'adb']);
    expect(doctorExitCode(optional)).toBe(0);
  });

  it('checks the configured host, ports, and artifacts directory', async () => {
    await config(`export default { daemon: { host: '0.0.0.0', port: 5000 }, bridge: { port: 5001 }, artifactsDir: 'out' };\n`);
    const env = fakeEnvironment();
    await runDoctor({ cwd: dir, version: FAKE_VERSION, environment: env });
    expect(env.log.http).toEqual([{ url: 'http://127.0.0.1:5000/v1/rpc', timeoutMs: 1_000 }]);
    expect(env.log.bind).toEqual([
      { host: '0.0.0.0', port: 5000 },
      { host: '0.0.0.0', port: 5001 },
    ]);
    expect(env.log.exec).toContainEqual(['git', '-C', dir, 'check-ignore', '-q', '--', 'out/']);
  });

  it('uses the defaults when the config is missing, and skips headless-dependent work when it is invalid', async () => {
    const missingEnv = fakeEnvironment();
    const missing = await runDoctor({ cwd: dir, version: FAKE_VERSION, environment: missingEnv });
    expect(missing.checks.find((check) => check.id === 'config')?.ok).toBe(false);
    expect(missingEnv.log.bind).toEqual([
      { host: '127.0.0.1', port: 4567 },
      { host: '127.0.0.1', port: 4568 },
    ]);

    await config(`export default { daemon: { port: 'eighty' } };\n`);
    const invalidEnv = fakeEnvironment();
    const invalid = await runDoctor({ cwd: dir, version: FAKE_VERSION, environment: invalidEnv });
    expect(invalid.checks.find((check) => check.id === 'port')).toMatchObject({ ok: false, detail: SKIPPED_DETAIL });
    expect(invalidEnv.log.http).toEqual([]);
    expect(invalidEnv.log.exec).toContainEqual(['git', '-C', dir, 'check-ignore', '-q', '--', '.ironbird/']);
    expect(doctorExitCode(invalid)).toBe(1);
  });

  it('reports a check that throws as failed and still runs the rest', async () => {
    await config(`export default { appId: 'com.example.doctor' };\n`);
    const env = fakeEnvironment({
      listInstalledPackages: async () => {
        throw new Error('disk on fire');
      },
    });
    const report = await runDoctor({ cwd: dir, version: FAKE_VERSION, environment: env });
    expect(report.checks.map((check) => check.id)).toEqual(IDS);
    expect(report.checks.find((check) => check.id === 'versions')).toEqual({ id: 'versions', ok: false, required: true, detail: 'check failed unexpectedly: disk on fire' });
    expect(report.checks.find((check) => check.id === 'adb')?.ok).toBe(true);
  });
});

describe('runDoctor internal faults', () => {
  afterEach(() => {
    vi.doUnmock('./project');
    vi.resetModules();
  });

  it('reports a scratch cleanup failure on the project checks, skips what depends on the config, and still runs the rest', async () => {
    vi.resetModules();
    vi.doMock('./project', () => ({
      checkProject: async () => {
        throw new IronbirdError('INTERNAL', 'Could not remove doctor scratch directory /x/.ironbird/doctor-abc: disk on fire\nsecond line');
      },
    }));
    const { runDoctor: run, doctorExitCode: exitCode } = await import('./run');
    const report = await run({ cwd: dir, version: FAKE_VERSION, environment: fakeEnvironment() });
    expect(report.checks.map((check) => check.id)).toEqual(IDS);
    const detail = 'check failed unexpectedly: Could not remove doctor scratch directory /x/.ironbird/doctor-abc: disk on fire second line';
    expect(report.checks.slice(1, 3)).toEqual([
      { id: 'config', ok: false, required: true, detail },
      { id: 'headless', ok: false, required: true, detail },
    ]);
    expect(report.checks.find((check) => check.id === 'port')).toMatchObject({ ok: false, detail: SKIPPED_DETAIL });
    expect(report.checks.find((check) => check.id === 'versions')?.ok).toBe(true);
    expect(exitCode(report)).toBe(1);
  });
});
