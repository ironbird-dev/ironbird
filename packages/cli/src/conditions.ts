import { IronbirdError } from '@ironbird/core';

export type Condition = { equals: unknown } | { notEquals: unknown } | { exists: boolean } | { matches: RegExp };

const KEYS = ['equals', 'notEquals', 'exists', 'matches'] as const;

export function parseCondition(params: Record<string, unknown>): Condition {
  const present = KEYS.filter((key) => key in params);
  if (present.length !== 1) {
    throw new IronbirdError('INVALID_PAYLOAD', 'waitFor needs exactly one of equals, notEquals, exists, matches', {
      name: 'waitFor',
      issues: [{ path: [], message: `expected exactly one condition, got ${present.length}` }],
    });
  }
  const key = present[0] as (typeof KEYS)[number];
  switch (key) {
    case 'equals':
      return { equals: params['equals'] };
    case 'notEquals':
      return { notEquals: params['notEquals'] };
    case 'exists': {
      const exists = params['exists'];
      if (typeof exists !== 'boolean') {
        throw new IronbirdError('INVALID_PAYLOAD', 'exists must be a boolean', {
          name: 'waitFor',
          issues: [{ path: ['exists'], message: 'expected a boolean' }],
        });
      }
      return { exists };
    }
    case 'matches': {
      const pattern = params['matches'];
      if (typeof pattern !== 'string') {
        throw new IronbirdError('INVALID_PAYLOAD', 'matches must be a string', {
          name: 'waitFor',
          issues: [{ path: ['matches'], message: 'expected a string' }],
        });
      }
      try {
        return { matches: new RegExp(pattern) };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        throw new IronbirdError('INVALID_PAYLOAD', `matches is not a valid regular expression: ${message}`, {
          name: 'waitFor',
          issues: [{ path: ['matches'], message }],
        });
      }
    }
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

export function conditionHolds(value: unknown, condition: Condition): boolean {
  if ('equals' in condition) return deepEqual(value, condition.equals);
  if ('notEquals' in condition) return !deepEqual(value, condition.notEquals);
  if ('exists' in condition) return (value !== undefined) === condition.exists;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return false;
  return condition.matches.test(String(value));
}
