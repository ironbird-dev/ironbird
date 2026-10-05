import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IronbirdError, isIronbirdError } from './errors';
import { serializeState } from './serialize';
import { parseSnapshotLoadParams, serializeSnapshot } from './snapshot';

class Session {
  id = 7;
}

class Bag extends Array<number> {}

/** What serializeSnapshot threw, as `{ code, message, details }`, or 'accepted'. */
function rejection(value: unknown): unknown {
  try {
    serializeSnapshot(value);
  } catch (error) {
    return isIronbirdError(error) ? { code: error.code, message: error.message, details: error.details } : error;
  }
  return 'accepted';
}

function holey(): number[] {
  const list: number[] = [];
  list[0] = 1;
  list[2] = 3;
  return list;
}

/** An array with an enumerable own property that isn't an index; JSON.stringify would drop it. */
function withExtra(): number[] {
  const list = [1, 2];
  (list as unknown as Record<string, unknown>)['extra'] = 'x';
  return list;
}

/** An array with an enumerable symbol-keyed property; JSON.stringify would drop it. */
function withSymbolKey(): number[] {
  const list = [1];
  (list as unknown as Record<symbol, unknown>)[Symbol('tag')] = 'x';
  return list;
}

describe('serializeSnapshot', () => {
  it('returns plain JSON data and omits undefined object properties', () => {
    expect(serializeSnapshot({ a: 1, b: 'x', c: null, d: [1, 'y', null, { e: true }], f: undefined, g: { h: undefined } })).toEqual({ a: 1, b: 'x', c: null, d: [1, 'y', null, { e: true }], g: {} });
    expect(Object.keys(serializeSnapshot({ f: undefined, a: 1 }) as object)).toEqual(['a']);
    expect(serializeSnapshot(null)).toBeNull();
    expect(serializeSnapshot('text')).toBe('text');
  });

  it.each([
    ['a function', { at: { fn: () => 1 } }, 'at.fn', 'function'],
    ['a symbol', { s: Symbol('s') }, 's', 'symbol'],
    ['a BigInt', { n: 10n }, 'n', 'BigInt'],
    ['NaN', { n: Number.NaN }, 'n', 'NaN'],
    ['Infinity', { list: [1, Number.POSITIVE_INFINITY] }, 'list.1', 'Infinity'],
    ['-Infinity', { n: Number.NEGATIVE_INFINITY }, 'n', '-Infinity'],
    ['a Map', { m: new Map([['k', 1]]) }, 'm', 'Map'],
    ['a Set', { s: new Set([1]) }, 's', 'Set'],
    ['a Date', { at: new Date(0) }, 'at', 'Date'],
    ['a class instance', { session: new Session() }, 'session', 'Session'],
    ['a boxed primitive', { n: new Number(1) }, 'n', 'Number'],
    ['a typed array', { bytes: new Uint8Array(2) }, 'bytes', 'Uint8Array'],
    ['a promise', { pending: Promise.resolve(1) }, 'pending', 'Promise'],
    ['an Array subclass', { bag: Bag.from([1]) }, 'bag', 'Bag'],
    ['undefined in an array', { list: [1, undefined] }, 'list.1', 'undefined'],
    ['a hole in an array', { list: holey() }, 'list.1', 'hole'],
    ['a non-index property on an array', { items: withExtra() }, 'items.extra', 'array-property'],
    ['a symbol-keyed property on an array', { items: withSymbolKey() }, 'items.Symbol(tag)', 'symbol-key'],
    ['a symbol-keyed property on an object', { meta: { ok: 1, [Symbol('tag')]: 1 } }, 'meta.Symbol(tag)', 'symbol-key'],
    ['undefined at the root', undefined, '', 'undefined'],
    ['a Map at the root', new Map(), '', 'Map'],
  ])('rejects %s, naming its path and kind', (_label, value, path, reason) => {
    expect(rejection(value)).toMatchObject({ code: 'INVALID_SNAPSHOT', details: { path, reason } });
  });

  it('names the first lossy path in key order, and <root> in the message for the root', () => {
    expect(rejection({ ok: 1, a: { m: new Map() }, b: Number.NaN })).toEqual({
      code: 'INVALID_SNAPSHOT',
      message: "Snapshot can't be saved losslessly: Map at a.m",
      details: { path: 'a.m', reason: 'Map' },
    });
    expect(rejection(new Set())).toMatchObject({ message: "Snapshot can't be saved losslessly: Set at <root>" });
  });

  it('reports array items before an array\'s extra properties, and ignores non-enumerable extras', () => {
    // Object.keys order: indices first, then string keys, then (Reflect.ownKeys) symbols.
    const both = withExtra();
    both[1] = Number.NaN;
    expect(rejection({ items: both })).toMatchObject({ details: { path: 'items.1', reason: 'NaN' } });
    const hidden = [1, 2];
    Object.defineProperty(hidden, 'extra', { value: 'x', enumerable: false });
    Object.defineProperty(hidden, Symbol('tag'), { value: 'x', enumerable: false });
    const meta = { a: 1 };
    Object.defineProperty(meta, Symbol('tag'), { value: 'x', enumerable: false });
    expect(serializeSnapshot({ hidden, meta })).toEqual({ hidden: [1, 2], meta: { a: 1 } });
  });

  it('rejects a cycle but accepts the same object reached twice', () => {
    const shared = { n: 1 };
    expect(serializeSnapshot({ a: shared, b: [shared] })).toEqual({ a: { n: 1 }, b: [{ n: 1 }] });
    const cyclic: { inner: { list: unknown[] } } = { inner: { list: [] } };
    cyclic.inner.list.push(cyclic);
    expect(rejection(cyclic)).toMatchObject({ details: { path: 'inner.list.0', reason: 'cycle' } });
  });

  it('rejects a throwing getter and an object that cannot be inspected', () => {
    const hostile = { fine: 1 };
    Object.defineProperty(hostile, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('nope');
      },
    });
    expect(rejection({ hostile })).toMatchObject({ details: { path: 'hostile.bad', reason: 'throwing-getter' } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(rejection({ revoked: revoked.proxy })).toMatchObject({ details: { path: 'revoked', reason: 'unreadable' } });
  });

  it('accepts null-prototype objects and keeps a __proto__ key as own data on a plain object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['x'] = 1;
    expect(serializeSnapshot({ bare })).toEqual({ bare: { x: 1 } });
    const out = serializeSnapshot(JSON.parse('{"__proto__":{"y":2}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"y":2}}');
  });

  it('property: JSON values round-trip exactly', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        expect(JSON.stringify(serializeSnapshot(input))).toBe(JSON.stringify(input));
      }),
    );
  });

  it('property: never substitutes; what it accepts serializeState would copy without a warning, and the rest is INVALID_SNAPSHOT', () => {
    fc.assert(
      fc.property(
        fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true, withObjectString: true, withBoxedValues: true, withSparseArray: true, withTypedArray: true }),
        (input) => {
          let out: unknown;
          let thrown: unknown;
          try {
            out = serializeSnapshot(input);
          } catch (error) {
            thrown = error;
          }
          if (thrown !== undefined) {
            expect(isIronbirdError(thrown) && thrown.code).toBe('INVALID_SNAPSHOT');
            return;
          }
          const state = serializeState(input);
          expect(state.warnings).toEqual([]);
          expect(JSON.stringify(out)).toBe(JSON.stringify(state.value));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('parseSnapshotLoadParams', () => {
  const failure = (params: Record<string, unknown>): unknown => {
    try {
      parseSnapshotLoadParams(params, 'com.example.notes');
    } catch (error) {
      return isIronbirdError(error) ? { code: error.code, details: error.details } : error;
    }
    return 'accepted';
  };

  it('returns the snapshot, with or without a matching app, including null', () => {
    expect(parseSnapshotLoadParams({ snapshot: { a: 1 }, app: 'com.example.notes' }, 'com.example.notes')).toEqual({ snapshot: { a: 1 } });
    expect(parseSnapshotLoadParams({ snapshot: null }, 'com.example.notes')).toEqual({ snapshot: null });
  });

  it('checks app before the snapshot, and needs both well formed', () => {
    expect(failure({ snapshot: {}, app: 'com.example.other' })).toEqual({ code: 'APP_MISMATCH', details: { expected: 'com.example.notes', received: 'com.example.other' } });
    expect(failure({ app: 'com.example.other' })).toMatchObject({ code: 'APP_MISMATCH' });
    expect(failure({ snapshot: {}, app: 42 })).toEqual({ code: 'INVALID_PAYLOAD', details: { name: 'snapshotLoad', issues: [{ path: ['app'], message: 'expected a string' }] } });
    expect(failure({ snapshot: {}, app: null })).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(failure({})).toEqual({ code: 'INVALID_PAYLOAD', details: { name: 'snapshotLoad', issues: [{ path: ['snapshot'], message: 'required' }] } });
  });

  it('throws IronbirdErrors', () => {
    expect(() => parseSnapshotLoadParams({}, 'a')).toThrow(IronbirdError);
  });
});
