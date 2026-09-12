import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { serializeState } from './serialize';

class Session {
  id = 7;
}

describe('serializeState', () => {
  it('passes JSON values through and omits undefined properties', () => {
    const { value, warnings } = serializeState({ a: 1, b: 'x', c: null, d: [1, 'y', null], e: { f: true }, g: undefined });
    expect(value).toEqual({ a: 1, b: 'x', c: null, d: [1, 'y', null], e: { f: true } });
    expect(warnings).toEqual([]);
  });

  it('serializes dates as ISO strings and undefined array items as null', () => {
    const { value } = serializeState({ at: new Date('2026-01-01T00:00:00.000Z'), list: [undefined] });
    expect(value).toEqual({ at: '2026-01-01T00:00:00.000Z', list: [null] });
  });

  it('replaces non-JSON values with placeholders and reports each path once', () => {
    const { value, warnings } = serializeState({
      fn: () => 1,
      big: 10n,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      map: new Map([['k', 1]]),
      set: new Set([1]),
      session: new Session(),
      nested: { items: [{ sym: Symbol('s') }] },
    });
    expect(value).toEqual({
      fn: { $unserializable: 'function' },
      big: { $unserializable: 'BigInt' },
      nan: { $unserializable: 'NaN' },
      inf: { $unserializable: 'Infinity' },
      map: { $unserializable: 'Map' },
      set: { $unserializable: 'Set' },
      session: { $unserializable: 'Session' },
      nested: { items: [{ sym: { $unserializable: 'symbol' } }] },
    });
    expect(warnings).toEqual([
      { path: 'fn', valueKind: 'function' },
      { path: 'big', valueKind: 'BigInt' },
      { path: 'nan', valueKind: 'NaN' },
      { path: 'inf', valueKind: 'Infinity' },
      { path: 'map', valueKind: 'Map' },
      { path: 'set', valueKind: 'Set' },
      { path: 'session', valueKind: 'Session' },
      { path: 'nested.items.0.sym', valueKind: 'symbol' },
    ]);
  });

  it('marks cycles but allows the same object to appear twice', () => {
    const shared = { n: 1 };
    const cyclic: Record<string, unknown> = { shared, again: shared };
    cyclic['self'] = cyclic;
    const { value, warnings } = serializeState(cyclic);
    expect(value).toEqual({ shared: { n: 1 }, again: { n: 1 }, self: { $unserializable: 'cycle' } });
    expect(warnings).toEqual([{ path: 'self', valueKind: 'cycle' }]);
  });

  it('never throws and always yields JSON-stringifiable output', () => {
    fc.assert(
      fc.property(
        fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true, withObjectString: true, withBoxedValues: true }),
        (input) => {
          const { value } = serializeState(input);
          expect(() => JSON.stringify(value)).not.toThrow();
        },
      ),
    );
  });
});
