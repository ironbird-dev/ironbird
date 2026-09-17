import { IronbirdError, messageOf } from '@ironbird/core';
import { execFile } from 'node:child_process';
import type { RemotePlatform } from './target-registry';

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
}

/** Runs a host tool. Injected so the daemon's device code is tested without simctl or adb. */
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

export const systemExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr: stderr.toString('utf8') }));
        return;
      }
      resolve({ stdout, stderr: stderr.toString('utf8') });
    });
  });

export interface DeviceRef {
  platform: RemotePlatform;
  id: string;
  name?: string;
}

const stderrOf = (error: unknown): string => {
  const candidate = (error as { stderr?: unknown }).stderr;
  return typeof candidate === 'string' && candidate !== '' ? candidate : messageOf(error);
};

const isMissingBinary = (error: unknown): boolean => (error as { code?: unknown }).code === 'ENOENT';

const toolFor = (platform: RemotePlatform): 'simctl' | 'adb' => (platform === 'ios' ? 'simctl' : 'adb');

export async function listBootedSimulators(exec: Exec = systemExec): Promise<DeviceRef[]> {
  const { stdout } = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  const parsed = JSON.parse(stdout.toString('utf8')) as { devices?: Record<string, Array<{ udid?: unknown; name?: unknown; state?: unknown }>> };
  const devices: DeviceRef[] = [];
  for (const runtime of Object.values(parsed.devices ?? {})) {
    for (const device of runtime) {
      if (device.state !== 'Booted' || typeof device.udid !== 'string') continue;
      devices.push({ platform: 'ios', id: device.udid, ...(typeof device.name === 'string' ? { name: device.name } : {}) });
    }
  }
  return devices;
}

export async function listAndroidDevices(exec: Exec = systemExec): Promise<DeviceRef[]> {
  const { stdout } = await exec('adb', ['devices', '-l']);
  const devices: DeviceRef[] = [];
  for (const line of stdout.toString('utf8').split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    const [serial, state] = parts;
    if (!serial || state !== 'device') continue;
    const model = parts.find((part) => part.startsWith('model:'))?.slice('model:'.length);
    devices.push({ platform: 'android', id: serial, ...(model ? { name: model } : {}) });
  }
  return devices;
}

/**
 * Which device a capture goes to: `--device`, then `devices.<platform>` from config, then the
 * single booted simulator or connected adb device. Anything else is `AMBIGUOUS_DEVICE`, listing
 * the candidates, as architecture.md §8 and spec R10 require.
 */
export async function resolveDevice(options: { platform: RemotePlatform; requested?: string | undefined; configured?: string | undefined; exec?: Exec }): Promise<DeviceRef> {
  const { platform } = options;
  if (options.requested) return { platform, id: options.requested };
  if (options.configured) return { platform, id: options.configured };
  const exec = options.exec ?? systemExec;
  let candidates: DeviceRef[];
  try {
    candidates = platform === 'ios' ? await listBootedSimulators(exec) : await listAndroidDevices(exec);
  } catch (error) {
    throw new IronbirdError('SCREENSHOT_FAILED', `Cannot list ${platform} devices: ${messageOf(error)}`, { tool: toolFor(platform), stderr: stderrOf(error) });
  }
  if (candidates.length === 1) return candidates[0] as DeviceRef;
  const what = platform === 'ios' ? 'booted iOS simulator' : 'connected Android device';
  const message = candidates.length === 0 ? `No ${what}; boot one or pass --device` : `Several ${what}s; pass --device`;
  throw new IronbirdError('AMBIGUOUS_DEVICE', message, { platform, devices: candidates });
}

/** `adb reverse` for each connected Android device so the emulator reaches the daemon's bridge port at localhost. */
export async function adbReverse(port: number, options: { exec?: Exec; log: (line: string) => void }): Promise<void> {
  const exec = options.exec ?? systemExec;
  let devices: DeviceRef[];
  try {
    devices = await listAndroidDevices(exec);
  } catch (error) {
    options.log(isMissingBinary(error) ? 'adb not found; skipping adb reverse' : `adb devices failed; skipping adb reverse: ${messageOf(error)}`);
    return;
  }
  for (const device of devices) {
    try {
      await exec('adb', ['-s', device.id, 'reverse', `tcp:${port}`, `tcp:${port}`]);
      options.log(`adb reverse tcp:${port} set up for ${device.id}`);
    } catch (error) {
      options.log(`adb reverse failed for ${device.id}: ${messageOf(error)}`);
    }
  }
}
