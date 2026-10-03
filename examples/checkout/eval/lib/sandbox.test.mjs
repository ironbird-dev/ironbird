import { describe, expect, it } from 'vitest';
import { ancestorsWithin, sandboxed, sandboxProfile, sbplString } from './sandbox.mjs';

const REPO = '/Users/dev/apps/ironbird';
const HOME = '/Users/dev/.ironbird-eval';
const PROJECT = '/Users/dev/.ironbird-eval/sessions/g1-1/project';

describe('sandboxProfile', () => {
  const profile = sandboxProfile({ denied: [REPO, HOME], allowed: [PROJECT] });
  const lines = profile.trim().split('\n');

  it('allows by default, denies the repository and the eval home, and re-allows the session folder', () => {
    expect(lines).toEqual([
      '(version 1)',
      '(allow default)',
      `(deny file-read* file-write* (subpath "${REPO}"))`,
      `(deny file-read* file-write* (subpath "${HOME}"))`,
      `(allow file-read-metadata (literal "${HOME}/sessions/g1-1"))`,
      `(allow file-read-metadata (literal "${HOME}/sessions"))`,
      `(allow file-read-metadata (literal "${HOME}"))`,
      `(allow file-read* file-write* (subpath "${PROJECT}"))`,
    ]);
  });

  it('puts every deny before every allow after the default, because the last matching rule wins', () => {
    const lastDeny = lines.findLastIndex((line) => line.startsWith('(deny'));
    const firstAllow = lines.findIndex((line, index) => index > 1 && line.startsWith('(allow'));
    expect(lastDeny).toBeLessThan(firstAllow);
    expect(lines.at(-1)).toBe(`(allow file-read* file-write* (subpath "${PROJECT}"))`);
  });

  it('rejects relative paths and an allowed folder outside every denied one', () => {
    expect(() => sandboxProfile({ denied: ['relative'], allowed: [] })).toThrow('absolute');
    expect(() => sandboxProfile({ denied: [REPO], allowed: ['/Users/dev/elsewhere'] })).toThrow('not inside a denied folder');
  });
});

describe('helpers', () => {
  it('escapes SBPL strings', () => {
    expect(sbplString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"');
  });

  it('lists ancestors up to the outer folder, and none for a direct child', () => {
    expect(ancestorsWithin(PROJECT, HOME)).toEqual([`${HOME}/sessions/g1-1`, `${HOME}/sessions`, HOME]);
    expect(ancestorsWithin(`${HOME}/baseline`, HOME)).toEqual([HOME]);
  });

  it('wraps a command in sandbox-exec with the profile inline', () => {
    expect(sandboxed('(version 1)', 'claude', ['-p'])).toEqual({ command: 'sandbox-exec', args: ['-p', '(version 1)', 'claude', '-p'] });
  });
});
