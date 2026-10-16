import { describe, expect, it } from 'vitest';
import { classifyListeners, outsideProblems, pidsWithCwdUnder } from './session-rules.mjs';

describe('pidsWithCwdUnder', () => {
  it('reads lsof -d cwd -Fpn output and keeps processes working in the session, under either spelling', () => {
    const out = ['p10', 'fcwd', 'n/', 'p11', 'fcwd', 'n/s/project', 'p12', 'fcwd', 'n/private/s/project/node_modules', 'p13', 'fcwd', 'n/s/project-other', 'p11', 'fcwd', 'n/s/project'].join('\n');
    expect(pidsWithCwdUnder(out, ['/s/project', '/private/s/project'])).toEqual([11, 12]);
  });
});

describe('classifyListeners', () => {
  it('counts a listener as the session’s when its group was started by the harness or its process works in the session', () => {
    const owners = [
      { port: 4567, pid: 50, pgid: 50 },
      { port: 4568, pid: 51, pgid: 99 },
      { port: 8081, pid: 52, pgid: 52 },
    ];
    expect(classifyListeners(owners, { ownedGroups: [50], sessionPids: [51] })).toEqual({ ours: [owners[0], owners[1]], unknown: [owners[2]] });
  });
});

describe('outsideProblems', () => {
  it('lets temporary folders pass and keeps every other outside path', () => {
    const hits = [
      { index: 1, tool: 'Bash', path: '/tmp/main.jsbundle' },
      { index: 2, tool: 'Bash', path: '/private/var/folders/x/T/metro-cache' },
      { index: 3, tool: 'Read', path: '/Users/dev/apps/ironbird/AGENTS.md' },
      { index: 4, tool: 'Bash', path: '/Users/dev' },
    ];
    expect(outsideProblems(hits)).toEqual([hits[2], hits[3]]);
    expect(outsideProblems(hits, ['/tmp'])).toEqual([hits[1], hits[2], hits[3]]);
  });
});
