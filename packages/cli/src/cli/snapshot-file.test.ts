import { isIronbirdError } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { formatSnapshotFile, parseSnapshotFile } from './snapshot-file';

const issuesOf = (text: string): unknown => {
  try {
    parseSnapshotFile(text, '/tmp/notes.json');
  } catch (error) {
    return isIronbirdError(error) ? { code: error.code, message: error.message, details: error.details } : error;
  }
  return 'accepted';
};

describe('snapshot files', () => {
  it('round-trips a record through format and parse, keeping a null snapshot and ignoring extra keys', () => {
    const record = { app: 'com.example.notes', target: 'ios', rev: 3, snapshot: { notes: ['milk'] } };
    expect(formatSnapshotFile(record)).toBe(`${JSON.stringify(record, null, 2)}\n`);
    expect(parseSnapshotFile(formatSnapshotFile(record), 'f')).toEqual(record);
    expect(parseSnapshotFile('{"app":"a","target":"t","rev":0,"snapshot":null,"note":"x"}', 'f')).toEqual({ app: 'a', target: 't', rev: 0, snapshot: null });
  });

  it('keeps a __proto__ key in the snapshot as data', () => {
    const parsed = parseSnapshotFile('{"app":"a","target":"t","rev":0,"snapshot":{"__proto__":{"y":2}}}', 'f');
    expect(Object.prototype.hasOwnProperty.call(parsed.snapshot, '__proto__')).toBe(true);
    expect(JSON.stringify(parsed.snapshot)).toBe('{"__proto__":{"y":2}}');
  });

  it('refuses text that is not JSON, JSON that is not an object, and an object of the wrong shape, listing every issue', () => {
    expect(issuesOf('{oops')).toMatchObject({
      code: 'INVALID_PAYLOAD',
      message: 'Invalid snapshot file /tmp/notes.json',
      details: { name: 'snapshotLoad', issues: [{ path: [], message: expect.stringMatching(/^not valid JSON: /) }] },
    });
    expect(issuesOf('[]')).toEqual({
      code: 'INVALID_PAYLOAD',
      message: 'Invalid snapshot file /tmp/notes.json',
      details: { name: 'snapshotLoad', issues: [{ path: [], message: 'expected an object with app, target, rev, and snapshot' }] },
    });
    expect(issuesOf('{"app":"","target":1,"rev":-1}')).toEqual({
      code: 'INVALID_PAYLOAD',
      message: 'Invalid snapshot file /tmp/notes.json',
      details: {
        name: 'snapshotLoad',
        issues: [
          { path: ['app'], message: 'expected a non-empty string' },
          { path: ['target'], message: 'expected a string' },
          { path: ['rev'], message: 'expected a non-negative integer' },
          { path: ['snapshot'], message: 'required' },
        ],
      },
    });
    expect(issuesOf('{"app":"a","target":"t","rev":1.5,"snapshot":{}}')).toMatchObject({ details: { issues: [{ path: ['rev'] }] } });
  });
});
