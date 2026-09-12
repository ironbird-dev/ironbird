import { z } from 'zod';
import { IronbirdError } from './errors';
import type { CommandDescription, JsonSchema } from './protocol';

export type Schemas = Record<string, z.ZodType>;

export interface CommandRegistry<T extends Schemas = Schemas> {
  readonly schemas: T;
  names(): Array<keyof T & string>;
  has(name: string): name is keyof T & string;
  /** Throws IronbirdError with UNKNOWN_COMMAND or INVALID_PAYLOAD. */
  parse<K extends keyof T & string>(name: K, payload: unknown): z.output<T[K]>;
  describe(): Record<string, CommandDescription>;
}

export type CommandOf<R extends CommandRegistry> = {
  [K in keyof R['schemas'] & string]: { name: K; payload: z.output<R['schemas'][K]> };
}[keyof R['schemas'] & string];

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distance: number[] = new Array<number>(rows * cols).fill(0);
  for (let i = 0; i < rows; i += 1) distance[i * cols] = i;
  for (let j = 0; j < cols; j += 1) distance[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distance[i * cols + j] = Math.min(
        (distance[(i - 1) * cols + j] ?? 0) + 1,
        (distance[i * cols + j - 1] ?? 0) + 1,
        (distance[(i - 1) * cols + j - 1] ?? 0) + cost,
      );
    }
  }
  return distance[rows * cols - 1] ?? 0;
}

export function suggestNames(input: string, candidates: readonly string[], max = 3): string[] {
  return candidates
    .map((candidate) => ({ candidate, distance: levenshtein(input.toLowerCase(), candidate.toLowerCase()) }))
    .sort((x, y) => x.distance - y.distance || x.candidate.localeCompare(y.candidate))
    .slice(0, max)
    .map((entry) => entry.candidate);
}

/** Best-effort walk of Zod internals for features JSON Schema can't express. */
function hasUnrepresentableFeatures(schema: unknown, seen = new Set<unknown>()): boolean {
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return false;
  seen.add(schema);
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return false;
  if (def['type'] === 'pipe' || def['type'] === 'transform' || def['type'] === 'custom') return true;
  const checks = def['checks'];
  if (Array.isArray(checks)) {
    for (const check of checks) {
      const checkDef = (check as { _zod?: { def?: { check?: unknown } } })._zod?.def;
      if (checkDef?.check === 'custom') return true;
    }
  }
  const children: unknown[] = [];
  for (const key of ['innerType', 'element', 'in', 'out', 'left', 'right', 'valueType', 'keyType']) {
    if (key in def) children.push(def[key]);
  }
  if (def['shape'] && typeof def['shape'] === 'object') children.push(...Object.values(def['shape'] as Record<string, unknown>));
  if (Array.isArray(def['options'])) children.push(...(def['options'] as unknown[]));
  if (Array.isArray(def['items'])) children.push(...(def['items'] as unknown[]));
  return children.some((child) => hasUnrepresentableFeatures(child, seen));
}

export function defineCommands<const T extends Schemas>(schemas: T): CommandRegistry<T> {
  const names = Object.keys(schemas) as Array<keyof T & string>;
  const has = (name: string): name is keyof T & string => Object.prototype.hasOwnProperty.call(schemas, name);

  return {
    schemas,
    names: () => [...names],
    has,
    parse(name, payload) {
      if (!has(name)) {
        throw new IronbirdError('UNKNOWN_COMMAND', `Unknown command ${String(name)}`, {
          name,
          suggestions: suggestNames(String(name), names),
        });
      }
      const schema = schemas[name] as z.ZodType;
      const result = schema.safeParse(payload === undefined ? {} : payload);
      if (!result.success) {
        throw new IronbirdError('INVALID_PAYLOAD', `Invalid payload for ${name}`, {
          name,
          issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message, code: issue.code })),
        });
      }
      return result.data as z.output<T[typeof name]>;
    },
    describe() {
      const out: Record<string, CommandDescription> = {};
      for (const name of names) {
        const schema = schemas[name] as z.ZodType;
        if (hasUnrepresentableFeatures(schema)) {
          console.warn(`ironbird: command ${name} uses transforms or refinements that JSON Schema can't express; agents see an under-described payload`);
        }
        const payload = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
        delete payload['$schema'];
        out[name] = schema.description === undefined ? { payload } : { description: schema.description, payload };
      }
      return out;
    },
  };
}
