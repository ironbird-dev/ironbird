import { isIronbirdError } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { conditionHolds, deepEqual, parseCondition } from './conditions';

describe('conditions', () => {
  it('parses exactly one condition and rejects zero or several', () => {
    expect(parseCondition({ path: 'a', equals: 1 })).toEqual({ equals: 1 });
    expect(parseCondition({ exists: false })).toEqual({ exists: false });
    for (const bad of [{}, { equals: 1, exists: true }]) {
      const error = (() => {
        try {
          parseCondition(bad);
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(isIronbirdError(error) && error.code).toBe('INVALID_PAYLOAD');
    }
  });

  it('evaluates equals, notEquals, exists, and matches', () => {
    expect(conditionHolds({ a: [1, { b: 2 }] }, { equals: { a: [1, { b: 2 }] } })).toBe(true);
    expect(conditionHolds('x', { notEquals: 'x' })).toBe(false);
    expect(conditionHolds(undefined, { exists: false })).toBe(true);
    expect(conditionHolds(null, { exists: true })).toBe(true);
    expect(conditionHolds('awaitingServerEcho', { matches: '^awaiting' })).toBe(true);
    expect(conditionHolds(42, { matches: '^4' })).toBe(true);
    expect(conditionHolds({ a: 1 }, { matches: 'a' })).toBe(false);
  });

  it('deepEqual ignores key order but not array order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(NaN, NaN)).toBe(true);
  });
});
