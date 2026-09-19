import { isIronbirdError } from '@ironbird/core';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from './devices';
import { captureScreenshot, screenshotPath } from './screenshot';

describe('screenshotPath', () => {
  it('names files by timestamp and target under the artifacts dir', () => {
    expect(screenshotPath('/tmp/.ironbird', 'ios', new Date('2026-09-14T01:43:01.123Z'))).toBe('/tmp/.ironbird/screenshots/20260914-014301-123-ios.png');
  });
});

describe('captureScreenshot', () => {
  let temp: string;

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('captures a simulator through simctl into the requested file', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-shot-'));
    const calls: string[] = [];
    const outPath = path.join(temp, 'nested', 'shot.png');
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args].join(' '));
      return { stdout: Buffer.alloc(0), stderr: '' };
    };
    await captureScreenshot({ device: { platform: 'ios', id: 'AAAA-1' }, outPath, exec });
    expect(calls).toEqual([`xcrun simctl io AAAA-1 screenshot ${outPath}`]);
  });

  it('captures an Android device by writing screencap stdout', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-shot-'));
    const outPath = path.join(temp, 'shot.png');
    const exec: Exec = async (file, args) => {
      expect([file, ...args].join(' ')).toBe('adb -s emulator-5554 exec-out screencap -p');
      return { stdout: Buffer.from('PNGDATA'), stderr: '' };
    };
    await captureScreenshot({ device: { platform: 'android', id: 'emulator-5554' }, outPath, exec });
    expect((await readFile(outPath)).toString()).toBe('PNGDATA');
  });

  it('reports a failing tool as SCREENSHOT_FAILED with tool and stderr', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-shot-'));
    const exec: Exec = async () => {
      throw Object.assign(new Error('simctl failed'), { stderr: 'No devices are booted.' });
    };
    const error = await captureScreenshot({ device: { platform: 'ios', id: 'AAAA-1' }, outPath: path.join(temp, 'x.png'), exec }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('SCREENSHOT_FAILED');
    expect(isIronbirdError(error) && error.details).toEqual({ tool: 'simctl', stderr: 'No devices are booted.' });
  });
});
