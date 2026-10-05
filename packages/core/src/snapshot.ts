import { IronbirdError, isIronbirdError } from './errors';

/**
 * Copies what a `Target`'s `persist` returned into JSON-safe data, or throws `INVALID_SNAPSHOT`
 * with `{ path, reason }` for the first value JSON can't carry exactly (M5 design §4). Unlike
 * `serializeState`, which substitutes placeholders so a state read never fails, a snapshot is
 * either exact or refused: a placeholder would load back as corrupt state. `undefined` object
 * properties are omitted, as JSON does, because persisted XState snapshots carry them.
 */
export function serializeSnapshot(value: unknown): unknown {
  const ancestors = new Set<object>();

  const fail = (path: string[], reason: string): never => {
    const at = path.join('.');
    throw new IronbirdError('INVALID_SNAPSHOT', `Snapshot can't be saved losslessly: ${reason} at ${at === '' ? '<root>' : at}`, { path: at, reason });
  };

  // A non-plain object is reported by its constructor's name: Map, Date, Uint8Array, or a class.
  const kindOf = (proto: object): string => {
    try {
      const ctor = (proto as { constructor?: unknown }).constructor;
      return typeof ctor === 'function' && ctor.name !== '' ? ctor.name : 'object';
    } catch {
      return 'object';
    }
  };

  const read = (object: object, key: string, path: string[]): unknown => {
    try {
      return (object as Record<string, unknown>)[key];
    } catch {
      return fail(path, 'throwing-getter');
    }
  };

  // defineProperty rather than `out[key] = item`: a plain object's inherited `__proto__` setter
  // would swallow that key instead of creating an own property (see serializeState).
  const setOwn = (out: Record<string, unknown>, key: string, item: unknown): void => {
    Object.defineProperty(out, key, { value: item, writable: true, enumerable: true, configurable: true });
  };

  // A canonical array index: `0` or a decimal without a leading zero, below the array's length.
  const isIndex = (key: string, length: number): boolean => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length;

  // Enumerable own data that JSON.stringify drops silently: on an array, any string key that isn't an
  // index (`items.extra`); on an array or a plain object, any symbol key (`meta.Symbol(tag)`). They
  // are reported after the keys JSON keeps, in Reflect.ownKeys order. Non-enumerable keys are
  // ignored, as JSON ignores them.
  const failDropped = (dropped: ReadonlyArray<string | symbol>, path: string[]): void => {
    const key = dropped[0];
    if (key === undefined) return;
    if (typeof key === 'symbol') fail([...path, String(key)], 'symbol-key');
    else fail([...path, key], 'array-property');
  };

  // Every reflective read below can reach a Proxy trap or a hostile getter. A failure that isn't
  // already an IronbirdError (a nested INVALID_SNAPSHOT passes through) means the object can't be inspected.
  const visitObject = (object: object, path: string[]): unknown => {
    try {
      return inspectObject(object, path);
    } catch (error) {
      if (isIronbirdError(error)) throw error;
      return fail(path, 'unreadable');
    }
  };

  const hasOwn = (object: object, index: number, path: string[]): boolean => {
    try {
      return Object.prototype.hasOwnProperty.call(object, index);
    } catch {
      return fail(path, 'unreadable');
    }
  };

  const inspectObject = (object: object, path: string[]): unknown => {
    if (ancestors.has(object)) return fail(path, 'cycle');
    let proto: object | null;
    let isArray: boolean;
    let keys: string[];
    let dropped: Array<string | symbol>;
    try {
      proto = Object.getPrototypeOf(object) as object | null;
      isArray = Array.isArray(object);
      const own = Object.keys(object);
      const length = isArray ? (object as unknown[]).length : 0;
      keys = isArray ? [] : own;
      dropped = [
        ...(isArray ? own.filter((key) => !isIndex(key, length)) : []),
        ...Object.getOwnPropertySymbols(object).filter((key) => Object.prototype.propertyIsEnumerable.call(object, key)),
      ];
    } catch {
      // A revoked Proxy, or one whose traps throw, can't be inspected at all.
      return fail(path, 'unreadable');
    }
    if (isArray) {
      if (proto !== Array.prototype) return fail(path, proto === null ? 'object' : kindOf(proto));
      const array = object as unknown[];
      ancestors.add(object);
      try {
        const items: unknown[] = [];
        for (let index = 0; index < array.length; index += 1) {
          const childPath = [...path, String(index)];
          if (!hasOwn(array, index, childPath)) return fail(childPath, 'hole');
          const item = visit(read(array, String(index), childPath), childPath);
          if (item === undefined) return fail(childPath, 'undefined');
          items.push(item);
        }
        failDropped(dropped, path);
        return items;
      } finally {
        ancestors.delete(object);
      }
    }
    if (proto !== null && proto !== Object.prototype) return fail(path, kindOf(proto));
    ancestors.add(object);
    try {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const childPath = [...path, key];
        const item = visit(read(object, key, childPath), childPath);
        if (item !== undefined) setOwn(out, key, item);
      }
      failDropped(dropped, path);
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
        return fail(path, Number.isNaN(current) ? 'NaN' : current > 0 ? 'Infinity' : '-Infinity');
      case 'bigint':
        return fail(path, 'BigInt');
      case 'function':
        return fail(path, 'function');
      case 'symbol':
        return fail(path, 'symbol');
      case 'undefined':
        return undefined;
      case 'object':
        break;
    }
    if (current === null) return null;
    return visitObject(current as object, path);
  };

  const result = visit(value, []);
  if (result === undefined) return fail([], 'undefined');
  return result;
}

/**
 * Reads `snapshotLoad`'s params on the target that applies them, before anything changes (M5
 * design §4): a non-string `app` or a missing `snapshot` is INVALID_PAYLOAD, and an `app` other
 * than `appId` is APP_MISMATCH. Without `app` there is no check, so direct RPC callers keep working.
 */
export function parseSnapshotLoadParams(params: Record<string, unknown>, appId: string): { snapshot: unknown } {
  const app = params['app'];
  if (app !== undefined && typeof app !== 'string') {
    throw new IronbirdError('INVALID_PAYLOAD', 'snapshotLoad needs app to be a string', { name: 'snapshotLoad', issues: [{ path: ['app'], message: 'expected a string' }] });
  }
  if (app !== undefined && app !== appId) {
    throw new IronbirdError('APP_MISMATCH', `The snapshot was saved from ${app}, but this target runs ${appId}`, { expected: appId, received: app });
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'snapshot')) {
    throw new IronbirdError('INVALID_PAYLOAD', 'snapshotLoad needs a snapshot', { name: 'snapshotLoad', issues: [{ path: ['snapshot'], message: 'required' }] });
  }
  return { snapshot: params['snapshot'] };
}
