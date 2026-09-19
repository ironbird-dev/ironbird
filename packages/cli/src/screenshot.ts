import { IronbirdError, messageOf } from '@ironbird/core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { systemExec, type DeviceRef, type Exec } from './devices';

/** `<artifactsPath>/screenshots/<yyyymmdd>-<hhmmss>-<ms>-<target>.png` (docs/cli.md, `screenshot`). */
export function screenshotPath(artifactsPath: string, target: string, now: Date = new Date()): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}`;
  return path.join(artifactsPath, 'screenshots', `${stamp}-${target}.png`);
}

/**
 * Captures the device on the host: `xcrun simctl io <udid> screenshot <file>` for a simulator,
 * `adb -s <serial> exec-out screencap -p` for Android, whose PNG arrives on stdout.
 */
export async function captureScreenshot(options: { device: DeviceRef; outPath: string; exec?: Exec }): Promise<void> {
  const exec = options.exec ?? systemExec;
  const { device, outPath } = options;
  const tool = device.platform === 'ios' ? 'simctl' : 'adb';
  await mkdir(path.dirname(outPath), { recursive: true });
  try {
    if (device.platform === 'ios') {
      await exec('xcrun', ['simctl', 'io', device.id, 'screenshot', outPath]);
    } else {
      const { stdout } = await exec('adb', ['-s', device.id, 'exec-out', 'screencap', '-p']);
      await writeFile(outPath, stdout);
    }
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new IronbirdError('SCREENSHOT_FAILED', `Screenshot of ${device.id} failed: ${messageOf(error)}`, { tool, stderr: typeof stderr === 'string' && stderr !== '' ? stderr : messageOf(error) });
  }
}
