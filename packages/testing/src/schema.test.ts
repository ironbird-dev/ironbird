import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { arbitraryFromSchema, matchesSchema } from './schema';

/** The payload schema `describe()` reports: core's registry calls toJSONSchema this way and drops `$schema`. */
function described(schema: z.ZodType): Record<string, unknown> {
  const json = schema.toJSONSchema({ io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const SUPPORTED: Array<[string, z.ZodType]> = [
  ['an object with required and optional keys', z.object({ a: z.string(), b: z.number().int().min(1).optional() })],
  ['a strict object', z.strictObject({ a: z.boolean() })],
  ['an empty object', z.object({})],
  ['an enum', z.object({ method: z.enum(['card', 'saved']) })],
  ['a string const', z.literal('x')],
  ['a boolean const', z.literal(true)],
  ['a string with length bounds', z.string().min(2).max(5)],
  ['an integer with bounds', z.number().int().min(-3).max(7)],
  ['a positive integer (exclusiveMinimum)', z.number().int().positive()],
  ['an unbounded integer', z.number().int()],
  ['a number with exclusive bounds', z.number().gt(0).lt(10)],
  ['a number with inclusive bounds', z.number().min(0).max(5)],
  ['an unbounded number', z.number()],
  ['a boolean', z.boolean()],
  ['null', z.null()],
  ['a nullable string (a type array)', z.string().nullable()],
  ['a union of primitives (a type array)', z.union([z.string(), z.number()])],
  ['an array with item bounds', z.array(z.number().int()).min(1).max(3)],
  ['a union of objects (anyOf)', z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])],
  ['a nullable object (anyOf with null)', z.object({ a: z.string() }).nullable()],
  ['a discriminated union (oneOf)', z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b'), n: z.number() })])],
  ['annotations (description, default)', z.object({ m: z.enum(['a']).describe('x'), d: z.number().default(3) }).describe('top')],
  [
    "the example api fake's emit control",
    z.object({
      event: z.enum(['order.confirmed', 'payment.succeeded', 'payment.failed']),
      paymentId: z.string().optional(),
      orderId: z.string().optional(),
      totalCents: z.number().int().min(0).optional(),
      reason: z.string().optional(),
    }),
  ],
];

const UNSUPPORTED: Array<[string, z.ZodType, Array<string | number>]> = [
  ['a regex (pattern)', z.object({ sku: z.string().regex(/^[a-z]+$/) }), ['properties', 'sku', 'pattern']],
  ['an email (format)', z.email(), ['format']],
  ['multipleOf', z.number().multipleOf(5), ['multipleOf']],
  ['a record (propertyNames)', z.record(z.string(), z.number()), ['propertyNames']],
  ['a tuple (prefixItems)', z.tuple([z.string(), z.number()]), ['prefixItems']],
  ['a value with no type (z.date)', z.object({ when: z.date() }), ['properties', 'when']],
  ['a value with no type (z.unknown)', z.object({ extra: z.unknown().optional() }), ['properties', 'extra']],
];

describe('arbitraryFromSchema', () => {
  it.each(SUPPORTED)('generates only values that %s accepts', (_label, schema) => {
    const arbitrary = arbitraryFromSchema(described(schema));
    fc.assert(
      fc.property(arbitrary, (value) => schema.safeParse(value).success),
      { numRuns: 300, seed: 1 },
    );
  });

  it('always includes required keys, sometimes optional ones, and never an extra key or a null prototype', () => {
    const arbitrary = arbitraryFromSchema(described(z.object({ a: z.string(), b: z.string().optional() })));
    const values = fc.sample(arbitrary, { seed: 2, numRuns: 200 }) as Array<Record<string, unknown>>;
    expect(values.every((value) => 'a' in value)).toBe(true);
    expect(values.some((value) => 'b' in value)).toBe(true);
    expect(values.some((value) => !('b' in value))).toBe(true);
    expect(values.every((value) => Object.keys(value).every((key) => key === 'a' || key === 'b'))).toBe(true);
    expect(values.every((value) => Object.getPrototypeOf(value) === Object.prototype)).toBe(true);
  });

  it.each(UNSUPPORTED)('refuses %s with INVALID_PAYLOAD naming the command and the schema path', (_label, schema, path) => {
    const error = thrownBy(() => arbitraryFromSchema(described(schema), { name: 'cart.addItem' }));
    expect(error).toMatchObject({
      name: 'IronbirdError',
      code: 'INVALID_PAYLOAD',
      details: { name: 'cart.addItem', issues: [{ path, message: expect.stringContaining('pass a payload override') }] },
    });
    expect((error as Error).message).toContain('cart.addItem');
  });

  it('refuses $ref and additionalProperties other than false', () => {
    expect(thrownBy(() => arbitraryFromSchema({ $ref: '#/$defs/item' }))).toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'payload', issues: [{ path: ['$ref'] }] } });
    expect(thrownBy(() => arbitraryFromSchema({ type: 'object', properties: {}, additionalProperties: { type: 'number' } }))).toMatchObject({
      code: 'INVALID_PAYLOAD',
      details: { issues: [{ path: ['additionalProperties'] }] },
    });
  });

  it('refuses bounds that no value satisfies', () => {
    expect(thrownBy(() => arbitraryFromSchema({ type: 'integer', exclusiveMinimum: 1, exclusiveMaximum: 2 }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(thrownBy(() => arbitraryFromSchema({ type: 'number', minimum: 5, maximum: 1 }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(thrownBy(() => arbitraryFromSchema({ type: 'string', minLength: 3, maxLength: 1 }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(thrownBy(() => arbitraryFromSchema({ type: 'array', items: { type: 'null' }, minItems: 2, maxItems: 1 }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('generates oneOf values that match exactly one branch: an overlapping integer/number oneOf yields only non-integers', () => {
    const schema = { oneOf: [{ type: 'integer' }, { type: 'number' }] };
    const values = fc.sample(arbitraryFromSchema(schema), { seed: 3, numRuns: 300 });
    expect(values.every((value) => typeof value === 'number' && !Number.isInteger(value))).toBe(true);
    expect(values.every((value) => matchesSchema(schema, value))).toBe(true);
  });

  it('keeps a rare valid oneOf branch among many duplicates', () => {
    const schema = { oneOf: [...Array.from({ length: 1000 }, () => ({ const: 'duplicate' })), { const: 'unique' }] };
    const values = fc.sample(arbitraryFromSchema(schema), { seed: 4, numRuns: 50 });
    expect(values.every((value) => value === 'unique')).toBe(true);
  });

  it('computes the exclusive values of finite oneOf branches exactly, however rare', () => {
    // 999 is the only value in exactly one branch; 50 samples of the first branch rarely find it.
    const schema = { oneOf: [{ enum: Array.from({ length: 1000 }, (_, n) => n) }, { enum: Array.from({ length: 999 }, (_, n) => n) }] };
    const values = fc.sample(arbitraryFromSchema(schema), { seed: 5, numRuns: 100 });
    expect(new Set(values)).toEqual(new Set([999]));
  });

  it('mixes exact finite branches with probed infinite ones', () => {
    // true is in both finite branches, so only false (from the boolean) and null (from the const) are exclusive;
    // the string branch is infinite and overlaps nothing.
    const schema = { oneOf: [{ type: 'boolean' }, { enum: [true, null] }, { type: 'string', maxLength: 2 }, { const: true, type: 'string' }] };
    const values = fc.sample(arbitraryFromSchema(schema), { seed: 6, numRuns: 300 });
    expect(values.every((value) => matchesSchema(schema, value))).toBe(true);
    expect(values).toContain(false);
    expect(values).toContain(null);
    expect(values.some((value) => typeof value === 'string')).toBe(true);
    expect(values).not.toContain(true);
  });

  it('refuses a oneOf of finite branches with no exclusive value', () => {
    expect(thrownBy(() => arbitraryFromSchema({ oneOf: [{ type: ['boolean', 'null'] }, { enum: [true, false, null] }] }))).toMatchObject({
      code: 'INVALID_PAYLOAD',
      details: { issues: [{ path: ['oneOf'] }] },
    });
  });

  it('refuses a oneOf whose branches always overlap', () => {
    expect(thrownBy(() => arbitraryFromSchema({ oneOf: [{ type: 'string' }, { type: 'string' }] }, { name: 'a.b' }))).toMatchObject({
      code: 'INVALID_PAYLOAD',
      details: { name: 'a.b', issues: [{ path: ['oneOf'], message: expect.stringContaining('pass a payload override') }] },
    });
  });
});

describe('matchesSchema', () => {
  it('checks const, enum, and type', () => {
    expect(matchesSchema({ const: { a: [1] } }, { a: [1] })).toBe(true);
    expect(matchesSchema({ const: 1 }, 2)).toBe(false);
    expect(matchesSchema({ enum: ['a', 'b'] }, 'b')).toBe(true);
    expect(matchesSchema({ enum: ['a', 'b'] }, 'c')).toBe(false);
    expect(matchesSchema({ type: ['string', 'null'] }, null)).toBe(true);
    expect(matchesSchema({ type: ['string', 'null'] }, 1)).toBe(false);
  });

  it('checks numeric, string, and array bounds', () => {
    expect(matchesSchema({ type: 'integer', minimum: 1, exclusiveMaximum: 3 }, 2)).toBe(true);
    expect(matchesSchema({ type: 'integer', minimum: 1, exclusiveMaximum: 3 }, 3)).toBe(false);
    expect(matchesSchema({ type: 'integer' }, 1.5)).toBe(false);
    expect(matchesSchema({ type: 'number', exclusiveMinimum: 0 }, 0)).toBe(false);
    expect(matchesSchema({ type: 'string', minLength: 2, maxLength: 3 }, 'abcd')).toBe(false);
    expect(matchesSchema({ type: 'array', items: { type: 'null' }, maxItems: 1 }, [null, null])).toBe(false);
    expect(matchesSchema({ type: 'array', items: { type: 'null' } }, [null, 1])).toBe(false);
  });

  it('checks objects, anyOf, and oneOf', () => {
    const object = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'], additionalProperties: false };
    expect(matchesSchema(object, { a: 'x' })).toBe(true);
    expect(matchesSchema(object, { b: 1 })).toBe(false);
    expect(matchesSchema(object, { a: 'x', c: 1 })).toBe(false);
    expect(matchesSchema(object, { a: 1 })).toBe(false);
    expect(matchesSchema(object, [])).toBe(false);
    expect(matchesSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 1)).toBe(true);
    expect(matchesSchema({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1)).toBe(false);
    expect(matchesSchema({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1.5)).toBe(true);
  });
});
