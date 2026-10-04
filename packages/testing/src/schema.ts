import { IronbirdError, type JsonSchema } from '@ironbird/core';
import * as fc from 'fast-check';

type Path = Array<string | number>;
type Bound = { value: number; exclusive: boolean };

/** Keywords that describe a schema without constraining its values; ignored (M4 design §6.3). */
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', '$schema', 'deprecated', 'readOnly']);

/** Keywords the generator honors. Anything else is refused rather than guessed. */
const SUPPORTED = new Set([
  'type',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'items',
  'minItems',
  'maxItems',
]);

export interface ArbitraryFromSchemaOptions {
  /** The command or `<fake>.<control>` the schema belongs to, named in errors; default `'payload'`. */
  name?: string;
}

const isSchema = (value: unknown): value is JsonSchema => typeof value === 'object' && value !== null && !Array.isArray(value);
const pointer = (path: Path): string => (path.length === 0 ? '#' : `#/${path.join('/')}`);

/**
 * A fast-check arbitrary for the JSON Schema `describe()` reports for a payload: the subset Zod 4's
 * `toJSONSchema` emits (M4 design §6.3, Q6). Every value it generates is valid against the schema,
 * so a step it feeds never fails with INVALID_PAYLOAD. A keyword it can't honor, such as `pattern`
 * or `format`, throws INVALID_PAYLOAD naming the schema path instead of being guessed.
 */
export function arbitraryFromSchema(schema: JsonSchema, options: ArbitraryFromSchemaOptions = {}): fc.Arbitrary<unknown> {
  const name = options.name ?? 'payload';

  const invalid = (path: Path, problem: string): IronbirdError => {
    const message = `${problem}; pass a payload override for this step`;
    return new IronbirdError('INVALID_PAYLOAD', `Cannot generate a payload for ${name}: ${problem} at ${pointer(path)}; pass a payload override for this step`, {
      name,
      issues: [{ path, message }],
    });
  };

  const finite = (node: JsonSchema, key: string, path: Path): number | undefined => {
    const value = node[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid([...path, key], `${key} must be a finite number`);
    return value;
  };

  const count = (node: JsonSchema, key: string, path: Path): number | undefined => {
    const value = finite(node, key, path);
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw invalid([...path, key], `${key} must be a non-negative integer`);
    return value;
  };

  // Both an inclusive and an exclusive bound may be present; the tighter one wins.
  const lower = (node: JsonSchema, path: Path): Bound | undefined => {
    const inclusive = finite(node, 'minimum', path);
    const exclusive = finite(node, 'exclusiveMinimum', path);
    if (exclusive !== undefined && (inclusive === undefined || exclusive >= inclusive)) return { value: exclusive, exclusive: true };
    return inclusive === undefined ? undefined : { value: inclusive, exclusive: false };
  };

  const upper = (node: JsonSchema, path: Path): Bound | undefined => {
    const inclusive = finite(node, 'maximum', path);
    const exclusive = finite(node, 'exclusiveMaximum', path);
    if (exclusive !== undefined && (inclusive === undefined || exclusive <= inclusive)) return { value: exclusive, exclusive: true };
    return inclusive === undefined ? undefined : { value: inclusive, exclusive: false };
  };

  const ofType = (type: unknown, node: JsonSchema, path: Path): fc.Arbitrary<unknown> => {
    switch (type) {
      case 'null':
        return fc.constant(null);
      case 'boolean':
        return fc.boolean();
      case 'string': {
        const minLength = count(node, 'minLength', path) ?? 0;
        const maxLength = count(node, 'maxLength', path);
        if (maxLength !== undefined && maxLength < minLength) throw invalid(path, `minLength ${minLength} exceeds maxLength ${maxLength}`);
        return fc.string(maxLength === undefined ? { minLength } : { minLength, maxLength });
      }
      case 'integer': {
        const min = lower(node, path);
        const max = upper(node, path);
        const lo = min === undefined ? Number.MIN_SAFE_INTEGER : Math.max(Number.MIN_SAFE_INTEGER, min.exclusive ? Math.floor(min.value) + 1 : Math.ceil(min.value));
        const hi = max === undefined ? Number.MAX_SAFE_INTEGER : Math.min(Number.MAX_SAFE_INTEGER, max.exclusive ? Math.ceil(max.value) - 1 : Math.floor(max.value));
        if (lo > hi) throw invalid(path, 'no integer satisfies the bounds');
        return fc.integer({ min: lo, max: hi });
      }
      case 'number': {
        const min = lower(node, path);
        const max = upper(node, path);
        if (min !== undefined && max !== undefined && (min.value > max.value || (min.value === max.value && (min.exclusive || max.exclusive)))) {
          throw invalid(path, 'no number satisfies the bounds');
        }
        return fc.double({
          noNaN: true,
          noDefaultInfinity: true,
          ...(min === undefined ? {} : { min: min.value, minExcluded: min.exclusive }),
          ...(max === undefined ? {} : { max: max.value, maxExcluded: max.exclusive }),
        });
      }
      case 'array': {
        if (!('items' in node)) throw invalid(path, 'an array schema needs items');
        const item = build(node['items'], [...path, 'items']);
        const minLength = count(node, 'minItems', path) ?? 0;
        const maxLength = count(node, 'maxItems', path);
        if (maxLength !== undefined && maxLength < minLength) throw invalid(path, `minItems ${minLength} exceeds maxItems ${maxLength}`);
        return fc.array(item, maxLength === undefined ? { minLength } : { minLength, maxLength });
      }
      case 'object': {
        const properties = node['properties'] ?? {};
        if (!isSchema(properties)) throw invalid([...path, 'properties'], 'properties must be an object');
        const additional = node['additionalProperties'];
        if (additional !== undefined && additional !== false) throw invalid([...path, 'additionalProperties'], 'additionalProperties other than false is not supported');
        const required = node['required'] ?? [];
        if (!Array.isArray(required) || required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key))) {
          throw invalid([...path, 'required'], 'required must list declared properties');
        }
        const model: Record<string, fc.Arbitrary<unknown>> = {};
        for (const [key, value] of Object.entries(properties)) model[key] = build(value, [...path, 'properties', key]);
        // Only declared keys, so strict and loose objects both accept the result; never a
        // null-prototype object, which fast-check otherwise generates by default.
        return fc.record(model, { requiredKeys: required as string[], noNullPrototype: true });
      }
      default:
        throw invalid([...path, 'type'], `type ${JSON.stringify(type)} is not supported`);
    }
  };

  const build = (node: unknown, path: Path): fc.Arbitrary<unknown> => {
    if (!isSchema(node)) throw invalid(path, 'expected a schema object');
    for (const key of Object.keys(node)) {
      if (!ANNOTATIONS.has(key) && !SUPPORTED.has(key)) throw invalid([...path, key], `the keyword ${key} is not supported`);
    }
    if ('const' in node) return fc.constant(node['const']);
    if ('enum' in node) {
      const values = node['enum'];
      if (!Array.isArray(values) || values.length === 0) throw invalid([...path, 'enum'], 'enum must be a non-empty array');
      return fc.constantFrom(...(values as unknown[]));
    }
    for (const key of ['anyOf', 'oneOf'] as const) {
      if (!(key in node)) continue;
      const members = node[key];
      if (!Array.isArray(members) || members.length === 0) throw invalid([...path, key], `${key} must be a non-empty array`);
      return fc.oneof(...members.map((member: unknown, index) => build(member, [...path, key, index])));
    }
    const type = node['type'];
    if (Array.isArray(type)) {
      if (type.length === 0) throw invalid([...path, 'type'], 'type must name at least one type');
      return fc.oneof(...type.map((each: unknown) => ofType(each, node, path)));
    }
    if (type === undefined) throw invalid(path, 'the schema has no type, enum, const, anyOf, or oneOf');
    return ofType(type, node, path);
  };

  return build(schema, []);
}
