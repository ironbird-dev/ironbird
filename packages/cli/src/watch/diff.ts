import { deepEqual } from '@ironbird/core';

/** One RFC 6902 operation. `watch` emits only these three (M5 design §5). */
export type JsonPatchOp = { op: 'add'; path: string; value: unknown } | { op: 'remove'; path: string } | { op: 'replace'; path: string; value: unknown };

/** The value at a watched path: present, `null` included, or missing (`getState` returned no `value`). */
export type Presence = { present: true; value: unknown } | { present: false };

/** RFC 6901: `~` becomes `~0`, then `/` becomes `~1`. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

type Shape = 'array' | 'object' | 'scalar';

const shapeOf = (value: unknown): Shape => (Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : 'scalar');
const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

function diffAt(prev: unknown, next: unknown, base: string, ops: JsonPatchOp[]): void {
  const shape = shapeOf(prev);
  if (shape !== shapeOf(next) || shape === 'scalar') {
    if (!Object.is(prev, next)) ops.push({ op: 'replace', path: base, value: next });
    return;
  }
  if (shape === 'array') {
    // Index by index, so each operation stays valid applied in order: replacements below the
    // shorter length, then removals from the highest index down, then additions at the end.
    const before = prev as unknown[];
    const after = next as unknown[];
    const common = Math.min(before.length, after.length);
    for (let index = 0; index < common; index += 1) {
      if (!deepEqual(before[index], after[index])) ops.push({ op: 'replace', path: `${base}/${index}`, value: after[index] });
    }
    for (let index = before.length - 1; index >= after.length; index -= 1) ops.push({ op: 'remove', path: `${base}/${index}` });
    for (let index = before.length; index < after.length; index += 1) ops.push({ op: 'add', path: `${base}/${index}`, value: after[index] });
    return;
  }
  const before = prev as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  for (const key of Object.keys(before)) {
    const path = `${base}/${escapePointerToken(key)}`;
    if (hasOwn(after, key)) diffAt(before[key], after[key], path, ops);
    else ops.push({ op: 'remove', path });
  }
  for (const key of Object.keys(after)) {
    if (!hasOwn(before, key)) ops.push({ op: 'add', path: `${base}/${escapePointerToken(key)}`, value: after[key] });
  }
}

/** The patch that turns `prev` into `next`, both present JSON values; pointers are relative to them. */
export function diff(prev: unknown, next: unknown): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  diffAt(prev, next, '', ops);
  return ops;
}

/** `diff` plus §5's rules for a path that appears (`add` at `""`) or disappears (`remove` at `""`). */
export function patchBetween(prev: Presence, next: Presence): JsonPatchOp[] {
  if (!prev.present) return next.present ? [{ op: 'add', path: '', value: next.value }] : [];
  if (!next.present) return [{ op: 'remove', path: '' }];
  return diff(prev.value, next.value);
}
