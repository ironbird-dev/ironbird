import { isIronbirdError } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { adbReverse, listAndroidDevices, listBootedSimulators, resolveDevice, type Exec } from './devices';

const SIMCTL = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
      { udid: 'AAAA-1', name: 'iPhone 17', state: 'Booted' },
      { udid: 'BBBB-2', name: 'iPhone 17 Pro', state: 'Shutdown' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ udid: 'CCCC-3', name: 'iPad', state: 'Booted' }],
  },
});

const ADB = 'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64 model:Pixel_9 device:emu64a\nRF8N1234\tunauthorized\n\n';

function scripted(script: Record<string, { stdout?: string; error?: Error & { code?: string; stderr?: string } }>): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    const entry = script[key];
    if (!entry) throw Object.assign(new Error(`unscripted: ${key}`), { code: 'ENOENT' });
    if (entry.error) throw entry.error;
    return { stdout: Buffer.from(entry.stdout ?? ''), stderr: '' };
  };
  return { exec, calls };
}

const failure = async (promise: Promise<unknown>): Promise<{ code: string; message: string; details: unknown }> => {
  const error = await promise.catch((caught: unknown) => caught);
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return { code: error.code, message: error.message, details: error.details };
};

describe('devices', () => {
  it('lists booted simulators from simctl JSON', async () => {
    const { exec } = scripted({ 'xcrun simctl list devices booted -j': { stdout: SIMCTL } });
    expect(await listBootedSimulators(exec)).toEqual([
      { platform: 'ios', id: 'AAAA-1', name: 'iPhone 17' },
      { platform: 'ios', id: 'CCCC-3', name: 'iPad' },
    ]);
  });

  it('lists authorized adb devices with their model', async () => {
    const { exec } = scripted({ 'adb devices -l': { stdout: ADB } });
    expect(await listAndroidDevices(exec)).toEqual([{ platform: 'android', id: 'emulator-5554', name: 'Pixel_9' }]);
  });

  it('resolves in the order requested, configured, then the single candidate', async () => {
    const one = scripted({ 'xcrun simctl list devices booted -j': { stdout: JSON.stringify({ devices: { r: [{ udid: 'AAAA-1', name: 'iPhone 17', state: 'Booted' }] } }) } });
    expect(await resolveDevice({ platform: 'ios', requested: 'REQ', configured: 'CFG', exec: one.exec })).toEqual({ platform: 'ios', id: 'REQ' });
    expect(await resolveDevice({ platform: 'ios', configured: 'CFG', exec: one.exec })).toEqual({ platform: 'ios', id: 'CFG' });
    expect(one.calls).toEqual([]);
    expect(await resolveDevice({ platform: 'ios', exec: one.exec })).toEqual({ platform: 'ios', id: 'AAAA-1', name: 'iPhone 17' });
  });

  it('fails with AMBIGUOUS_DEVICE listing the candidates, for none and for several', async () => {
    const several = scripted({ 'xcrun simctl list devices booted -j': { stdout: SIMCTL } });
    const many = await failure(resolveDevice({ platform: 'ios', exec: several.exec }));
    expect(many.code).toBe('AMBIGUOUS_DEVICE');
    expect(many.message).toContain('pass --device');
    expect((many.details as { devices: Array<{ id: string }> }).devices.map((device) => device.id)).toEqual(['AAAA-1', 'CCCC-3']);
    const none = scripted({ 'adb devices -l': { stdout: 'List of devices attached\n\n' } });
    expect(await failure(resolveDevice({ platform: 'android', exec: none.exec }))).toMatchObject({ code: 'AMBIGUOUS_DEVICE', details: { platform: 'android', devices: [] } });
  });

  it('reports a missing or failing tool as SCREENSHOT_FAILED with its stderr', async () => {
    const broken = scripted({ 'adb devices -l': { error: Object.assign(new Error('adb: command failed'), { stderr: 'daemon not running' }) } });
    expect(await failure(resolveDevice({ platform: 'android', exec: broken.exec }))).toMatchObject({ code: 'SCREENSHOT_FAILED', details: { tool: 'adb', stderr: 'daemon not running' } });
    const missing = scripted({});
    expect(await failure(resolveDevice({ platform: 'ios', exec: missing.exec }))).toMatchObject({ code: 'SCREENSHOT_FAILED', details: { tool: 'simctl' } });
  });

  it('adb reverse runs once per device and skips quietly when adb is missing', async () => {
    const logs: string[] = [];
    const present = scripted({ 'adb devices -l': { stdout: ADB }, 'adb -s emulator-5554 reverse tcp:4568 tcp:4568': { stdout: '4568\n' } });
    await adbReverse(4568, { exec: present.exec, log: (line) => logs.push(line) });
    expect(present.calls).toEqual(['adb devices -l', 'adb -s emulator-5554 reverse tcp:4568 tcp:4568']);
    expect(logs).toEqual(['adb reverse tcp:4568 set up for emulator-5554']);
    const missing = scripted({});
    await adbReverse(4568, { exec: missing.exec, log: (line) => logs.push(line) });
    expect(logs[1]).toBe('adb not found; skipping adb reverse');
  });
});
