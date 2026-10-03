import { describe, expect, it } from 'vitest';
import { sessionVerdict } from './session.mjs';

const deadline = Date.parse('2026-10-03T12:45:00.000Z');
const ok = { reasons: [], isolation: { valid: true, problems: [] }, deadline, finishedAt: deadline - 60_000, aliveGroups: [] };

describe('sessionVerdict', () => {
  it('is valid with no reasons, a passing isolation check, teardown inside the deadline, and every group gone', () => {
    expect(sessionVerdict(ok)).toEqual({ valid: true, invalidReasons: [] });
  });

  it('keeps the reasons gathered during the run, such as a failed clone', () => {
    expect(sessionVerdict({ ...ok, reasons: ['startup: cp -c -R exited 1'], isolation: undefined })).toEqual({
      valid: false,
      invalidReasons: ['startup: cp -c -R exited 1', 'isolation: never checked, because claude did not start'],
    });
  });

  it('lists every isolation problem', () => {
    const { valid, invalidReasons } = sessionVerdict({ ...ok, isolation: { valid: false, problems: ['MCP server context7 is loaded', 'the ironbird skill is not loaded'] } });
    expect(valid).toBe(false);
    expect(invalidReasons).toEqual(['isolation: MCP server context7 is loaded', 'isolation: the ironbird skill is not loaded']);
  });

  it('is invalid when teardown finished after the absolute deadline, and says by how much', () => {
    expect(sessionVerdict({ ...ok, finishedAt: deadline + 1_500 })).toEqual({
      valid: false,
      invalidReasons: ['deadline: teardown finished 1500 ms after the absolute deadline (2026-10-03T12:45:00.000Z)'],
    });
    expect(sessionVerdict({ ...ok, finishedAt: deadline }).valid).toBe(true);
  });

  it('is invalid when any process group the harness started is still alive after the bounded reap, naming each', () => {
    expect(sessionVerdict({ ...ok, aliveGroups: [{ name: 'claude', pgid: 41_000 }, { name: 'metro', pgid: 41_200 }] }).invalidReasons).toEqual([
      'teardown: process group 41000 (claude) is still alive after the bounded reap',
      'teardown: process group 41200 (metro) is still alive after the bounded reap',
    ]);
  });

  it('reports every cause at once, in a fixed order', () => {
    const verdict = sessionVerdict({
      reasons: ['device: Timed out after 180000 ms waiting for a fresh ios target'],
      isolation: undefined,
      deadline,
      finishedAt: deadline + 10,
      aliveGroups: [{ name: 'daemon', pgid: 7 }],
    });
    expect(verdict).toEqual({
      valid: false,
      invalidReasons: [
        'device: Timed out after 180000 ms waiting for a fresh ios target',
        'isolation: never checked, because claude did not start',
        'deadline: teardown finished 10 ms after the absolute deadline (2026-10-03T12:45:00.000Z)',
        'teardown: process group 7 (daemon) is still alive after the bounded reap',
      ],
    });
  });

  it('does not change the reasons it was given', () => {
    const reasons = ['startup: x'];
    sessionVerdict({ ...ok, reasons });
    expect(reasons).toEqual(['startup: x']);
  });
});
