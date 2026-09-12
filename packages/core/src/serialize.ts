export interface SerializationWarning {
  path: string;
  valueKind: string;
}

interface Placeholder {
  $unserializable: string;
}

function isThenableLike(value: object): boolean {
  return typeof (value as { then?: unknown }).then === 'function';
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
    const object = current as object;
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? placeholder(path, 'InvalidDate') : object.toISOString();
    }
    if (ancestors.has(object)) return placeholder(path, 'cycle');
    if (object instanceof Map) return placeholder(path, 'Map');
    if (object instanceof Set) return placeholder(path, 'Set');
    if (isThenableLike(object)) return placeholder(path, 'Promise');
    if (Array.isArray(object)) {
      ancestors.add(object);
      const items = object.map((item, index) => {
        const result = visit(item, [...path, String(index)]);
        return result === undefined ? null : result;
      });
      ancestors.delete(object);
      return items;
    }
    const proto = Object.getPrototypeOf(object) as { constructor?: { name?: string } } | null;
    if (proto !== null && proto !== Object.prototype) {
      return placeholder(path, proto.constructor?.name || 'object');
    }
    ancestors.add(object);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      const result = visit(item, [...path, key]);
      if (result !== undefined) out[key] = result;
    }
    ancestors.delete(object);
    return out;
  };

  return { value: visit(value, []), warnings };
}
