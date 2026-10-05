import { describe, expect, it } from 'vitest';
import { deadlineBudget, expoGoRunning, lsofCwd, lsofPids, parsePgid, splitOwners } from './probes.mjs';

describe('probes', () => {
  it('sees Expo Go only when its launchd job has a pid', () => {
    const running = 'PID\tStatus\tLabel\n412\t0\tUIKitApplication:host.exp.Exponent[a1b2][rb-legacy]\n-\t0\tcom.apple.Maps\n';
    const stopped = 'PID\tStatus\tLabel\n-\t-9\tUIKitApplication:host.exp.Exponent[a1b2][rb-legacy]\n';
    expect(expoGoRunning(running)).toBe(true);
    expect(expoGoRunning(stopped)).toBe(false);
    expect(expoGoRunning('')).toBe(false);
  });

  it('reads the cwd from lsof field output', () => {
    expect(lsofCwd('p8123\nfcwd\nn/Users/dev/.ironbird-eval/sessions/g1-1/project\n')).toBe('/Users/dev/.ironbird-eval/sessions/g1-1/project');
    expect(lsofCwd('p8123\n')).toBeUndefined();
  });

  it('reads a process group id', () => {
    expect(parsePgid('  8120\n')).toBe(8120);
    expect(parsePgid('')).toBeUndefined();
  });

  it('cuts a wait to the time left before the deadline', () => {
    expect(deadlineBudget(10_000, 2_000, 60_000)).toBe(8_000);
    expect(deadlineBudget(10_000, 2_000, 1_000)).toBe(1_000);
    expect(deadlineBudget(10_000, 12_000, 1_000)).toBe(0);
  });

  it('tells lsof finding no listener apart from a failed lsof', () => {
    expect(lsofPids({ code: 0, stdout: '8123\n8124\n', stderr: '' }, 'port 8081')).toEqual([8123, 8124]);
    expect(lsofPids({ code: 1, stdout: '', stderr: '' }, 'port 8081')).toEqual([]);
    expect(() => lsofPids({ code: 1, stdout: '', stderr: 'lsof: unknown service x for tcp\n' }, 'port 8081')).toThrow('lsof failed for port 8081 (exit 1): lsof: unknown service');
    expect(() => lsofPids({ code: 128, stdout: '', stderr: '' }, 'port 8081')).toThrow('lsof failed for port 8081 (exit 128)');
    expect(() => lsofPids({ code: 0, stdout: 'p8123\n', stderr: '' }, 'port 8081')).toThrow('other than a pid');
  });

  it('never counts a listener from a group the harness did not start as its own', () => {
    const listeners = [
      { port: 8081, pid: 10, pgid: 7 },
      { port: 4567, pid: 11, pgid: 99 },
    ];
    expect(splitOwners(listeners, [7])).toEqual({ ours: [listeners[0]], unknown: [listeners[1]] });
  });
});
