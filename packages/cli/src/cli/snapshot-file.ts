import { IronbirdError, messageOf } from '@ironbird/core';

/** What `ironbird snapshot save` writes (M5 design §4). `target` is informational. */
export interface SnapshotFile {
  app: string;
  target: string;
  rev: number;
  snapshot: unknown;
}

interface Issue {
  path: Array<string | number>;
  message: string;
}

const invalid = (file: string, issues: Issue[]): IronbirdError => new IronbirdError('INVALID_PAYLOAD', `Invalid snapshot file ${file}`, { name: 'snapshotLoad', issues });

/**
 * Validates a snapshot file before anything is sent (M5 design §4). Hand-checked rather than
 * through Zod, which the client commands don't load. Every shape problem is listed at once.
 */
export function parseSnapshotFile(text: string, file: string): SnapshotFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(file, [{ path: [], message: `not valid JSON: ${messageOf(error)}` }]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid(file, [{ path: [], message: 'expected an object with app, target, rev, and snapshot' }]);
  }
  const record = parsed as Record<string, unknown>;
  const issues: Issue[] = [];
  const { app, target, rev } = record;
  if (typeof app !== 'string' || app === '') issues.push({ path: ['app'], message: 'expected a non-empty string' });
  if (typeof target !== 'string') issues.push({ path: ['target'], message: 'expected a string' });
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) issues.push({ path: ['rev'], message: 'expected a non-negative integer' });
  if (!Object.prototype.hasOwnProperty.call(record, 'snapshot')) issues.push({ path: ['snapshot'], message: 'required' });
  if (issues.length > 0) throw invalid(file, issues);
  return { app: app as string, target: target as string, rev: rev as number, snapshot: record['snapshot'] };
}

export function formatSnapshotFile(record: SnapshotFile): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
