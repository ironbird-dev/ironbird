import type { Exec } from '../devices';
import type { DoctorEnvironment } from './environment';

// Test support for the doctor checks, kept beside them like headless test apps; nothing in the
// published entry points imports it.

export const FAKE_VERSION = '0.1.0';
export const FAKE_UDID = '9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6';

export interface FakeLog {
  exec: string[][];
  http: Array<{ url: string; timeoutMs: number }>;
  bind: Array<{ host: string; port: number }>;
  packages: string[];
}

/** A host tool failure shaped like `systemExec`'s: `code` is the exit status, or `'ENOENT'` for a missing binary. */
export function execFailure(code: number | string, stderr = ''): Error {
  return Object.assign(new Error(`Command failed (${String(code)})`), { code, stderr });
}

const SIMCTL_BOOTED = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ udid: FAKE_UDID, name: 'iPhone 17', state: 'Booted' }] } });
const ADB_DEVICES = 'List of devices attached\nemulator-5554          device product:sdk_gphone64 model:Pixel_8 device:emu64a transport_id:1\n';

function output(file: string, args: string[]): string {
  if (file === 'xcrun') return SIMCTL_BOOTED;
  if (file === 'adb') return ADB_DEVICES;
  if (file === 'git' && args.includes('rev-parse')) return '/fake/repo\n';
  return '';
}

/**
 * An environment in which every doctor check passes, recording what each probe was asked. Pass
 * `overrides` to make one probe misbehave; overridden members do not write to `log`.
 */
export function fakeEnvironment(overrides: Partial<DoctorEnvironment> = {}): DoctorEnvironment & { log: FakeLog } {
  const log: FakeLog = { exec: [], http: [], bind: [], packages: [] };
  const exec: Exec = async (file, args) => {
    log.exec.push([file, ...args]);
    return { stdout: Buffer.from(output(file, args)), stderr: '' };
  };
  return {
    nodeVersion: '22.12.0',
    platform: 'darwin',
    exec,
    probeHttp: async (url, timeoutMs) => {
      log.http.push({ url, timeoutMs });
      return { kind: 'unreachable', code: 'ECONNREFUSED' };
    },
    tryBind: async (host, port) => {
      log.bind.push({ host, port });
      return { ok: true };
    },
    listInstalledPackages: async (fromDir) => {
      log.packages.push(fromDir);
      return ['@ironbird/cli', '@ironbird/core', '@ironbird/react-native'].map((name) => ({ name, version: FAKE_VERSION, dir: `${fromDir}/node_modules/${name}` }));
    },
    ...overrides,
    log,
  };
}
