import { IronbirdError } from '@ironbird/core';

/** The part of a Zod issue the error needs; Zod 4's `$ZodIssue` satisfies it. */
export interface SchemaIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

/**
 * `INVALID_SNAPSHOT` for the first issue the app's schema reported (M5 design D12), with the
 * protocol's dot-separated path (`''` for the whole state) and the issue's message as `reason`.
 */
export function invalidSnapshot(issues: readonly SchemaIssue[]): IronbirdError {
  const first = issues[0];
  const path = first ? first.path.map(String).join('.') : '';
  const reason = first ? first.message : 'the snapshot does not match the schema';
  return new IronbirdError('INVALID_SNAPSHOT', `Invalid snapshot${path === '' ? '' : ` at ${path}`}: ${reason}`, { path, reason });
}
