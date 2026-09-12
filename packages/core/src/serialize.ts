export interface SerializationWarning {
  path: string;
  valueKind: string;
}

interface Placeholder {
  $unserializable: string;
}

/**
 * Converts state into JSON-safe data following JSON.stringify rules, except that values JSON
 * would throw on or silently flatten become `{ "$unserializable": "<kind>" }` and are reported.
 * `undefined` properties are omitted, as in JSON. Never throws.
 */
export function serializeState(value: unknown): { value: unknown; warnings: SerializationWarning[] } {
  const warnings: SerializationWarning[] = [];
  const ancestors = new Set<object>();

  const placeholder = (path: string[], kind: string): Placeholder => {
    warnings.push({ path: path.join('.'), valueKind: kind });
    return { $unserializable: kind };
  };

  const readProperty = (
    object: object,
    key: string,
    path: string[],
  ): { ok: true; value: unknown } | { ok: false; value: Placeholder } => {
    try {
      return { ok: true, value: (object as Record<string, unknown>)[key] };
    } catch {
      return { ok: false, value: placeholder(path, 'throwing-getter') };
    }
  };

  // Assigns via defineProperty rather than `out[key] = result` because a plain object's
  // inherited `__proto__` accessor silently swallows a bracket assignment for that key
  // instead of creating an own property, which would drop the value from the output.
  const setOwnProperty = (out: Record<string, unknown>, key: string, result: unknown): void => {
    Object.defineProperty(out, key, { value: result, writable: true, enumerable: true, configurable: true });
  };

  const visitObject = (object: object, path: string[]): unknown => {
    if (object instanceof Date) return Number.isNaN(object.getTime()) ? placeholder(path, 'InvalidDate') : object.toJSON();
    if (object instanceof Number || object instanceof String || object instanceof Boolean) return visit(object.valueOf(), path);
    if (object instanceof BigInt) return placeholder(path, 'BigInt');
    if (object instanceof Symbol) return placeholder(path, 'symbol');
    if (ancestors.has(object)) return placeholder(path, 'cycle');
    if (object instanceof Map) return placeholder(path, 'Map');
    if (object instanceof Set) return placeholder(path, 'Set');
    if (Array.isArray(object)) {
      ancestors.add(object);
      try {
        const items: unknown[] = [];
        for (let index = 0; index < object.length; index += 1) {
          const childPath = [...path, String(index)];
          const read = readProperty(object, String(index), childPath);
          const result = read.ok ? visit(read.value, childPath) : read.value;
          items.push(result === undefined ? null : result);
        }
        return items;
      } finally {
        ancestors.delete(object);
      }
    }
    const proto = Object.getPrototypeOf(object) as { constructor?: { name?: string } } | null;
    if (proto !== null && proto !== Object.prototype) return placeholder(path, proto.constructor?.name || 'object');
    ancestors.add(object);
    try {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(object)) {
        const childPath = [...path, key];
        const read = readProperty(object, key, childPath);
        const result = read.ok ? visit(read.value, childPath) : read.value;
        if (result !== undefined) setOwnProperty(out, key, result);
      }
      return out;
    } finally {
      ancestors.delete(object);
    }
  };

  const visit = (current: unknown, path: string[]): unknown => {
    switch (typeof current) {
      case 'string':
      case 'boolean':
        return current;
      case 'number':
        if (Number.isFinite(current)) return current;
        return placeholder(path, Number.isNaN(current) ? 'NaN' : current > 0 ? 'Infinity' : '-Infinity');
      case 'bigint':
        return placeholder(path, 'BigInt');
      case 'function':
        return placeholder(path, 'function');
      case 'symbol':
        return placeholder(path, 'symbol');
      case 'undefined':
        return undefined;
      case 'object':
        break;
    }
    if (current === null) return null;
    try {
      return visitObject(current as object, path);
    } catch {
      return placeholder(path, 'unreadable');
    }
  };

  return { value: visit(value, []), warnings };
}
