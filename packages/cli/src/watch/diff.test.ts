import { deepEqual } from '@ironbird/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diff, escapePointerToken, patchBetween, type JsonPatchOp, type Presence } from './diff';

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const decode = (token: string): string => token.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * A strict RFC 6902 applier for the three operations `watch` emits: it throws where the RFC says
 * the operation is an error (a missing target for remove or replace, an array index past the
 * end), and also on an `add` over an existing member, which the differ must never emit.
 */
function apply(doc: Presence, patch: JsonPatchOp[]): Presence {
  let current: Presence = doc.present ? { present: true, value: structuredClone(doc.value) } : { present: false };
  for (const op of patch) {
    if (op.path === '') {
      if (op.op === 'add' && current.present) throw new Error('add at the root over a present value');
      if (op.op !== 'add' && !current.present) throw new Error(`${op.op} at a missing root`);
      current = op.op === 'remove' ? { present: false } : { present: true, value: structuredClone(op.value) };
      continue;
    }
    if (!current.present) throw new Error(`${op.path} below a missing root`);
    const tokens = op.path.slice(1).split('/').map(decode);
    const last = tokens.pop() as string;
    let parent: unknown = current.value;
    for (const token of tokens) {
      if (parent === null || typeof parent !== 'object' || !hasOwn(parent, token)) throw new Error(`no parent at ${op.path}`);
      parent = (parent as Record<string, unknown>)[token];
    }
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9]\d*)$/.test(last)) throw new Error(`bad index in ${op.path}`);
      const index = Number(last);
      if (op.op === 'add') {
        if (index > parent.length) throw new Error(`add past the end at ${op.path}`);
        parent.splice(index, 0, structuredClone(op.value));
      } else {
        if (index >= parent.length) throw new Error(`no item at ${op.path}`);
        if (op.op === 'remove') parent.splice(index, 1);
        else parent[index] = structuredClone(op.value);
      }
    } else if (parent !== null && typeof parent === 'object') {
      const object = parent as Record<string, unknown>;
      if (op.op === 'add' ? hasOwn(object, last) : !hasOwn(object, last)) throw new Error(`${op.op} at ${op.path}`);
      if (op.op === 'remove') delete object[last];
      else Object.defineProperty(object, last, { value: structuredClone(op.value), writable: true, enumerable: true, configurable: true });
    } else {
      throw new Error(`scalar parent at ${op.path}`);
    }
  }
  return current;
}

const key = fc.constantFrom('a', 'b', '~', '/', '~0', '~1', 'a/b', '');
const { json } = fc.letrec((tie) => ({
  json: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -3, max: 3 }),
    fc.constantFrom('x', 'y'),
    fc.array(tie('json'), { maxLength: 4 }),
    // fast-check's dictionaries default to null-prototype objects; the daemon's JSON never has them.
    fc.dictionary(key, tie('json'), { maxKeys: 4, noNullPrototype: true }),
  ),
}));
const presence: fc.Arbitrary<Presence> = fc.oneof(
  { arbitrary: fc.constant<Presence>({ present: false }), weight: 1 },
  { arbitrary: json.map((value): Presence => ({ present: true, value })), weight: 4 },
);

describe('escapePointerToken', () => {
  it('escapes ~ before /, per RFC 6901', () => {
    expect(escapePointerToken('a~b/c')).toBe('a~0b~1c');
    expect(escapePointerToken('~1')).toBe('~01');
    expect(escapePointerToken('')).toBe('');
  });
});

describe('diff', () => {
  it('is empty for equal values', () => {
    expect(diff({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toEqual([]);
    expect(diff('x', 'x')).toEqual([]);
  });

  it('compares objects by key: nested changes, removals, then additions', () => {
    expect(diff({ a: 1, b: { c: 2 }, d: 3 }, { a: 1, b: { c: 3 }, e: 4 })).toEqual([
      { op: 'replace', path: '/b/c', value: 3 },
      { op: 'remove', path: '/d' },
      { op: 'add', path: '/e', value: 4 },
    ]);
  });

  it('escapes ~ and / in keys', () => {
    expect(diff({ 'a/b': 1, '~': 2 }, { 'a/b': 2 })).toEqual([
      { op: 'replace', path: '/a~1b', value: 2 },
      { op: 'remove', path: '/~0' },
    ]);
  });

  it('compares arrays index by index: replaces changed items whole, removes from the highest index down, adds at the end', () => {
    expect(diff([1, 2, 3], [2, 3])).toEqual([
      { op: 'replace', path: '/0', value: 2 },
      { op: 'replace', path: '/1', value: 3 },
      { op: 'remove', path: '/2' },
    ]);
    expect(diff([1, 2, 3, 4], [9])).toEqual([
      { op: 'replace', path: '/0', value: 9 },
      { op: 'remove', path: '/3' },
      { op: 'remove', path: '/2' },
      { op: 'remove', path: '/1' },
    ]);
    expect(diff([1], [1, 2, 3])).toEqual([
      { op: 'add', path: '/1', value: 2 },
      { op: 'add', path: '/2', value: 3 },
    ]);
    expect(diff([{ a: 1, b: 1 }], [{ a: 2, b: 1 }])).toEqual([{ op: 'replace', path: '/0', value: { a: 2, b: 1 } }]);
  });

  it('replaces on a change of type', () => {
    expect(diff({ a: [1] }, { a: { 0: 1 } })).toEqual([{ op: 'replace', path: '/a', value: { 0: 1 } }]);
    expect(diff(1, '1')).toEqual([{ op: 'replace', path: '', value: '1' }]);
    expect(diff(null, {})).toEqual([{ op: 'replace', path: '', value: {} }]);
    expect(diff({}, null)).toEqual([{ op: 'replace', path: '', value: null }]);
  });
});

describe('patchBetween', () => {
  it('adds at the root when a value appears, removes it when it disappears, and is empty while missing', () => {
    expect(patchBetween({ present: false }, { present: true, value: null })).toEqual([{ op: 'add', path: '', value: null }]);
    expect(patchBetween({ present: true, value: 1 }, { present: false })).toEqual([{ op: 'remove', path: '' }]);
    expect(patchBetween({ present: false }, { present: false })).toEqual([]);
    expect(patchBetween({ present: true, value: { a: 1 } }, { present: true, value: { a: 2 } })).toEqual([{ op: 'replace', path: '/a', value: 2 }]);
  });

  it('property: applying each patch to the last printed value yields the next value, through appearances and disappearances', () => {
    fc.assert(
      fc.property(fc.array(presence, { minLength: 1, maxLength: 6 }), (sequence) => {
        let printed: Presence = { present: false };
        let rebuilt: Presence = { present: false };
        for (const next of sequence) {
          rebuilt = apply(rebuilt, patchBetween(printed, next));
          expect(rebuilt.present).toBe(next.present);
          if (next.present && rebuilt.present) expect(deepEqual(rebuilt.value, next.value)).toBe(true);
          expect(patchBetween(next, next)).toEqual([]);
          printed = next;
        }
      }),
      { numRuns: 1_000 },
    );
  });
});
