# M5 Snapshots and Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship R15 (snapshots) and R17 (`watch`): the `INVALID_SNAPSHOT` error code, a strict `serializeSnapshot` in `@ironbird/core`, `snapshotSave` and `snapshotLoad` (with the optional `app` check) on the headless target and the bridge, `ironbird snapshot save|load`, the daemon's initial `state` frame on `/v1/stream`, and `ironbird watch [--path]` with an in-house RFC 6902 differ, plus the protocol, API, and CLI docs.

**Architecture:** Core gains `snapshot.ts` with `serializeSnapshot` (exact JSON or `INVALID_SNAPSHOT`, never placeholders) and `parseSnapshotLoadParams` (the `app` and `snapshot` checks both applying targets share), and `createTarget` turns a plain error from `persist` or `restore` into `INVALID_SNAPSHOT`. The headless target and the bridge serve the two operations from the `Target`'s `persist` and `restore`; the remote target already forwards them. The daemon sends one `state` frame with the current revision as soon as a stream's state subscription is live, and the headless target notifies state listeners after a `reset` or `reload`. `watch` opens the stream at the event cursor, treats every `state` frame as a change signal, reads `getState` at most once at a time (once more after any frame that arrived during a read), and prints `{ rev, patch }` against the last printed value.

**Tech Stack:** TypeScript 6 strict (`noUncheckedIndexedAccess`), tsup 8, Vitest 5 (`unit` and `serial` projects), fast-check 4.9 (property tests), Commander 15, Node 22+ `fetch` for the SSE client, Changesets.

**Spec:** [docs/superpowers/specs/2026-10-04-m5-adapters-and-0.1-design.md](../specs/2026-10-04-m5-adapters-and-0.1-design.md). This plan implements D4, D5, D12, §4, §5, §7, and the "Snapshots" and "Watch" rows of §11. Cross-plan names: `.superpowers/sdd/m5-contract.md` (not committed), "Plan 2: snapshots and watch". This plan runs first; plan 1 (adapters) consumes `INVALID_SNAPSHOT` and `createTarget`'s restore conversion. Plan 3 owns `doctor` and its part of cli.md; plan 5 owns spec.md, roadmap.md, the evals record, and the 0.1.0 `minor` changesets.

**Prerequisites:** Work on branch `m5-adapters-and-0.1`. Run `pnpm install && pnpm build` once before Task 1 on a fresh checkout. Nothing from the other M5 plans is needed.

## Verified external facts

Checked on 2026-10-04 against the installed packages (fast-check 4.9.0) on Node 26.10 with throwaway scripts in the scratchpad:

| Fact | Value |
|---|---|
| `fc.dictionary(key, value)` | **Generates null-prototype objects by default** (102 of 200 samples); `{ noNullPrototype: true }` turns that off. The differ property test passes it |
| `fc.anything` options | `withBigInt`, `withBoxedValues`, `withDate`, `withMap`, `withNullPrototype`, `withObjectString`, `withSet`, `withSparseArray`, `withTypedArray`, `withUnicodeString` all exist in 4.9 |
| `fc.jsonValue()` | Never produced null-prototype objects or a `__proto__` key in 3,000 samples, but does produce `-0` (2 in 3,000); `JSON.stringify(-0)` is `"0"` |
| `fc.letrec` + `fc.oneof({ depthSize: 'small' }, ...)` | Builds a bounded recursive JSON arbitrary; with keys from `fc.constantFrom('a', 'b', '~', '/', '~0', '~1', 'a/b', '')` it put a `~` or `/` key in 244 of 500 samples |
| Strict serializer prototype | The Task 1 `serializeSnapshot`, run against `serializeState` over 2,000 `fc.anything` samples with every option above on, accepted 398 and rejected 1,602; every accepted value had no `serializeState` warnings and the same `JSON.stringify` output |
| Differ prototype | The Task 6 `diff` and `patchBetween`, applied by a strict RFC 6902 applier (add at an existing member, or past an array's end, or remove/replace a missing target all throw) over 3,000 sequences of up to 6 present-or-missing values, reproduced every next value exactly |
| JavaScript edge cases | `Object.getPrototypeOf` and `Array.isArray` on a revoked `Proxy` throw `TypeError`; `Array.isArray(new Uint8Array(1))` is `false` and its prototype's constructor name is `Uint8Array`; an `Array` subclass instance is `Array.isArray` but its prototype isn't `Array.prototype`; `1 in [1, , 3]` is `false`; `JSON.parse('{"__proto__":{"y":2}}')` creates an own `__proto__` data property; `JSON.stringify({ a: undefined, b: 1 })` is `{"b":1}` |
| SSE client on SIGINT | A Node `fetch` streaming `text/event-stream`, aborted from a `process.once('SIGINT')` handler, rejects the pending `reader.read()` with `AbortError` and the process exits 0 within milliseconds; no keep-alive socket holds it open |
| Repository facts | `ERROR_CODES` has 21 codes today; `exitCodeForError` maps every code outside its three sets to 1; `MUTATING_OPS` already contains `snapshotLoad`; `createRemoteTarget` already gates `snapshotSave`/`snapshotLoad` on `persist`/`restore` and forwards params verbatim; the headless target answers both with `UNSUPPORTED` today; the bridge already has both handlers, using the placeholder serializer; the daemon subscribes a stream to state only after the event backlog and throttles state frames to one per 100 ms; a headless `reset` returns `rev: 0` and notifies no state listener |

## Global Constraints

From [AGENTS.md](../../../AGENTS.md):

1. `@ironbird/core` imports only `zod`. No `react-native`, no `node:*` modules, no DOM or browser globals. Lint enforces this.
2. No arbitrary code execution anywhere (ADR-0001).
3. The bridge stays dev-only; the marker constant lives only in `@ironbird/react-native`.
4. Validate every payload where it is applied, including inside the app. Never trust the daemon.
5. Protocol changes update docs/protocol.md in the same PR. Breaking changes bump `PROTOCOL_VERSION` and need an ADR.
6. Public API or CLI changes update docs/api.md or docs/cli.md in the same PR and include a changeset.
7. New runtime dependencies in `core` or `react-native` need an ADR. This plan adds none anywhere.
8. Errors that cross a package boundary are `IronbirdError` with a code from the protocol error table.
9. Library code takes time from the injected `Clock`; inside core only `clock.ts` and `scheduler.ts` use global timers.

From the spec and the contract:

- One new error code, `INVALID_SNAPSHOT`, additive, details exactly `{ path, reason }`; `path` is a dot path (the protocol's convention, §1) and `''` at the root or when the failure isn't tied to a path. CLI exit code 1, listed next to `INVALID_PAYLOAD` in cli.md. `PROTOCOL_VERSION` stays `1`; no ADR (D12, §7).
- `serializeSnapshot(value)` is exported from `@ironbird/core`, returns JSON-safe data or throws `INVALID_SNAPSHOT` naming the first lossy path, and never substitutes placeholders. It rejects functions, symbols, `BigInt`, `NaN`, ±`Infinity`, `Map`, `Set`, `Date`, any other non-plain object (class instances, boxed primitives, typed arrays), cycles, `undefined` or holes in arrays, and throwing getters; it also rejects what JSON would drop silently, enumerable non-index properties on arrays (`array-property`, path such as `items.extra`) and enumerable symbol-keyed properties (`symbol-key`, path such as `meta.Symbol(tag)`); `undefined` object properties are omitted; `reason` is the kind, such as `Map` or `cycle` (§4).
- `createTarget` converts any non-`IronbirdError` a `Target`'s `restore` throws into `INVALID_SNAPSHOT` with `{ path: '', reason: <message> }` (§4).
- `snapshotLoad` params are `snapshot`, `app?`. The applying target checks `app` against its own app id and fails `APP_MISMATCH` with `{ expected, received }` before applying anything; a missing `app` skips the check. `snapshotLoad` stays in the per-target mutating queue (§4).
- `ironbird snapshot save <file>` writes `{ app, target, rev, snapshot }` with `app` from the target's `status` entry. `ironbird snapshot load <file>` validates the file before sending anything; a file that isn't JSON or doesn't match fails `INVALID_PAYLOAD` with `{ name: 'snapshotLoad', issues }`; it sends `snapshot` and the file's `app`. The file's `target` is informational (§4).
- The daemon's one additive frame: when a stream's state subscription goes live, a `state` frame with the target's current revision, through the stream's throttle (D5).
- `watch` calls `events` with `limit: 0` for `nextSeq`, opens `/v1/stream` with `since` set to it, waits for the first `state` frame, reads `getState` at `--path`, keeps at most one read in flight, labels each line with the revision the read returned, diffs against the last value **printed**, prints nothing for an empty patch except the first line, and ends with exit 0 on SIGINT and with `{ error }` and that error's exit code on an `error` frame (§5).
- Patch pointers are relative to the value at `--path`, the root is `""`, tokens escape `~` as `~0` then `/` as `~1`. A path is present when `getState`'s result has a `value` property. First line: `[{ op: 'add', path: '', value }]` when present, `[]` when missing. Later disappear/appear: `{ op: 'remove', path: '' }` / `{ op: 'add', path: '', value }`. Objects by key (add, remove, replace); arrays index by index: changed items replaced whole, extra old items removed from the highest index down, new items added at the end; a change of type is a `replace` (§5).
- The differ lives in `packages/cli/src/watch/diff.ts` and exports `diff(prev, next): JsonPatchOp[]` (contract). No new dependency for it (D5).
- Out of scope: the `snapshot` scenario step, `watch` over MCP, `watch` filters other than `--path`, reconnecting `watch` (§1).
- Named exports only. Durations are milliseconds. Tests live next to code as `*.test.ts`; tests that spawn the built binary live in `packages/cli/test/` (the `serial` project).
- Packages import each other from `dist`. After changing core run `pnpm --filter @ironbird/core build`; before running `packages/cli/test/bridge.integration.test.ts` run `pnpm --filter @ironbird/react-native build`; before running `packages/cli/test/cli.integration.test.ts` run `pnpm --filter @ironbird/cli build`.
- Changesets in this plan are `patch`; plan 5 adds the `minor` changesets that move every package to 0.1.0.
- Commit messages are plain imperative subjects with no attribution trailers. Never commit `.superpowers/` or anything from the scratchpad. Stage only the files each task names.
- Run `pnpm test` under Node 22 as well as the local Node before pushing; CI runs both.

## Review Focus

The inputs the spec implies but its tests don't name, most likely to bite a user first. Each has a test in the task that owns the code.

1. **A `reset`, or a `scenario run` (which resets), while `watch` is open.** The headless revision restarts at 0, and with frames coalesced at 10 per second a reset followed by the same number of dispatches can come back to the revision `watch` last read, with a different state. `watch` must show the reset and must not miss that coincidence: the headless target notifies after a transition (Task 2), and `watch` re-reads after any frame that arrived during a read, whatever revision it carries (Task 7, "reads again after a frame during a read even when it carries the revision the read returned", and the daemon-backed reset test).
2. **A hand-written `persist` or `restore` that throws a plain `Error`** (a Zod `parse` failure, a `JSON.parse` of a bad blob). It must reach the user as `INVALID_SNAPSHOT` naming the reason, never as `INTERNAL` ("a bug in ironbird"), and the target's state and revision must not change (Task 1 `createTarget` test, Task 2 refusal test).
3. **Snapshot files at bad paths:** a save into a directory that doesn't exist, a load of a file that isn't there. Exit 2 with a `Cannot write` / `Cannot read` message on stderr, nothing half-written, no stack trace (Task 5).
4. **State and snapshot files with awkward keys:** `__proto__`, `~`, `/`, `""`. A `__proto__` key must stay own data through save, file, and load (never a prototype), and `watch` must escape `~` and `/` in pointers (Task 1 serializer test, Task 5 file test, Task 6 property test).
5. **Ctrl-C while a `watch` read is in flight, or an `error` frame during one.** No line may print after the run has ended or after the `{ error }` line, so a consumer can treat the last line as final (Task 7, "ends with 0 on abort and prints nothing for a read still in flight" and "ends on an error frame ... after nothing else").

---

## File Structure

```text
packages/core/src/errors.ts                    INVALID_SNAPSHOT in ERROR_CODES
packages/core/src/errors.test.ts               22 codes
packages/core/src/snapshot.ts                  serializeSnapshot, parseSnapshotLoadParams (new)
packages/core/src/snapshot.test.ts             their tests (new)
packages/core/src/target.ts                    persist/restore errors → INVALID_SNAPSHOT
packages/core/src/target.test.ts               conversion test
packages/core/src/index.ts                     exports
packages/core/scripts/verify-build.mjs         checks the two new exports in both builds
packages/cli/test/helpers/snapshot-app.ts      headless notes app that persists and restores (new)
packages/cli/src/headless-target.ts            snapshotSave, snapshotLoad; state notification after reset/reload
packages/cli/src/headless-target.test.ts       snapshot and notification tests
packages/react-native/src/handlers.ts          strict save, parseSnapshotLoadParams
packages/react-native/src/handlers.test.ts     save/load tests
packages/cli/test/bridge.integration.test.ts   snapshots through a real bridge; stream assertion update
packages/cli/src/daemon.ts                     initial state frame
packages/cli/src/daemon.test.ts                barrier test; two stream tests updated
packages/cli/src/cli/snapshot-file.ts          parseSnapshotFile, formatSnapshotFile (new)
packages/cli/src/cli/snapshot-file.test.ts     (new)
packages/cli/src/cli/snapshot.integration.test.ts  CLI round trip against an in-process daemon (new)
packages/cli/src/cli/output.ts                 asErrorShape moved here from program.ts
packages/cli/src/cli/program.ts                snapshot save|load, watch
packages/cli/src/cli/program.test.ts           harness signal option; snapshot and watch tests
packages/cli/src/cli/helpers.test.ts           INVALID_SNAPSHOT exits 1
packages/cli/src/watch/diff.ts                 JsonPatchOp, Presence, escapePointerToken, diff, patchBetween (new)
packages/cli/src/watch/diff.test.ts            (new)
packages/cli/src/watch/watch.ts                runWatch, WatchOptions (new)
packages/cli/src/watch/watch.test.ts           scripted-client tests (new)
packages/cli/src/watch/watch.integration.test.ts  boundary tests against an in-process daemon (new)
packages/cli/test/cli.integration.test.ts      watch via the built binary, ended by SIGINT
docs/protocol.md, docs/api.md, docs/cli.md
.changeset/m5-snapshot-core.md, m5-headless-snapshots.md, m5-bridge-snapshots.md, m5-stream-barrier.md, m5-snapshot-cli.md, m5-watch.md
```

---

### Task 1: `INVALID_SNAPSHOT`, `serializeSnapshot`, and `createTarget`'s snapshot errors

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/src/errors.test.ts`
- Create: `packages/core/src/snapshot.ts`, `packages/core/src/snapshot.test.ts`
- Modify: `packages/core/src/target.ts`, `packages/core/src/target.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/scripts/verify-build.mjs`
- Modify: `docs/protocol.md` (§6 table, §7), `docs/api.md` (createTarget paragraph, Other exports)
- Create: `.changeset/m5-snapshot-core.md`

**Interfaces:**
- Consumes: nothing new.
- Produces (from `@ironbird/core`): `'INVALID_SNAPSHOT'` in `ERROR_CODES` / `ErrorCode`; `serializeSnapshot(value: unknown): unknown` (throws `IronbirdError('INVALID_SNAPSHOT', message, { path: string; reason: string })`); `parseSnapshotLoadParams(params: Record<string, unknown>, appId: string): { snapshot: unknown }` (throws `INVALID_PAYLOAD` with `{ name: 'snapshotLoad', issues: [{ path: ['app'] | ['snapshot'], message }] }` or `APP_MISMATCH` with `{ expected: appId, received }`); `Target.persist()` and `Target.restore()` built by `createTarget` throw `INVALID_SNAPSHOT` `{ path: '', reason }` for any non-`IronbirdError` the definition throws, with messages `Snapshot could not be saved: <reason>` and `Snapshot could not be restored: <reason>`.

- [ ] **Step 1: Write the failing error-code test**

In `packages/core/src/errors.test.ts`, replace the test `'lists every documented code once'` with:

```ts
  it('lists every documented code once', () => {
    expect(new Set(ERROR_CODES).size).toBe(22);
    expect(ERROR_CODES).toContain('APP_MISMATCH');
    expect(ERROR_CODES).toContain('INVALID_CONFIG');
    expect(ERROR_CODES).toContain('INVALID_SCENARIO');
    expect(ERROR_CODES).toContain('INVALID_SNAPSHOT');
    expect(ERROR_CODES).toContain('INVARIANT_FAILED');
    expect(PROTOCOL_VERSION).toBe(1);
  });
```

- [ ] **Step 2: Write the failing serializer tests**

Create `packages/core/src/snapshot.test.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing `createTarget` test**

In `packages/core/src/target.test.ts`, change the first import line to `import { IronbirdError, isIronbirdError } from './errors';` and add this test inside `describe('createTarget', ...)`, after `'exposes persist and restore only when the definition provides them'`:

```ts
  it('reports a plain error from persist or restore as INVALID_SNAPSHOT and passes IronbirdErrors through', async () => {
    let restoreError: unknown = new Error('bad shape');
    const target = createTarget({
      commands,
      dispatch: () => {},
      getState: () => 0,
      persist: () => {
        throw new Error('disk gone');
      },
      restore: () => {
        throw restoreError;
      },
    });
    let saved: unknown;
    try {
      target.persist?.();
    } catch (error) {
      saved = error;
    }
    expect(saved).toMatchObject({ code: 'INVALID_SNAPSHOT', message: 'Snapshot could not be saved: disk gone', details: { path: '', reason: 'disk gone' } });
    expect(await target.restore?.({}).catch((error: unknown) => error)).toMatchObject({
      code: 'INVALID_SNAPSHOT',
      message: 'Snapshot could not be restored: bad shape',
      details: { path: '', reason: 'bad shape' },
    });
    restoreError = new IronbirdError('INVALID_SNAPSHOT', 'Invalid snapshot at todos.0', { path: 'todos.0', reason: 'Expected string' });
    expect(await target.restore?.({}).catch((error: unknown) => error)).toBe(restoreError);
    expect(target.revision()).toBe(0);
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/core/src/errors.test.ts packages/core/src/snapshot.test.ts packages/core/src/target.test.ts`
Expected: FAIL. `errors.test.ts`: `expected 21 to be 22`. `snapshot.test.ts`: cannot resolve `./snapshot`. `target.test.ts`: the persist call throws a plain `Error` with no `code`.

- [ ] **Step 5: Add the code**

In `packages/core/src/errors.ts`, insert `'INVALID_SNAPSHOT',` on its own line between `'INVALID_SCENARIO',` and `'CLOCK_RUNAWAY',` in `ERROR_CODES`.

Create `packages/core/src/snapshot.ts`:

```ts
import { IronbirdError } from './errors';

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

  const visitObject = (object: object, path: string[]): unknown => {
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
          if (!Object.prototype.hasOwnProperty.call(array, index)) return fail(childPath, 'hole');
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
```

In `packages/core/src/target.ts`, change the first line to:

```ts
import { IronbirdError, isIronbirdError, messageOf } from './errors';
```

and replace the two blocks from `if (definition.persist) {` to the end of the `if (definition.restore) { ... }` block with:

```ts
  // A definition's own IronbirdError passes through (the adapters throw INVALID_SNAPSHOT with the
  // path that failed validation); anything else is the snapshot's problem, not ironbird's, so it
  // becomes INVALID_SNAPSHOT rather than INTERNAL (M5 design §4).
  const snapshotError = (verb: 'saved' | 'restored', error: unknown): IronbirdError => {
    if (isIronbirdError(error)) return error as IronbirdError;
    const reason = messageOf(error);
    return new IronbirdError('INVALID_SNAPSHOT', `Snapshot could not be ${verb}: ${reason}`, { path: '', reason });
  };

  if (definition.persist) {
    const persist = definition.persist;
    target.persist = () => {
      try {
        return persist();
      } catch (error) {
        throw snapshotError('saved', error);
      }
    };
  }
  if (definition.restore) {
    const restore = definition.restore;
    target.restore = async (snapshot) => {
      try {
        await restore(snapshot);
      } catch (error) {
        throw snapshotError('restored', error);
      }
      if (!hasSubscribe) bump();
    };
  }
```

In `packages/core/src/index.ts`, after the line `export type { SerializationWarning } from './serialize';`, add:

```ts
export { parseSnapshotLoadParams, serializeSnapshot } from './snapshot';
```

In `packages/core/scripts/verify-build.mjs`, add `'serializeSnapshot', 'parseSnapshotLoadParams'` to the end of the array in the `for (const name of [...])` loop.

- [ ] **Step 6: Run the tests to verify they pass, then rebuild core**

Run: `pnpm exec vitest run --project unit packages/core/src && pnpm --filter @ironbird/core build`
Expected: every core test passes; the build prints `core build verified: esm+cjs load, no node: imports, no zod at load time, no bridge marker`.

- [ ] **Step 7: Update the docs**

In `docs/protocol.md`:

1. Change `| Last updated | 2026-09-29 |` to `| Last updated | 2026-10-04 |`.
2. In the §6 table, replace the `APP_MISMATCH` row with:

```md
| `APP_MISMATCH` | A bridge's app id differs from the app this daemon session serves, or a `snapshotLoad`'s `app` differs from the app id of the target applying it | `{ expected, received }` |
```

3. In the §6 table, insert after the `INVALID_SCENARIO` row:

```md
| `INVALID_SNAPSHOT` | `snapshotSave` found a value it can't save losslessly, or `snapshotLoad`'s snapshot failed the target's validation or couldn't be applied | `{ path, reason }`; `path` is a dot path into the snapshot, `''` at the root or when the failure isn't tied to one path; `reason` names the kind, such as `Map` or `cycle`, or carries the target's message |
```

4. Append to §7 (after the paragraph ending `Each affected path produces one \`UNSERIALIZABLE_STATE\` warning per connection.`):

```md
Snapshots are the exception. `snapshotSave` serializes strictly and never substitutes a placeholder, because a placeholder would load back as corrupt state: functions, symbols, `BigInt`, `NaN`, `Infinity`, `-Infinity`, `Map`, `Set`, `Date`, any other non-plain object (class instances, boxed primitives, typed arrays), cycles, `undefined` or holes in arrays, enumerable array properties other than indices (such as `items.extra`), enumerable symbol-keyed properties, throwing getters, and objects that can't be inspected each fail the save with `INVALID_SNAPSHOT` and `{ path, reason }` for the first one found. `undefined` object properties are omitted, as in JSON. Plain objects with a `null` prototype are accepted.
```

In `docs/api.md`:

1. Change `| Last updated | 2026-10-03 |` to `| Last updated | 2026-10-04 |`.
2. Replace the paragraph that begins `` `TargetDefinition` is exported alongside `createTarget`. `persist` and `restore` ship today`` with:

```md
`TargetDefinition` is exported alongside `createTarget`. A definition that provides `persist` or `restore` gets the matching method and capability on the `Target`, and the `snapshotSave` and `snapshotLoad` operations use them; see [protocol.md §4.1](protocol.md#41-target-operations). `persist` should return plain JSON data: `snapshotSave` passes it through `serializeSnapshot`, which refuses a `Map`, a `Date`, a class instance, a cycle, and the like rather than saving something that loads back wrong. `restore` receives `unknown`, whatever the definition's state type, because it comes from a file or the wire: validate it, for example with a Zod schema for the whole state, before applying it, and apply nothing when it doesn't fit (AGENTS.md rule 4). A plain error that `persist` or `restore` throws reaches the caller as `INVALID_SNAPSHOT` with `{ path: '', reason: <its message> }`; an `IronbirdError` passes through unchanged, so a `restore` can report the path that failed with its own `INVALID_SNAPSHOT`.
```

3. In the "Other exports (P0)" table, insert after the `serializeState` row:

```md
| `serializeSnapshot` | JSON-safe copy of a persisted snapshot, or `INVALID_SNAPSHOT` with `{ path, reason }` for the first value it can't save losslessly; never substitutes a placeholder (see [protocol.md §7](protocol.md#7-serialization)) |
| `parseSnapshotLoadParams` | `(params, appId) => { snapshot }` for a target applying `snapshotLoad`: `INVALID_PAYLOAD` for a non-string `app` or a missing `snapshot`, `APP_MISMATCH` with `{ expected, received }` when `app` is another app's id |
```

- [ ] **Step 8: Write the changeset**

Create `.changeset/m5-snapshot-core.md`:

```md
---
"@ironbird/core": patch
---
Snapshots. New error code `INVALID_SNAPSHOT` with details `{ path, reason }`. New `serializeSnapshot(value)`, which returns JSON-safe data or throws `INVALID_SNAPSHOT` naming the first value it can't save losslessly (functions, symbols, `BigInt`, `NaN`, `Infinity`, `Map`, `Set`, `Date`, other non-plain objects, cycles, `undefined` or holes in arrays, array properties other than indices, symbol-keyed properties, throwing getters) instead of substituting a placeholder, and `parseSnapshotLoadParams(params, appId)`, which checks `snapshotLoad`'s optional `app` (`APP_MISMATCH` on another app's id) and its `snapshot` before anything is applied. A plain error thrown by a `Target`'s `persist` or `restore` now surfaces as `INVALID_SNAPSHOT` with `{ path: '', reason }` instead of an unclassified error; an `IronbirdError` passes through.
```

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/errors.test.ts packages/core/src/snapshot.ts packages/core/src/snapshot.test.ts packages/core/src/target.ts packages/core/src/target.test.ts packages/core/src/index.ts packages/core/scripts/verify-build.mjs docs/protocol.md docs/api.md .changeset/m5-snapshot-core.md
git commit -m "Add INVALID_SNAPSHOT and the strict snapshot serializer to core"
```

---

### Task 2: `snapshotSave` and `snapshotLoad` on the headless target, and a state notification after reset and reload

**Files:**
- Create: `packages/cli/test/helpers/snapshot-app.ts`
- Modify: `packages/cli/src/headless-target.ts`, `packages/cli/src/headless-target.test.ts`
- Modify: `docs/protocol.md` (§4.1 table and a paragraph after it)
- Create: `.changeset/m5-headless-snapshots.md`

**Interfaces:**
- Consumes: `serializeSnapshot`, `parseSnapshotLoadParams` from `@ironbird/core` (Task 1, from `dist`).
- Produces: headless ops `snapshotSave` → `{ rev: number; snapshot: unknown }` (not queued) and `snapshotLoad` (`{ snapshot, app? }`, queued) → `{ rev: number; path: ''; value: unknown }`; `UNSUPPORTED` `{ op, target: 'headless' }` when the app's `Target` lacks `persist` / `restore`. After every successful `reset` or `reload`, every `onState` listener is called once with the new session's revision. Test helper `notesDefinition` (app id used in tests: `com.example.notes`) with commands `note.add` `{ text: string }` (min length 1), `note.clear` `{}`, `state.junk` `{}`, state `{ notes: string[]; status: 'idle' | 'saving'; junk?: unknown }`, `persist` returning the root state, `restore` validating with a strict Zod schema.

- [ ] **Step 1: Write the test helper**

Create `packages/cli/test/helpers/snapshot-app.ts`:

```ts
import { createTarget, defineCommands, defineHeadless } from '@ironbird/core';
import { z } from 'zod';

const notesSchema = z.strictObject({ notes: z.array(z.string()), status: z.enum(['idle', 'saving']) });

export type NotesState = z.infer<typeof notesSchema> & { junk?: unknown };

/**
 * A headless app that persists and restores its root state, for the snapshot tests. `state.junk`
 * puts a Map into the state, so a save must fail with INVALID_SNAPSHOT; `restore` validates with a
 * strict schema before applying anything, as AGENTS.md rule 4 asks of every restore.
 */
export const notesDefinition = defineHeadless(() => {
  let state: NotesState = { notes: [], status: 'idle' };
  const listeners = new Set<() => void>();
  const set = (next: NotesState): void => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const commands = defineCommands({
    'note.add': z.object({ text: z.string().min(1) }),
    'note.clear': z.object({}),
    'state.junk': z.object({}),
  });
  const target = createTarget({
    commands,
    dispatch: ({ name, payload }) => {
      if (name === 'note.add') set({ ...state, notes: [...state.notes, (payload as { text: string }).text] });
      if (name === 'note.clear') set({ notes: [], status: 'idle' });
      if (name === 'state.junk') set({ ...state, junk: new Map([['k', 1]]) });
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    persist: () => state,
    restore: (snapshot) => set(notesSchema.parse(snapshot)),
  });
  return { target };
});
```

- [ ] **Step 2: Write the failing headless tests**

In `packages/cli/src/headless-target.test.ts`, add after the `counterDefinition` import line:

```ts
import { notesDefinition } from '../test/helpers/snapshot-app';
```

Inside `describe('createHeadlessTarget', ...)`, add after the test `'emits event and state notifications'`:

```ts
  it('notifies state listeners with the new revision after a reset and after a reload', async () => {
    const t = await boot();
    const revs: number[] = [];
    t.onState((rev) => revs.push(rev));
    await t.run('dispatch', { name: 'counter.add', payload: { by: 1 } });
    await t.run('reset', {});
    expect(revs).toEqual([1, 0]);
    await t.dispose();
    const reloading = await reloadable().boot();
    const reloaded: number[] = [];
    reloading.onState((rev) => reloaded.push(rev));
    await reloading.run('dispatch', { name: 'count.add' });
    await reloading.run('reload', {});
    expect(reloaded).toEqual([1, 0]);
  });
```

At the end of the file, add:

```ts
describe('snapshots on the headless target', () => {
  const bootNotes = async (): Promise<HeadlessTarget> => {
    target = await createHeadlessTarget({ definition: notesDefinition, appId: 'com.example.notes', settleTimeoutMs: 100, env: {}, log: (line) => logs.push(line) });
    return target;
  };
  const refusal = (promise: Promise<unknown>): Promise<unknown> => promise.catch((error: unknown) => error);

  it('declares persist and restore, and saves the root state with its revision', async () => {
    const t = await bootNotes();
    expect(((await t.run('describe', {})) as { capabilities: string[] }).capabilities).toEqual(['settle', 'events', 'clock', 'reset', 'persist', 'restore']);
    await t.run('dispatch', { name: 'note.add', payload: { text: 'milk' } });
    expect(await t.run('snapshotSave', {})).toEqual({ rev: 1, snapshot: { notes: ['milk'], status: 'idle' } });
  });

  it('fails a save that would need a placeholder with INVALID_SNAPSHOT naming the path', async () => {
    const t = await bootNotes();
    await t.run('dispatch', { name: 'state.junk', payload: {} });
    expect(await refusal(t.run('snapshotSave', {}))).toMatchObject({ code: 'INVALID_SNAPSHOT', details: { path: 'junk', reason: 'Map' } });
  });

  it('restores a snapshot, with or without the matching app, and returns the whole state', async () => {
    const t = await bootNotes();
    await t.run('dispatch', { name: 'note.add', payload: { text: 'milk' } });
    const saved = (await t.run('snapshotSave', {})) as { snapshot: unknown };
    await t.run('dispatch', { name: 'note.add', payload: { text: 'eggs' } });
    expect(await t.run('snapshotLoad', { snapshot: saved.snapshot, app: 'com.example.notes' })).toEqual({ rev: 3, path: '', value: { notes: ['milk'], status: 'idle' } });
    expect(await t.run('snapshotLoad', { snapshot: { notes: ['x'], status: 'saving' } })).toEqual({ rev: 4, path: '', value: { notes: ['x'], status: 'saving' } });
  });

  it('runs snapshotLoad in the mutating queue, in arrival order', async () => {
    const t = await bootNotes();
    const adding = t.run('dispatch', { name: 'note.add', payload: { text: 'a' } });
    const loading = t.run('snapshotLoad', { snapshot: { notes: ['z'], status: 'idle' } });
    const after = t.run('dispatch', { name: 'note.add', payload: { text: 'b' }, path: 'notes' });
    await Promise.all([adding, loading]);
    expect(((await after) as StepResult).state).toEqual(['z', 'b']);
  });

  it('checks app before anything else and leaves the state and revision unchanged on every refusal', async () => {
    const t = await bootNotes();
    await t.run('dispatch', { name: 'note.add', payload: { text: 'milk' } });
    const refusals: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ snapshot: { notes: [], status: 'idle' }, app: 'com.example.other' }, { code: 'APP_MISMATCH', details: { expected: 'com.example.notes', received: 'com.example.other' } }],
      [{ app: 'com.example.other' }, { code: 'APP_MISMATCH' }],
      [{ snapshot: {}, app: 42 }, { code: 'INVALID_PAYLOAD', details: { name: 'snapshotLoad', issues: [{ path: ['app'], message: 'expected a string' }] } }],
      [{}, { code: 'INVALID_PAYLOAD', details: { name: 'snapshotLoad', issues: [{ path: ['snapshot'], message: 'required' }] } }],
      [{ snapshot: { notes: 'milk', status: 'idle' } }, { code: 'INVALID_SNAPSHOT', details: { path: '' } }],
      [{ snapshot: { notes: [], status: 'idle', extra: 1 }, app: 'com.example.notes' }, { code: 'INVALID_SNAPSHOT', details: { path: '' } }],
    ];
    for (const [params, expected] of refusals) {
      expect(await refusal(t.run('snapshotLoad', params))).toMatchObject(expected);
    }
    expect(await t.run('getState', {})).toEqual({ rev: 1, path: '', value: { notes: ['milk'], status: 'idle' } });
  });

  it('answers UNSUPPORTED for both operations when the app neither persists nor restores', async () => {
    const t = await boot();
    for (const op of ['snapshotSave', 'snapshotLoad']) {
      expect(await refusal(t.run(op, { snapshot: {} }))).toMatchObject({ code: 'UNSUPPORTED', details: { op, target: 'headless' } });
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/headless-target.test.ts`
Expected: FAIL. The notification test gets `[1]` instead of `[1, 0]`; the snapshot tests get `UNSUPPORTED` "The headless target doesn't support snapshotSave" from the missing handlers (the `UNSUPPORTED` test passes already).

- [ ] **Step 4: Implement**

In `packages/cli/src/headless-target.ts`, add `parseSnapshotLoadParams,` and `serializeSnapshot,` to the `@ironbird/core` import list (alphabetical placement: after `parseCondition,` and after `serializeState,` respectively).

In `transition`, replace:

```ts
    definition = loaded;
    session = next;
    bootError = undefined;
    return next;
```

with:

```ts
    definition = loaded;
    session = next;
    bootError = undefined;
    // Revisions restart with the new session, and nothing in it has notified yet, so tell the
    // streams: without this a `watch` would keep showing the old session's state (M5 design §5).
    // A listener that throws is skipped, as createTarget does, so it can't fail a transition that
    // already installed its session.
    const rev = next.app.target.revision();
    for (const listener of stateListeners) {
      try {
        listener(rev);
      } catch (error) {
        log(`a state listener threw after ${kind} and was skipped: ${messageOf(error)}`);
      }
    }
    return next;
```

In the `ops` object, insert before `reset: () => requestTransition('reset'),`:

```ts
    snapshotSave: () => {
      const current = requireSession('snapshotSave');
      const appTarget = current.app.target;
      if (!appTarget.persist) throw new IronbirdError('UNSUPPORTED', "The headless target doesn't support snapshotSave: the app doesn't persist", { op: 'snapshotSave', target: 'headless' });
      const rev = appTarget.revision();
      // Strict, unlike state reads: a placeholder would load back as corrupt state (M5 design D4).
      return { rev, snapshot: serializeSnapshot(appTarget.persist()) };
    },
    snapshotLoad: async (params) => {
      const startedEpoch = queue.epoch;
      const current = requireSession('snapshotLoad');
      const appTarget = current.app.target;
      if (!appTarget.restore) throw new IronbirdError('UNSUPPORTED', "The headless target doesn't support snapshotLoad: the app doesn't restore", { op: 'snapshotLoad', target: 'headless' });
      // The app check and the params come first, so a refused snapshot never reaches `restore`.
      const request = parseSnapshotLoadParams(params, options.appId);
      await queue.raceAbandon('snapshotLoad', appTarget.restore(request.snapshot));
      if (queue.epoch !== startedEpoch) throw queue.abandoned('snapshotLoad');
      return { rev: appTarget.revision(), path: '', value: snapshotOf(current, '') };
    },
```

`snapshotLoad` is already in `QUEUED_OPS` (through `MUTATING_OPS` in `daemon-target.ts`), so `run` enqueues it; `snapshotSave` runs unqueued like `getState`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/headless-target.test.ts packages/cli/src/daemon.test.ts`
Expected: PASS, including every existing reset and reload test.

- [ ] **Step 6: Update protocol.md §4.1**

In `docs/protocol.md`, replace the two snapshot rows of the §4.1 table with:

```md
| `snapshotSave` | none | `{ rev, snapshot }` | if the target persists | if the target persists |
| `snapshotLoad` | `snapshot`, `app?` | `{ rev, path, value }` | if the target restores | if the target restores |
```

and insert this paragraph after the paragraph that begins `` `settle` in params is `true` (the default)``:

```md
`snapshotSave` returns the target's persisted state passed through strict serialization: a value that can't be saved losslessly fails the operation with `INVALID_SNAPSHOT` naming its path, rather than being replaced by a placeholder as in state reads (§7). `snapshotLoad` takes the `snapshot` and, optionally, the `app` id it was saved from, and the target applying it checks before applying anything: that it restores at all (`UNSUPPORTED`), that `app`, when present, is a string (`INVALID_PAYLOAD`) equal to its own app id (`APP_MISMATCH` with `{ expected, received }`), and that `snapshot` is present (`INVALID_PAYLOAD`). Only then does it call the app's `restore`, which validates the snapshot and fails with `INVALID_SNAPSHOT` when it doesn't fit; the adapters, and any `restore` that validates before applying, leave the state unchanged when they refuse. Without `app` there is no app check, so direct callers keep working; a bridge older than this change ignores `app`. The result is the whole state after the load. A headless `reset` or `reload` notifies the stream with the new session's revision (§2.2).
```

- [ ] **Step 7: Write the changeset**

Create `.changeset/m5-headless-snapshots.md`:

```md
---
"@ironbird/cli": patch
---
The headless target serves `snapshotSave` and `snapshotLoad` when the app's `Target` implements `persist` and `restore`. A save is strict (`INVALID_SNAPSHOT` naming the first value that can't be saved losslessly); a load takes an optional `app`, refused with `APP_MISMATCH` when it isn't this target's app id, and runs in the mutating queue. After a successful `reset` or `reload`, the headless target notifies state listeners, so a stream sees a `state` frame with the new session's revision.
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/test/helpers/snapshot-app.ts packages/cli/src/headless-target.ts packages/cli/src/headless-target.test.ts docs/protocol.md .changeset/m5-headless-snapshots.md
git commit -m "Serve snapshotSave and snapshotLoad on the headless target and notify state after reset and reload"
```

---

### Task 3: Strict snapshots and the app check on the bridge

**Files:**
- Modify: `packages/react-native/src/handlers.ts`, `packages/react-native/src/handlers.test.ts`
- Modify: `packages/cli/test/bridge.integration.test.ts`
- Create: `.changeset/m5-bridge-snapshots.md`

**Interfaces:**
- Consumes: `serializeSnapshot`, `parseSnapshotLoadParams` from `@ironbird/core` (Task 1).
- Produces: the bridge's `snapshotSave` → `{ rev, snapshot }` through `serializeSnapshot`; `snapshotLoad` checks `parseSnapshotLoadParams(params, ctx.app.id)` before `restore`. The remote target already forwards both, gated on capabilities, so nothing changes in `packages/cli/src/remote-target.ts`.

- [ ] **Step 1: Write the failing handler tests**

In `packages/react-native/src/handlers.test.ts`, in the `app()` fixture, replace the line

```ts
    ...(options.persist ? { persist: () => ({ count: state.count }), restore: (snapshot: unknown) => set({ ...state, count: (snapshot as { count: number }).count }) } : {}),
```

with:

```ts
    ...(options.persist
      ? {
          persist: () => (state.junk === undefined ? { count: state.count } : { count: state.count, junk: state.junk }),
          // Validates before applying, as every restore must (AGENTS.md rule 4).
          restore: (snapshot: unknown) => set({ ...state, count: z.strictObject({ count: z.number().int() }).parse(snapshot).count }),
        }
      : {}),
```

Add these tests inside `describe('createHandlers', ...)`, after `'saves and restores snapshots when the target can, and refuses otherwise'`:

```ts
  it('saves strictly: a state that would need a placeholder fails INVALID_SNAPSHOT naming the path', async () => {
    const handlers = createHandlers(app({ persist: true }));
    await handlers['dispatch']!({ name: 'state.junk', payload: {}, settle: false });
    expect(await failure(handlers['snapshotSave']!({}))).toEqual({ code: 'INVALID_SNAPSHOT', details: { path: 'junk', reason: 'Map' } });
  });

  it('checks the app id before restoring, and skips the check without one', async () => {
    const ctx = app({ persist: true });
    const handlers = createHandlers(ctx);
    expect(await failure(handlers['snapshotLoad']!({ snapshot: { count: 5 }, app: 'com.example.other' }))).toEqual({
      code: 'APP_MISMATCH',
      details: { expected: 'com.example.test', received: 'com.example.other' },
    });
    expect(ctx.target.getState()).toMatchObject({ count: 0 });
    expect(await handlers['snapshotLoad']!({ snapshot: { count: 5 }, app: 'com.example.test' })).toMatchObject({ path: '', value: { count: 5 } });
    expect(await handlers['snapshotLoad']!({ snapshot: { count: 6 } })).toMatchObject({ path: '', value: { count: 6 } });
  });

  it('refuses malformed params and a snapshot the target rejects, leaving the state unchanged', async () => {
    const ctx = app({ persist: true });
    const handlers = createHandlers(ctx);
    expect(await failure(handlers['snapshotLoad']!({ snapshot: { count: 1 }, app: 7 }))).toEqual({
      code: 'INVALID_PAYLOAD',
      details: { name: 'snapshotLoad', issues: [{ path: ['app'], message: 'expected a string' }] },
    });
    expect(await failure(handlers['snapshotLoad']!({}))).toEqual({ code: 'INVALID_PAYLOAD', details: { name: 'snapshotLoad', issues: [{ path: ['snapshot'], message: 'required' }] } });
    expect(await failure(handlers['snapshotLoad']!({ snapshot: { count: 'x' } }))).toMatchObject({ code: 'INVALID_SNAPSHOT', details: { path: '' } });
    expect(ctx.target.getState()).toMatchObject({ count: 0 });
    expect(ctx.target.revision()).toBe(0);
    expect(await failure(createHandlers(app())['snapshotLoad']!({ snapshot: {} }))).toMatchObject({ code: 'UNSUPPORTED', details: { op: 'snapshotLoad', target: 'ios' } });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit packages/react-native/src/handlers.test.ts`
Expected: FAIL. The junk save resolves with `{ $unserializable: 'Map' }` instead of throwing; the mismatched `app` restores anyway; `app: 7` and `{}` reach `restore`.

- [ ] **Step 3: Implement**

In `packages/react-native/src/handlers.ts`, add `parseSnapshotLoadParams,` and `serializeSnapshot,` to the `@ironbird/core` import list, and replace the `snapshotSave` and `snapshotLoad` handlers with:

```ts
    snapshotSave: async () => {
      if (!ctx.target.persist) return unsupported('snapshotSave');
      const rev = ctx.target.revision();
      // Strict, unlike state reads: a placeholder would load back as corrupt state (M5 design D4).
      return { rev, snapshot: serializeSnapshot(ctx.target.persist()) };
    },
    snapshotLoad: async (params) => {
      if (!ctx.target.restore) return unsupported('snapshotLoad');
      // Never trust the daemon (AGENTS.md rule 4): the app check and the params come before restore.
      const request = parseSnapshotLoadParams(params, ctx.app.id);
      await ctx.target.restore(request.snapshot);
      return { rev: ctx.target.revision(), path: '', value: snapshot('') };
    },
```

`serializeState` stays imported: the `snapshot(path)` helper for state reads still uses it.

- [ ] **Step 4: Run the tests to verify they pass, then build the bridge**

Run: `pnpm exec vitest run --project unit packages/react-native/src && pnpm --filter @ironbird/react-native build`
Expected: every react-native test passes; the build's verifier passes.

- [ ] **Step 5: Write the failing end-to-end bridge test**

In `packages/cli/test/bridge.integration.test.ts`, change `function app(): App {` to `function app(options: { snapshots?: boolean } = {}): App {`, and in it replace

```ts
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
```

(the end of the `createTarget` call) with:

```ts
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...(options.snapshots
      ? {
          persist: () => state,
          restore: (snapshot: unknown) => set(z.strictObject({ count: z.number().int(), status: z.string() }).parse(snapshot)),
        }
      : {}),
  });
```

Add inside `describe('bridge against daemon', ...)`:

```ts
  it('saves and loads snapshots through the bridge, which checks the app id they came from', async () => {
    const d = await boot();
    bridge(d, app({ snapshots: true }));
    await until(() => d.targets().some((t) => t.id === 'ios'), 'the bridge to connect');
    await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 2 }, settle: false } });
    expect(await rpc(d, { op: 'snapshotSave' })).toMatchObject({ ok: true, target: 'ios', result: { rev: 1, snapshot: { count: 2, status: 'idle' } } });
    expect(await rpc(d, { op: 'snapshotLoad', params: { snapshot: { count: 9, status: 'idle' }, app: 'com.example.other' } })).toMatchObject({
      ok: false,
      error: { code: 'APP_MISMATCH', details: { expected: 'com.example.test', received: 'com.example.other' } },
    });
    expect(await rpc(d, { op: 'snapshotLoad', params: { snapshot: { count: 'nine' }, app: 'com.example.test' } })).toMatchObject({ ok: false, error: { code: 'INVALID_SNAPSHOT', details: { path: '' } } });
    expect(await rpc(d, { op: 'getState', params: { path: 'count' } })).toMatchObject({ ok: true, result: { value: 2 } });
    expect(await rpc(d, { op: 'snapshotLoad', params: { snapshot: { count: 9, status: 'idle' }, app: 'com.example.test' } })).toMatchObject({
      ok: true,
      target: 'ios',
      result: { path: '', value: { count: 9, status: 'idle' } },
    });
  });
```

- [ ] **Step 6: Run it**

Run: `pnpm exec vitest run --project serial packages/cli/test/bridge.integration.test.ts`
Expected: PASS (the bridge was rebuilt in Step 4; before Step 3 this test fails on the `APP_MISMATCH` expectation).

- [ ] **Step 7: Write the changeset**

Create `.changeset/m5-bridge-snapshots.md`:

```md
---
"@ironbird/react-native": patch
---
`snapshotSave` is strict: a persisted state holding a `Map`, a `Date`, a class instance, a cycle, or another value that can't be saved losslessly fails with `INVALID_SNAPSHOT` naming its path, instead of saving a placeholder. `snapshotLoad` takes an optional `app` and refuses another app's snapshot with `APP_MISMATCH` before calling `restore`; a non-string `app` or a missing `snapshot` is `INVALID_PAYLOAD`.
```

- [ ] **Step 8: Commit**

```bash
git add packages/react-native/src/handlers.ts packages/react-native/src/handlers.test.ts packages/cli/test/bridge.integration.test.ts .changeset/m5-bridge-snapshots.md
git commit -m "Save bridge snapshots strictly and check the app id before restoring"
```

---

### Task 4: The stream's initial `state` frame

**Files:**
- Modify: `packages/cli/src/daemon.ts`, `packages/cli/src/daemon.test.ts`
- Modify: `packages/cli/test/bridge.integration.test.ts` (one stream assertion)
- Modify: `docs/protocol.md` (§2.2)
- Create: `.changeset/m5-stream-barrier.md`

**Interfaces:**
- Consumes: `DaemonTarget.info().rev` (headless: the live session's revision; remote: the last revision the bridge notified, 0 before the first).
- Produces: every `/v1/stream` writes, right after its state subscription goes live (after the event backlog and the buffered live events), `event: state` with `{ "rev": <target.info().rev> }`, through the stream's throttle (written at once, then the 100 ms window starts). `watch` (Task 7) uses it as its barrier.

- [ ] **Step 1: Write the failing daemon test and update the two stream tests it changes**

In `packages/cli/src/daemon.test.ts`, inside `describe('startDaemon', ...)`, replace the body of `'streams recorded events and throttled state revisions over SSE'` from `await readUntil(': connected');` through `expect(text).toContain('event: event\ndata: {"seq":1,');` with:

```ts
    // The initial frame carries the revision the earlier dispatch left; later changes coalesce
    // under the throttle, so only the last revision is certain to appear.
    await readUntil('event: state\ndata: {"rev":1}\n\n');
    await rpc(d, { op: 'dispatch', params: { name: 'data.load' } });
    await rpc(d, { op: 'clockAdvance', params: { ms: 500 } });
    await readUntil('"name":"loaded"');
    await readUntil('event: state\ndata: {"rev":3}\n\n');
    expect(text).toContain('event: event\ndata: {"seq":1,');
```

In `'throttles state notifications to at most one per 100 ms after the first'`, replace

```ts
    await drain(50);
    const t0 = Date.now();
```

with

```ts
    await drain(50);
    // The initial state frame arrives before the burst; the bound below is about the burst alone.
    expect(text).toContain('event: state\ndata: {"rev":0}\n\n');
    const beforeBurst = text.length;
    const t0 = Date.now();
```

and replace

```ts
    const stateFrames = text.split('\n\n').filter((frame) => frame.startsWith('event: state'));
```

with

```ts
    const stateFrames = text.slice(beforeBurst).split('\n\n').filter((frame) => frame.startsWith('event: state'));
```

Add this test right after `'streams recorded events and throttled state revisions over SSE'`:

```ts
  it('sends a state frame with the current revision once the state subscription is live, after the event backlog', async () => {
    const d = await boot();
    await rpc(d, { op: 'dispatch', params: { name: 'data.load' } });
    await rpc(d, { op: 'clockAdvance', params: { ms: 500 } });
    const controller = new AbortController();
    const response = await fetch(`${d.url}/v1/stream?target=headless&since=0`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: state\ndata: {"rev":2}\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const frames = text.split('\n\n').filter((frame) => frame.startsWith('event: '));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatch(/^event: event\ndata: \{"seq":1,.*"name":"loaded"/);
    expect(frames[1]).toBe('event: state\ndata: {"rev":2}');
    controller.abort();
  });
```

In `packages/cli/test/bridge.integration.test.ts`, in `'forwards notifications to the stream and ends it when its target disconnects'`, replace

```ts
    await readUntil(': connected');
    await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 1 }, settle: false } });
    await readUntil('event: state');
    expect(text).toContain('data: {"rev":1}');
```

with

```ts
    // Wait for the initial state frame before dispatching: `: connected` is written before the
    // backlog read crosses the bridge, so a dispatch sent on it could land before the state
    // subscription and make the initial frame carry rev 1.
    await readUntil('event: state\ndata: {"rev":0}\n\n');
    await rpc(d, { op: 'dispatch', params: { name: 'counter.add', payload: { by: 1 }, settle: false } });
    await readUntil('event: state\ndata: {"rev":1}\n\n');
```

- [ ] **Step 2: Run the daemon tests to verify the new one fails**

Run: `pnpm exec vitest run --project unit packages/cli/src/daemon.test.ts`
Expected: FAIL. The new test and the two edited tests time out or fail waiting for a state frame with no change after the stream opened (no `event: state\ndata: {"rev":2}` / `{"rev":1}` / `{"rev":0}` arrives).

- [ ] **Step 3: Implement**

In `packages/cli/src/daemon.ts`, in `handleStream`, replace

```ts
    handles.offState = target.onState((rev) => {
      pendingRev = rev;
      if (!throttle) flush();
    });
    handles.ping = setInterval(() => writeRaw(': ping\n\n'), options.pingIntervalMs ?? PING_INTERVAL_MS);
```

with

```ts
    handles.offState = target.onState((rev) => {
      pendingRev = rev;
      if (!throttle) flush();
    });
    // The barrier (M5 design D5): the subscription above is live, so any change from here on
    // produces another state frame. A client that reads state after this frame misses nothing,
    // which is how `watch` starts. It goes through the throttle like any other state frame.
    pendingRev = target.info().rev;
    flush();
    if (cleaned) return;
    handles.ping = setInterval(() => writeRaw(': ping\n\n'), options.pingIntervalMs ?? PING_INTERVAL_MS);
```

`throttle` is always unset at this point (nothing has armed it yet), so `flush` writes at once and arms the 100 ms window; the `cleaned` check keeps a failed write from arming the ping timer on a dead stream.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/daemon.test.ts && pnpm exec vitest run --project serial packages/cli/test/bridge.integration.test.ts`
Expected: PASS, including `'does not leak the ping timer or state listener after a mid-backlog teardown'` (that stream ends inside the backlog loop, before this code).

- [ ] **Step 5: Update protocol.md §2.2**

In `docs/protocol.md` §2.2, replace the sentence `The CLI uses this for \`events --follow\` and \`watch\`.` with:

```md
Once the stream's state subscription is live, which is after the event backlog, the daemon sends a `state` frame carrying the target's current revision (for a connected app, the last revision it notified, 0 before its first notification). From then on every state change produces another `state` frame, so a client that reads state after that first frame misses no change. State frames are throttled to 10 per second, the initial one included, and the revisions in between are coalesced. A headless `reset` or `reload` sends a `state` frame with the new session's revision. The CLI uses this for `events --follow` and `watch`.
```

- [ ] **Step 6: Write the changeset**

Create `.changeset/m5-stream-barrier.md`:

```md
---
"@ironbird/cli": patch
---
`/v1/stream` sends a `state` frame with the target's current revision as soon as the stream's state subscription is live, after the event backlog. A client that reads state after that frame misses no later change; `watch` starts this way. The frame is additive, so the protocol version stays 1.
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/daemon.ts packages/cli/src/daemon.test.ts packages/cli/test/bridge.integration.test.ts docs/protocol.md .changeset/m5-stream-barrier.md
git commit -m "Send a state frame with the current revision when a stream's state subscription goes live"
```

---

### Task 5: `ironbird snapshot save` and `snapshot load`

**Files:**
- Create: `packages/cli/src/cli/snapshot-file.ts`, `packages/cli/src/cli/snapshot-file.test.ts`
- Modify: `packages/cli/src/cli/program.ts`, `packages/cli/src/cli/program.test.ts`, `packages/cli/src/cli/helpers.test.ts`
- Create: `packages/cli/src/cli/snapshot.integration.test.ts`
- Modify: `docs/cli.md` (exit codes, `snapshot`)
- Create: `.changeset/m5-snapshot-cli.md`

**Interfaces:**
- Consumes: the daemon's `snapshotSave`, `snapshotLoad`, and `status` (Task 2 for headless), `UsageError` from `./durations`, `notesDefinition` (Task 2).
- Produces: `interface SnapshotFile { app: string; target: string; rev: number; snapshot: unknown }`; `parseSnapshotFile(text: string, file: string): SnapshotFile` (throws `INVALID_PAYLOAD` `{ name: 'snapshotLoad', issues: Array<{ path: Array<string | number>; message: string }> }`); `formatSnapshotFile(record: SnapshotFile): string` (two-space JSON plus a newline). Commands: `snapshot save <file>` prints `{ target, app, rev, file }` (absolute `file`); `snapshot load <file>` prints `{ target, rev, path, value }`. An unreadable or unwritable file is a `UsageError` (exit 2). The `harness` in program.test.ts gains an optional `signal` (Task 7 uses it).

- [ ] **Step 1: Write the failing file-format tests**

Create `packages/cli/src/cli/snapshot-file.test.ts`:

```ts
import { isIronbirdError } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { formatSnapshotFile, parseSnapshotFile } from './snapshot-file';

const issuesOf = (text: string): unknown => {
  try {
    parseSnapshotFile(text, '/tmp/notes.json');
  } catch (error) {
    return isIronbirdError(error) ? { code: error.code, message: error.message, details: error.details } : error;
  }
  return 'accepted';
};

describe('snapshot files', () => {
  it('round-trips a record through format and parse, keeping a null snapshot and ignoring extra keys', () => {
    const record = { app: 'com.example.notes', target: 'ios', rev: 3, snapshot: { notes: ['milk'] } };
    expect(formatSnapshotFile(record)).toBe(`${JSON.stringify(record, null, 2)}\n`);
    expect(parseSnapshotFile(formatSnapshotFile(record), 'f')).toEqual(record);
    expect(parseSnapshotFile('{"app":"a","target":"t","rev":0,"snapshot":null,"note":"x"}', 'f')).toEqual({ app: 'a', target: 't', rev: 0, snapshot: null });
  });

  it('keeps a __proto__ key in the snapshot as data', () => {
    const parsed = parseSnapshotFile('{"app":"a","target":"t","rev":0,"snapshot":{"__proto__":{"y":2}}}', 'f');
    expect(Object.prototype.hasOwnProperty.call(parsed.snapshot, '__proto__')).toBe(true);
    expect(JSON.stringify(parsed.snapshot)).toBe('{"__proto__":{"y":2}}');
  });

  it('refuses text that is not JSON, JSON that is not an object, and an object of the wrong shape, listing every issue', () => {
    expect(issuesOf('{oops')).toMatchObject({
      code: 'INVALID_PAYLOAD',
      message: 'Invalid snapshot file /tmp/notes.json',
      details: { name: 'snapshotLoad', issues: [{ path: [], message: expect.stringMatching(/^not valid JSON: /) }] },
    });
    expect(issuesOf('[]')).toEqual({
      code: 'INVALID_PAYLOAD',
      message: 'Invalid snapshot file /tmp/notes.json',
      details: { name: 'snapshotLoad', issues: [{ path: [], message: 'expected an object with app, target, rev, and snapshot' }] },
    });
    expect(issuesOf('{"app":"","target":1,"rev":-1}')).toEqual({
      code: 'INVALID_PAYLOAD',
      message: 'Invalid snapshot file /tmp/notes.json',
      details: {
        name: 'snapshotLoad',
        issues: [
          { path: ['app'], message: 'expected a non-empty string' },
          { path: ['target'], message: 'expected a string' },
          { path: ['rev'], message: 'expected a non-negative integer' },
          { path: ['snapshot'], message: 'required' },
        ],
      },
    });
    expect(issuesOf('{"app":"a","target":"t","rev":1.5,"snapshot":{}}')).toMatchObject({ details: { issues: [{ path: ['rev'] }] } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/snapshot-file.test.ts`
Expected: FAIL, cannot resolve `./snapshot-file`.

- [ ] **Step 3: Write the file module**

Create `packages/cli/src/cli/snapshot-file.ts`:

```ts
import { IronbirdError, messageOf } from '@ironbird/core';

/** What `ironbird snapshot save` writes (M5 design §4). `target` is informational. */
export interface SnapshotFile {
  app: string;
  target: string;
  rev: number;
  snapshot: unknown;
}

interface Issue {
  path: Array<string | number>;
  message: string;
}

const invalid = (file: string, issues: Issue[]): IronbirdError => new IronbirdError('INVALID_PAYLOAD', `Invalid snapshot file ${file}`, { name: 'snapshotLoad', issues });

/**
 * Validates a snapshot file before anything is sent (M5 design §4). Hand-checked rather than
 * through Zod, which the client commands don't load. Every shape problem is listed at once.
 */
export function parseSnapshotFile(text: string, file: string): SnapshotFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(file, [{ path: [], message: `not valid JSON: ${messageOf(error)}` }]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid(file, [{ path: [], message: 'expected an object with app, target, rev, and snapshot' }]);
  }
  const record = parsed as Record<string, unknown>;
  const issues: Issue[] = [];
  const { app, target, rev } = record;
  if (typeof app !== 'string' || app === '') issues.push({ path: ['app'], message: 'expected a non-empty string' });
  if (typeof target !== 'string') issues.push({ path: ['target'], message: 'expected a string' });
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) issues.push({ path: ['rev'], message: 'expected a non-negative integer' });
  if (!Object.prototype.hasOwnProperty.call(record, 'snapshot')) issues.push({ path: ['snapshot'], message: 'required' });
  if (issues.length > 0) throw invalid(file, issues);
  return { app: app as string, target: target as string, rev: rev as number, snapshot: record['snapshot'] };
}

export function formatSnapshotFile(record: SnapshotFile): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/snapshot-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing command tests**

In `packages/cli/src/cli/helpers.test.ts`, in `'maps error codes to the documented exit codes'`, add after the `INVARIANT_FAILED` line:

```ts
    expect(exitCodeForError('INVALID_SNAPSHOT')).toBe(1);
    expect(exitCodeForError('APP_MISMATCH')).toBe(2);
```

In `packages/cli/src/cli/program.test.ts`:

1. Change the `harness` options type to `{ isTTY?: boolean; streamFrames?: StreamFrame[]; createClient?: () => DaemonClient; cwd?: string; signal?: AbortSignal } = {}` and its `signal: AbortSignal.abort(),` line to `signal: options.signal ?? AbortSignal.abort(),`.
2. Add at the end of the file:

```ts
describe('snapshot', () => {
  let dir: string;
  const status = (targets: Array<{ id: string; appId: string }>) => ({
    version: '1',
    protocol: 1,
    uptimeMs: 1,
    targets: targets.map((t) => ({ ...t, platform: 'ios', connectedAt: 0, rev: 4 })),
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-snapshot-cli-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save writes { app, target, rev, snapshot } with the app from status, and prints where', async () => {
    const h = harness({ snapshotSave: { rev: 4, snapshot: { notes: ['milk'] } }, status: status([{ id: 'ios', appId: 'com.example.notes' }]) }, { cwd: dir });
    expect(await h.run(['snapshot', 'save', 'notes.json', '--target', 'ios'])).toBe(0);
    expect(h.calls.map((call) => [call.op, call.target])).toEqual([
      ['snapshotSave', 'ios'],
      ['status', undefined],
    ]);
    expect(h.out()).toEqual({ target: 'ios', app: 'com.example.notes', rev: 4, file: path.join(dir, 'notes.json') });
    expect(JSON.parse(await readFile(path.join(dir, 'notes.json'), 'utf8'))).toEqual({ app: 'com.example.notes', target: 'ios', rev: 4, snapshot: { notes: ['milk'] } });
  });

  it('save fails with TARGET_DISCONNECTED and writes nothing when the target left before status', async () => {
    const h = harness({ snapshotSave: { rev: 4, snapshot: {} }, status: status([]) }, { cwd: dir });
    expect(await h.run(['snapshot', 'save', 'notes.json'])).toBe(1);
    expect(h.out()).toMatchObject({ error: { code: 'TARGET_DISCONNECTED', details: { target: 'headless', op: 'snapshotSave' } } });
    await expect(stat(path.join(dir, 'notes.json'))).rejects.toThrow();
  });

  it('load validates the file before sending anything, then sends its snapshot and app', async () => {
    await writeFile(path.join(dir, 'bad.json'), '{"app":"","target":1,"rev":-1}');
    const h = harness({ snapshotLoad: { rev: 9, path: '', value: { notes: [] } } }, { cwd: dir });
    expect(await h.run(['snapshot', 'load', 'bad.json'])).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.out()).toMatchObject({ error: { code: 'INVALID_PAYLOAD', details: { name: 'snapshotLoad', issues: [{ path: ['app'] }, { path: ['target'] }, { path: ['rev'] }, { path: ['snapshot'] }] } } });
    h.stdout.length = 0;
    await writeFile(path.join(dir, 'good.json'), JSON.stringify({ app: 'com.example.notes', target: 'ios', rev: 3, snapshot: { notes: [] } }));
    expect(await h.run(['snapshot', 'load', 'good.json'])).toBe(0);
    expect(h.calls).toEqual([{ op: 'snapshotLoad', target: undefined, params: { snapshot: { notes: [] }, app: 'com.example.notes' } }]);
    expect(h.out()).toEqual({ target: 'headless', rev: 9, path: '', value: { notes: [] } });
  });

  it('exits 2 when the file cannot be read or written', async () => {
    const h = harness({ snapshotSave: { rev: 1, snapshot: {} }, status: status([{ id: 'headless', appId: 'com.example.notes' }]) }, { cwd: dir });
    expect(await h.run(['snapshot', 'load', 'missing.json'])).toBe(2);
    expect(h.stderr.join('')).toContain(`Cannot read ${path.join(dir, 'missing.json')}`);
    expect(await h.run(['snapshot', 'save', 'no/such/dir/notes.json'])).toBe(2);
    expect(h.stderr.join('')).toContain(`Cannot write ${path.join(dir, 'no/such/dir/notes.json')}`);
    expect(h.stdout).toEqual([]);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts packages/cli/src/cli/helpers.test.ts`
Expected: FAIL. The helpers test passes already (both codes are mapped); the snapshot tests exit 2 with `error: unknown command 'snapshot'`.

- [ ] **Step 7: Add the commands**

In `packages/cli/src/cli/program.ts`:

1. Add `type TargetInfo` to the `@ironbird/core` import.
2. Change `import { access } from 'node:fs/promises';` to `import { access, readFile, writeFile } from 'node:fs/promises';`.
3. Add `import { formatSnapshotFile, parseSnapshotFile } from './snapshot-file';` after the `./values` import.
4. Insert after the `reload` command's closing `);`:

```ts
  const snapshot = program.command('snapshot').description('Save and load snapshots of targets that persist and restore');
  snapshot
    .command('save <file>')
    .description("Write the target's persisted state to a file as { app, target, rev, snapshot }")
    .action(
      wrap(async (ctx, file: string) => {
        const saved = await ctx.client.call<{ rev: number; snapshot: unknown }>('snapshotSave', {}, ctx.target);
        const targetId = saved.target ?? ctx.target ?? '';
        // The app id comes from the target's status entry, so `load` can refuse another app's file.
        const { targets } = await ctx.client.rpc<{ targets: TargetInfo[] }>('status');
        const entry = targets.find((candidate) => candidate.id === targetId);
        if (!entry) throw new IronbirdError('TARGET_DISCONNECTED', `Target ${targetId} disconnected before its snapshot was written`, { target: targetId, op: 'snapshotSave' });
        const out = path.resolve(io.cwd, file);
        try {
          await writeFile(out, formatSnapshotFile({ app: entry.appId, target: targetId, rev: saved.result.rev, snapshot: saved.result.snapshot }));
        } catch (error) {
          throw new UsageError(`Cannot write ${out}: ${messageOf(error)}`);
        }
        return { value: { target: targetId, app: entry.appId, rev: saved.result.rev, file: out } };
      }),
    );
  snapshot
    .command('load <file>')
    .description('Validate a snapshot file, then restore the target from it')
    .action(
      wrap(async (ctx, file: string) => {
        const from = path.resolve(io.cwd, file);
        let text: string;
        try {
          text = await readFile(from, 'utf8');
        } catch (error) {
          throw new UsageError(`Cannot read ${from}: ${messageOf(error)}`);
        }
        // Validated before anything is sent, so a bad file never reaches the target (M5 design §4).
        const record = parseSnapshotFile(text, from);
        return { value: withTarget(await ctx.client.call('snapshotLoad', { snapshot: record.snapshot, app: record.app }, ctx.target)) };
      }),
    );
```

- [ ] **Step 8: Run the command tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts packages/cli/src/cli/helpers.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the round trip against a daemon**

Create `packages/cli/src/cli/snapshot.integration.test.ts`:

```ts
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { counterDefinition } from '../../test/helpers/counter-app';
import { notesDefinition } from '../../test/helpers/snapshot-app';
import { startDaemon } from '../daemon';
import { createHeadlessTarget } from '../headless-target';
import { createDaemonClient, type DaemonClient } from './client';
import { buildProgram } from './program';

// The CLI in process, against a real daemon and headless target: spec §11's snapshot round trip.
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function session(definition = notesDefinition): Promise<{ url: string; client: DaemonClient; dir: string }> {
  const target = await createHeadlessTarget({ definition, appId: 'com.example.notes', settleTimeoutMs: 500, env: {}, log: () => {} });
  const daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', log: () => {} });
  const dir = await mkdtemp(path.join(tmpdir(), 'ironbird-snapshot-'));
  cleanups.push(async () => {
    await daemon.close();
    await target.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { url: daemon.url, client: createDaemonClient({ url: daemon.url }), dir };
}

async function cli(url: string, cwd: string, ...args: string[]): Promise<{ code: number; out: Record<string, unknown>; err: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { run } = buildProgram({ cwd, env: {}, isTTY: false, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), version: '0.0.0-test', signal: new AbortController().signal });
  const code = await run([...args, '--daemon', url]);
  const text = stdout.join('').trim();
  return { code, out: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>, err: stderr.join('') };
}

const add = (client: DaemonClient, text: string): Promise<unknown> => client.rpc('dispatch', { name: 'note.add', payload: { text } });

describe('ironbird snapshot against a daemon', () => {
  it('saves, mutates, loads, and gets the same state back', async () => {
    const { url, client, dir } = await session();
    await add(client, 'milk');
    const saved = await cli(url, dir, 'snapshot', 'save', 'notes.json');
    expect(saved).toMatchObject({ code: 0, out: { target: 'headless', app: 'com.example.notes', rev: 1, file: path.join(dir, 'notes.json') } });
    expect(JSON.parse(await readFile(path.join(dir, 'notes.json'), 'utf8'))).toEqual({ app: 'com.example.notes', target: 'headless', rev: 1, snapshot: { notes: ['milk'], status: 'idle' } });
    const before = await client.rpc<{ value: unknown }>('getState', {});
    await add(client, 'eggs');
    const loaded = await cli(url, dir, 'snapshot', 'load', 'notes.json');
    expect(loaded).toMatchObject({ code: 0, out: { target: 'headless', rev: 3, path: '', value: { notes: ['milk'], status: 'idle' } } });
    expect((await client.rpc<{ value: unknown }>('getState', {})).value).toEqual(before.value);
  });

  it('refuses malformed files with INVALID_PAYLOAD, a file from another app with APP_MISMATCH, and a snapshot the app rejects with INVALID_SNAPSHOT, leaving the state unchanged', async () => {
    const { url, client, dir } = await session();
    await add(client, 'milk');
    const files: Array<[string, string, number, string]> = [
      ['garbage.json', 'not json', 1, 'INVALID_PAYLOAD'],
      ['array.json', '[]', 1, 'INVALID_PAYLOAD'],
      ['shape.json', '{"app":"com.example.notes","target":"headless","rev":"1"}', 1, 'INVALID_PAYLOAD'],
      ['other.json', JSON.stringify({ app: 'com.example.other', target: 'headless', rev: 1, snapshot: { notes: [], status: 'idle' } }), 2, 'APP_MISMATCH'],
      ['invalid.json', JSON.stringify({ app: 'com.example.notes', target: 'headless', rev: 1, snapshot: { notes: 'milk' } }), 1, 'INVALID_SNAPSHOT'],
    ];
    for (const [name, text, code, errorCode] of files) {
      await writeFile(path.join(dir, name), text);
      const result = await cli(url, dir, 'snapshot', 'load', name);
      expect({ name, code: result.code, error: (result.out['error'] as { code?: string } | undefined)?.code }).toEqual({ name, code, error: errorCode });
    }
    expect(await client.rpc('getState', {})).toEqual({ rev: 1, path: '', value: { notes: ['milk'], status: 'idle' } });
  });

  it('fails a save of a state that holds a Map with INVALID_SNAPSHOT and writes no file', async () => {
    const { url, client, dir } = await session();
    await client.rpc('dispatch', { name: 'state.junk', payload: {} });
    const saved = await cli(url, dir, 'snapshot', 'save', 'notes.json');
    expect(saved).toMatchObject({ code: 1, out: { error: { code: 'INVALID_SNAPSHOT', details: { path: 'junk', reason: 'Map' } } } });
    await expect(stat(path.join(dir, 'notes.json'))).rejects.toThrow();
  });

  it('answers UNSUPPORTED for an app that neither persists nor restores', async () => {
    const { url, dir } = await session(counterDefinition);
    expect(await cli(url, dir, 'snapshot', 'save', 'counter.json')).toMatchObject({ code: 1, out: { error: { code: 'UNSUPPORTED', details: { op: 'snapshotSave', target: 'headless' } } } });
  });
});
```

- [ ] **Step 10: Run it**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/snapshot.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 11: Update cli.md**

In `docs/cli.md`:

1. Change `| Last updated | 2026-09-29 |` to `| Last updated | 2026-10-04 |`.
2. In the exit-code table, change the code-1 row's causes to `` `INVALID_PAYLOAD`, `INVALID_SNAPSHOT`, `UNKNOWN_COMMAND`, `UNKNOWN_FAKE`, `UNKNOWN_CONTROL`, `DISPATCH_FAILED`, `UNSUPPORTED`, `SCREENSHOT_FAILED`, `TARGET_DISCONNECTED`, `CLOCK_RUNAWAY`, `INTERNAL` ``.
3. Replace the whole `### snapshot (P1)` section (heading and its `text` block) with:

````md
### snapshot

```text
ironbird snapshot save <file>
ironbird snapshot load <file>
```

For targets that declare `persist` and `restore`; others fail with `UNSUPPORTED`.

`save` asks the target for its persisted state and writes `{ "app", "target", "rev", "snapshot" }` to `<file>` as JSON, with `app` from the target's `status` entry, then prints `{ target, app, rev, file }` with `file` absolute. A state that can't be saved losslessly, such as one holding a `Map`, a `Date`, a class instance, or a cycle, fails with `INVALID_SNAPSHOT` naming the first such path, and nothing is written. A file that can't be written exits 2.

`load` reads `<file>` and checks that it is a JSON object with a non-empty string `app`, a string `target`, a non-negative integer `rev`, and a `snapshot`; only then does it send `snapshotLoad` with the file's `snapshot` and `app`. A file that isn't JSON or doesn't have that shape fails with `INVALID_PAYLOAD` and details `{ name: "snapshotLoad", issues }`, listing every problem, before anything is sent; a file that can't be read exits 2. The target refuses a snapshot saved from another app with `APP_MISMATCH` and one its own validation rejects with `INVALID_SNAPSHOT`. `target` in the file is informational: a snapshot can be loaded into another target of the same app. It prints `{ target, rev, path: "", value }`, the whole state after the load.

```sh
ironbird snapshot save todos.json
ironbird send todos.clear
ironbird snapshot load todos.json
```
````

- [ ] **Step 12: Write the changeset**

Create `.changeset/m5-snapshot-cli.md`:

```md
---
"@ironbird/cli": patch
---
New commands `ironbird snapshot save <file>` and `ironbird snapshot load <file>`. `save` writes `{ app, target, rev, snapshot }`, taking `app` from the target's status entry, and prints `{ target, app, rev, file }`. `load` validates the file before sending anything (`INVALID_PAYLOAD` with `{ name: 'snapshotLoad', issues }` for a file that isn't JSON or has the wrong shape), then sends `snapshotLoad` with the file's `snapshot` and `app`, so the target refuses another app's snapshot with `APP_MISMATCH`. A file that can't be read or written exits 2. `INVALID_SNAPSHOT` exits 1.
```

- [ ] **Step 13: Commit**

```bash
git add packages/cli/src/cli/snapshot-file.ts packages/cli/src/cli/snapshot-file.test.ts packages/cli/src/cli/program.ts packages/cli/src/cli/program.test.ts packages/cli/src/cli/helpers.test.ts packages/cli/src/cli/snapshot.integration.test.ts docs/cli.md .changeset/m5-snapshot-cli.md
git commit -m "Add ironbird snapshot save and load"
```

---

### Task 6: The JSON Patch differ

**Files:**
- Create: `packages/cli/src/watch/diff.ts`, `packages/cli/src/watch/diff.test.ts`

**Interfaces:**
- Consumes: `deepEqual` from `@ironbird/core`.
- Produces (pinned by the contract): `type JsonPatchOp = { op: 'add'; path: string; value: unknown } | { op: 'remove'; path: string } | { op: 'replace'; path: string; value: unknown }`; `type Presence = { present: true; value: unknown } | { present: false }`; `escapePointerToken(token: string): string`; `diff(prev: unknown, next: unknown): JsonPatchOp[]` (both values present); `patchBetween(prev: Presence, next: Presence): JsonPatchOp[]` (the root add/remove rules of §5). Values are JSON as parsed from the daemon.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/watch/diff.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/watch/diff.test.ts`
Expected: FAIL, cannot resolve `./diff`.

- [ ] **Step 3: Write the differ**

Create `packages/cli/src/watch/diff.ts`:

```ts
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
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/watch/diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/watch/diff.ts packages/cli/src/watch/diff.test.ts
git commit -m "Add the JSON Patch differ for watch"
```

---

### Task 7: `ironbird watch`

**Files:**
- Create: `packages/cli/src/watch/watch.ts`, `packages/cli/src/watch/watch.test.ts`, `packages/cli/src/watch/watch.integration.test.ts`
- Modify: `packages/cli/src/cli/output.ts`, `packages/cli/src/cli/program.ts`, `packages/cli/src/cli/program.test.ts`
- Modify: `packages/cli/test/cli.integration.test.ts`
- Modify: `docs/cli.md` (`watch`)
- Create: `.changeset/m5-watch.md`

**Interfaces:**
- Consumes: `patchBetween`, `Presence` (Task 6); `DaemonClient` (`call`, `stream`); `exitCodeForError`; the initial `state` frame (Task 4); the headless state notification after `reset` (Task 2); the `harness` `signal` option (Task 5).
- Produces: `interface WatchOptions { client: DaemonClient; target: string | undefined; path: string; signal: AbortSignal; write(line: string): void }` and `runWatch(options: WatchOptions): Promise<number>` (the exit code; rejects only when the stream fails to open or fails mid-way without an error frame). `asErrorShape(data: unknown): ErrorShape | undefined` moves from program.ts to output.ts and is exported. Command `watch [--path <path>]`.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/cli/src/watch/watch.test.ts`:

```ts
import { IronbirdError } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { DaemonClient } from '../cli/client';
import { runWatch } from './watch';

type Kind = 'event' | 'state' | 'target' | 'error';

interface PendingRead {
  params: Record<string, unknown>;
  target: string | undefined;
  resolve(result: Record<string, unknown>): void;
  reject(error: unknown): void;
}

/** A scripted daemon: the test emits stream frames and settles each getState read by hand. */
function fakeDaemon(options: { streamError?: unknown } = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown>; target: string | undefined }> = [];
  const reads: PendingRead[] = [];
  let onMessage: ((kind: Kind, data: unknown) => void) | undefined;
  let endStream: () => void = () => {};
  const client: DaemonClient = {
    url: 'http://fake',
    call<T>(op: string, params: Record<string, unknown> = {}, target?: string): Promise<{ target?: string; result: T }> {
      calls.push({ op, params, target });
      if (op === 'events') return Promise.resolve({ target: target ?? 'headless', result: { events: [], nextSeq: 7, truncated: false } as T });
      if (op === 'getState') {
        return new Promise((resolve, reject) => {
          reads.push({ params, target, resolve: (result) => resolve({ target: target ?? 'headless', result: result as T }), reject });
        });
      }
      return Promise.reject(new Error(`unexpected ${op}`));
    },
    async rpc<T>(op: string, params?: Record<string, unknown>, target?: string): Promise<T> {
      return (await client.call<T>(op, params, target)).result;
    },
    stream(streamOptions) {
      calls.push({ op: 'stream', params: { since: streamOptions.since }, target: streamOptions.target });
      if (options.streamError !== undefined) return Promise.reject(options.streamError);
      onMessage = streamOptions.onMessage;
      return new Promise<void>((resolve) => {
        endStream = resolve;
        streamOptions.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
  return { client, calls, reads, frame: (kind: Kind, data: unknown) => onMessage?.(kind, data), end: () => endStream() };
}

function watch(daemon: ReturnType<typeof fakeDaemon>, path = '', target?: string) {
  const lines: unknown[] = [];
  const controller = new AbortController();
  const done = runWatch({ client: daemon.client, target, path, signal: controller.signal, write: (line) => lines.push(JSON.parse(line)) });
  return { lines, controller, done };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('runWatch', () => {
  it('opens the stream at the event cursor on the pinned target and reads only after the first state frame', async () => {
    const d = fakeDaemon();
    const w = watch(d, 'cart');
    await tick();
    expect(d.calls).toEqual([
      { op: 'events', params: { limit: 0 }, target: undefined },
      { op: 'stream', params: { since: 7 }, target: 'headless' },
    ]);
    d.frame('event', { seq: 8, t: 0, source: 'app', name: 'x' });
    d.frame('target', { id: 'ios', platform: 'ios', appId: 'a', status: 'connected' });
    expect(d.reads).toHaveLength(0);
    d.frame('state', { rev: 3 });
    expect(d.reads).toHaveLength(1);
    expect(d.reads[0]).toMatchObject({ params: { path: 'cart' }, target: 'headless' });
    d.reads[0]!.resolve({ rev: 3, path: 'cart', value: { items: [] } });
    await tick();
    expect(w.lines).toEqual([{ rev: 3, patch: [{ op: 'add', path: '', value: { items: [] } }] }]);
    w.controller.abort();
    expect(await w.done).toBe(0);
  });

  it('uses the given target for every call', async () => {
    const d = fakeDaemon();
    const w = watch(d, '', 'ios');
    await tick();
    d.frame('state', { rev: 0 });
    expect(d.calls.map((call) => call.target)).toEqual(['ios', 'ios', 'ios']);
    w.controller.abort();
    await w.done;
  });

  it('keeps one read in flight and reads once more after frames that arrived during it, labelling lines with the revision read', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.frame('state', { rev: 2 });
    d.frame('state', { rev: 3 });
    expect(d.reads).toHaveLength(1);
    d.reads[0]!.resolve({ rev: 1, path: '', value: { n: 1 } });
    await tick();
    expect(d.reads).toHaveLength(2);
    d.reads[1]!.resolve({ rev: 3, path: '', value: { n: 3 } });
    await tick();
    expect(d.reads).toHaveLength(2);
    expect(w.lines).toEqual([
      { rev: 1, patch: [{ op: 'add', path: '', value: { n: 1 } }] },
      { rev: 3, patch: [{ op: 'replace', path: '/n', value: 3 }] },
    ]);
    w.controller.abort();
    await w.done;
  });

  it('reads again after a frame during a read even when it carries the revision the read returned', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 5 });
    d.frame('state', { rev: 5 });
    d.reads[0]!.resolve({ rev: 5, path: '', value: { n: 1 } });
    await tick();
    // After a reset and five quick dispatches the revision is 5 again, with another state.
    expect(d.reads).toHaveLength(2);
    d.reads[1]!.resolve({ rev: 5, path: '', value: { n: 2 } });
    await tick();
    expect(w.lines).toEqual([
      { rev: 5, patch: [{ op: 'add', path: '', value: { n: 1 } }] },
      { rev: 5, patch: [{ op: 'replace', path: '/n', value: 2 }] },
    ]);
    w.controller.abort();
    await w.done;
  });

  it('reads on a frame that arrives while idle, prints nothing for an unchanged value, and follows revisions backwards', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 5 });
    d.reads[0]!.resolve({ rev: 5, path: '', value: { n: 1 } });
    await tick();
    d.frame('state', { rev: 5 });
    d.reads[1]!.resolve({ rev: 5, path: '', value: { n: 1 } });
    await tick();
    d.frame('state', { rev: 0 });
    d.reads[2]!.resolve({ rev: 0, path: '', value: { n: 0 } });
    await tick();
    expect(w.lines).toEqual([
      { rev: 5, patch: [{ op: 'add', path: '', value: { n: 1 } }] },
      { rev: 0, patch: [{ op: 'replace', path: '/n', value: 0 }] },
    ]);
    w.controller.abort();
    await w.done;
  });

  it('prints [] first for a missing path, then an add and a remove at the root as it appears and disappears', async () => {
    const d = fakeDaemon();
    const w = watch(d, 'extra');
    await tick();
    const step = async (index: number, result: Record<string, unknown>): Promise<void> => {
      d.frame('state', { rev: index });
      d.reads[index]!.resolve(result);
      await tick();
    };
    await step(0, { rev: 0, path: 'extra' });
    await step(1, { rev: 1, path: 'extra', value: null });
    await step(2, { rev: 2, path: 'extra' });
    await step(3, { rev: 3, path: 'extra' });
    expect(w.lines).toEqual([
      { rev: 0, patch: [] },
      { rev: 1, patch: [{ op: 'add', path: '', value: null }] },
      { rev: 2, patch: [{ op: 'remove', path: '' }] },
    ]);
    w.controller.abort();
    await w.done;
  });

  it('ends on an error frame with its exit code, after nothing else', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.frame('error', { code: 'TARGET_DISCONNECTED', message: 'Target ios disconnected', details: { target: 'ios', op: 'stream' } });
    d.reads[0]!.resolve({ rev: 1, path: '', value: {} });
    expect(await w.done).toBe(1);
    await tick();
    expect(w.lines).toEqual([{ error: { code: 'TARGET_DISCONNECTED', message: 'Target ios disconnected', details: { target: 'ios', op: 'stream' } } }]);
  });

  it('reports a malformed error frame as INTERNAL', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('error', 'nope');
    expect(await w.done).toBe(1);
    expect(w.lines).toEqual([{ error: { code: 'INTERNAL', message: 'Malformed error frame from daemon' } }]);
  });

  it('ends with the error and its exit code when a read fails', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.reads[0]!.reject(new IronbirdError('NO_TARGET', 'No target ios', { available: [] }));
    expect(await w.done).toBe(5);
    expect(w.lines).toEqual([{ error: { code: 'NO_TARGET', message: 'No target ios', details: { available: [] } } }]);
  });

  it('ends with 0 on abort and prints nothing for a read still in flight', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    w.controller.abort();
    d.reads[0]!.resolve({ rev: 1, path: '', value: {} });
    expect(await w.done).toBe(0);
    await tick();
    expect(w.lines).toEqual([]);
  });

  it('lets a read in flight print when the daemon ends the stream, then returns 0', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.end();
    d.reads[0]!.resolve({ rev: 1, path: '', value: { n: 1 } });
    expect(await w.done).toBe(0);
    expect(w.lines).toEqual([{ rev: 1, patch: [{ op: 'add', path: '', value: { n: 1 } }] }]);
  });

  it('rejects when the stream fails to open', async () => {
    const d = fakeDaemon({ streamError: new IronbirdError('UNAUTHORIZED', 'Token missing or wrong for this daemon') });
    await expect(watch(d).done).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/watch/watch.test.ts`
Expected: FAIL, cannot resolve `./watch`.

- [ ] **Step 3: Move `asErrorShape` and write the watcher**

In `packages/cli/src/cli/output.ts`, append:

```ts
/** Recognizes a stream frame shaped like an ErrorShape (an object with string `code` and `message`). */
export function asErrorShape(data: unknown): ErrorShape | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const candidate = data as { code?: unknown; message?: unknown };
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return undefined;
  return candidate as ErrorShape;
}
```

In `packages/cli/src/cli/program.ts`, delete the local `asErrorShape` function and its doc comment, remove `type ErrorShape` from the `@ironbird/core` import, and change the output import to `import { asErrorShape, createOutput, withTarget, type Output } from './output';`.

Create `packages/cli/src/watch/watch.ts`:

```ts
import { toErrorShape, type ErrorShape } from '@ironbird/core';
import type { DaemonClient } from '../cli/client';
import { exitCodeForError } from '../cli/exit-codes';
import { asErrorShape } from '../cli/output';
import { patchBetween, type Presence } from './diff';

export interface WatchOptions {
  client: DaemonClient;
  /** The target to follow; when undefined, the one the daemon picks for the first call, pinned from then on. */
  target: string | undefined;
  /** Dot path to watch; `''` is the whole state. */
  path: string;
  /** Aborting it (SIGINT) ends the watch with exit 0. */
  signal: AbortSignal;
  /** Receives each JSON line, newline included. */
  write(line: string): void;
}

/**
 * `ironbird watch` (M5 design D5, §5). Opens the stream at the event cursor, so no backlog is
 * replayed, and treats every `state` frame as a change signal: values and revisions always come
 * from a `getState` read. The first frame is the daemon's barrier, sent once the stream's state
 * subscription is live, so reading after it misses no change. Resolves to the exit code.
 */
export async function runWatch(options: WatchOptions): Promise<number> {
  const { client, path, signal, write } = options;
  const cursor = await client.call<{ nextSeq: number }>('events', { limit: 0 }, options.target);
  const target = options.target ?? cursor.target;
  const stream = new AbortController();
  let stopped = false;
  let exit = 0;
  const stop = (): void => {
    stopped = true;
    stream.abort();
  };
  const fail = (shape: ErrorShape): void => {
    if (stopped) return;
    write(`${JSON.stringify({ error: shape })}\n`);
    exit = exitCodeForError(shape.code);
    stop();
  };

  let printed: Presence = { present: false };
  let first = true;
  let reading = false;
  let dirty = false;
  let pumping: Promise<void> = Promise.resolve();

  const readOnce = async (): Promise<void> => {
    const { result } = await client.call<{ rev: number; value?: unknown }>('getState', { path }, target);
    if (stopped) return;
    // JSON drops an `undefined` value, so a missing path arrives without the property.
    const next: Presence = Object.prototype.hasOwnProperty.call(result, 'value') ? { present: true, value: result.value } : { present: false };
    const patch = patchBetween(printed, next);
    // The first line always prints, `[]` for a missing path; after it, an unchanged value prints nothing.
    if (!first && patch.length === 0) return;
    write(`${JSON.stringify({ rev: result.rev, patch })}\n`);
    printed = next;
    first = false;
  };

  // At most one read in flight. Any frame that arrives during a read marks it dirty, whatever its
  // revision: revisions restart after `reset` and `reload` and coalesce under the throttle, so an
  // equal revision can still be a new state. The loop's check and the `reading = false` after it
  // run in one synchronous turn, so no frame can fall between them unseen.
  const pump = async (): Promise<void> => {
    reading = true;
    try {
      do {
        dirty = false;
        await readOnce();
      } while (dirty && !stopped);
    } catch (error) {
      fail(toErrorShape(error));
    } finally {
      reading = false;
    }
  };

  const onMessage = (kind: 'event' | 'state' | 'target' | 'error', data: unknown): void => {
    if (stopped) return;
    if (kind === 'error') {
      fail(asErrorShape(data) ?? { code: 'INTERNAL', message: 'Malformed error frame from daemon' });
      return;
    }
    if (kind !== 'state') return;
    if (reading) dirty = true;
    else pumping = pump();
  };

  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  try {
    await client.stream({ target, since: cursor.result.nextSeq, signal: stream.signal, onMessage });
  } catch (error) {
    if (!stopped) {
      stopped = true;
      throw error;
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
  // The daemon ended the stream without an error frame (it shut down): let a read in flight print.
  if (!stopped) await pumping;
  return exit;
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/watch/watch.test.ts packages/cli/src/cli/program.test.ts`
Expected: PASS (program.test.ts still passes after the `asErrorShape` move).

- [ ] **Step 5: Write the failing command tests**

In `packages/cli/src/cli/program.test.ts`, add at the end of the file:

```ts
describe('watch', () => {
  it('reads the path after the first state frame and prints the first line, on the target given', async () => {
    const h = harness(
      { events: { events: [], nextSeq: 4, truncated: false }, getState: { rev: 2, path: 'cart', value: { items: [] } } },
      { streamFrames: [{ kind: 'state', data: { rev: 2 } }], signal: new AbortController().signal },
    );
    expect(await h.run(['watch', '--path', 'cart', '--target', 'ios'])).toBe(0);
    expect(h.calls).toEqual([
      { op: 'events', params: { limit: 0 }, target: 'ios' },
      { op: 'getState', params: { path: 'cart' }, target: 'ios' },
    ]);
    expect(h.stdout).toEqual(['{"rev":2,"patch":[{"op":"add","path":"","value":{"items":[]}}]}\n']);
  });

  it('prints an error frame as a JSON line even in a TTY and exits with its code', async () => {
    const h = harness(
      { events: { events: [], nextSeq: 0, truncated: false } },
      { isTTY: true, streamFrames: [{ kind: 'error', data: { code: 'TARGET_DISCONNECTED', message: 'gone' } }], signal: new AbortController().signal },
    );
    expect(await h.run(['watch'])).toBe(1);
    expect(h.stdout).toEqual(['{"error":{"code":"TARGET_DISCONNECTED","message":"gone"}}\n']);
  });
});
```

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts`
Expected: FAIL, both exit 2 with `error: unknown command 'watch'`.

- [ ] **Step 6: Add the command**

In `packages/cli/src/cli/program.ts`, add `import { runWatch } from '../watch/watch';` after the `../verify-bundle` import, and insert after the `events` command's closing `);`:

```ts
  program
    .command('watch')
    .description('Print { rev, patch } JSON lines as the state at a path changes, until interrupted')
    .option('--path <path>', 'watch only this subtree of state', '')
    .action(wrap(async (ctx, opts: { path: string }) => ({ exit: await runWatch({ client: ctx.client, target: ctx.target, path: opts.path, signal: signal(), write: io.stdout }) })));
```

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the boundary tests against a daemon**

Create `packages/cli/src/watch/watch.integration.test.ts`:

```ts
import { IronbirdError, createTarget, defineCommands, defineHeadless } from '@ironbird/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDaemonClient, type DaemonClient } from '../cli/client';
import { startDaemon } from '../daemon';
import type { DaemonTarget } from '../daemon-target';
import { createHeadlessTarget } from '../headless-target';
import { runWatch } from './watch';

// Spec §11's watch boundaries, against a real daemon and headless target in process.

interface WatchState {
  count: number;
  extra?: { note: string };
}

const watchApp = defineHeadless(() => {
  let state: WatchState = { count: 0 };
  const listeners = new Set<() => void>();
  const set = (next: WatchState): void => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const commands = defineCommands({
    'count.add': z.object({ by: z.number().int() }),
    'extra.set': z.object({ note: z.string() }),
    'extra.clear': z.object({}),
  });
  const target = createTarget({
    commands,
    dispatch: ({ name, payload }) => {
      if (name === 'count.add') set({ ...state, count: state.count + (payload as { by: number }).by });
      if (name === 'extra.set') set({ ...state, extra: { note: (payload as { note: string }).note } });
      if (name === 'extra.clear') set({ count: state.count });
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return { target };
});

interface Line {
  rev?: number;
  patch?: unknown[];
  error?: { code: string };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function session(): Promise<{ client: DaemonClient; send(name: string, payload?: unknown): Promise<unknown> }> {
  const target = await createHeadlessTarget({ definition: watchApp, appId: 'com.example.watch', settleTimeoutMs: 500, env: {}, log: () => {} });
  const daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', log: () => {} });
  cleanups.push(async () => {
    await daemon.close();
    await target.dispose();
  });
  const client = createDaemonClient({ url: daemon.url });
  return { client, send: (name, payload = {}) => client.rpc('dispatch', { name, payload, settle: false }) };
}

function start(client: DaemonClient, path = ''): { lines: Line[]; controller: AbortController; done: Promise<number> } {
  const lines: Line[] = [];
  const controller = new AbortController();
  const done = runWatch({ client, target: undefined, path, signal: controller.signal, write: (line) => lines.push(JSON.parse(line) as Line) });
  cleanups.push(async () => {
    controller.abort();
    await done.catch(() => undefined);
  });
  return { lines, controller, done };
}

/**
 * Wraps a client so a test can act inside the watcher's reads and see the state frames it
 * receives: `beforeRead(n)` runs before the n-th getState reaches the daemon, `afterRead(n)` after
 * its result is back but before the watcher sees it.
 */
function observed(client: DaemonClient, hooks: { beforeRead?: (n: number) => Promise<void>; afterRead?: (n: number) => Promise<void> }): { client: DaemonClient; revs: number[] } {
  const revs: number[] = [];
  let reads = 0;
  const wrapped: DaemonClient = {
    url: client.url,
    async call<T>(op: string, params?: Record<string, unknown>, target?: string): Promise<{ target?: string; result: T }> {
      if (op !== 'getState') return client.call<T>(op, params, target);
      reads += 1;
      const n = reads;
      await hooks.beforeRead?.(n);
      const result = await client.call<T>(op, params, target);
      await hooks.afterRead?.(n);
      return result;
    },
    rpc: <T>(op: string, params?: Record<string, unknown>, target?: string): Promise<T> => client.rpc<T>(op, params, target),
    stream: (options) =>
      client.stream({
        ...options,
        onMessage: (kind, data) => {
          if (kind === 'state') revs.push((data as { rev: number }).rev);
          options.onMessage(kind, data);
        },
      }),
  };
  return { client: wrapped, revs };
}

async function until(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
}

/** Longer than the daemon's 100 ms state throttle, so any frame still owed has arrived. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

const add = (value: unknown) => [{ op: 'add', path: '', value }];
const count = (value: number) => [{ op: 'replace', path: '/count', value }];

describe('watch against a daemon', () => {
  it('shows a change made before the stream opened in the first line', async () => {
    const s = await session();
    await s.send('count.add', { by: 2 });
    const w = start(s.client);
    await until(() => w.lines.length === 1, 'the first line');
    expect(w.lines).toEqual([{ rev: 1, patch: add({ count: 2 }) }]);
    await quiet();
    expect(w.lines).toHaveLength(1);
  });

  it('shows a change made between the barrier and the first read', async () => {
    const s = await session();
    const o = observed(s.client, {
      beforeRead: async (n) => {
        if (n === 1) await s.send('count.add', { by: 1 });
      },
    });
    const w = start(o.client);
    await until(() => w.lines.length === 1, 'the first line');
    expect(o.revs[0]).toBe(0);
    expect(w.lines).toEqual([{ rev: 1, patch: add({ count: 1 }) }]);
    await quiet();
    expect(w.lines).toHaveLength(1);
  });

  it('reads again after a change made during the first read', async () => {
    const s = await session();
    const o = observed(s.client, {
      afterRead: async (n) => {
        if (n !== 1) return;
        await s.send('count.add', { by: 1 });
        await until(() => o.revs.includes(1), 'the change frame during the read');
      },
    });
    const w = start(o.client);
    await until(() => w.lines.length === 2, 'both lines');
    expect(w.lines).toEqual([
      { rev: 0, patch: add({ count: 0 }) },
      { rev: 1, patch: count(1) },
    ]);
    await quiet();
    expect(w.lines).toHaveLength(2);
  });

  it('reads again after a change made during a slow later read', async () => {
    const s = await session();
    const o = observed(s.client, {
      afterRead: async (n) => {
        if (n !== 2) return;
        await s.send('count.add', { by: 1 });
        await until(() => o.revs.includes(2), 'the second change frame during the read');
      },
    });
    const w = start(o.client);
    await until(() => w.lines.length === 1, 'the first line');
    await s.send('count.add', { by: 1 });
    await until(() => w.lines.length === 3, 'both changes');
    expect(w.lines).toEqual([
      { rev: 0, patch: add({ count: 0 }) },
      { rev: 1, patch: count(1) },
      { rev: 2, patch: count(2) },
    ]);
  });

  it('follows a reset that moves the revision backwards', async () => {
    const s = await session();
    const w = start(s.client);
    await until(() => w.lines.length === 1, 'the first line');
    for (let i = 0; i < 3; i += 1) await s.send('count.add', { by: 1 });
    await until(() => w.lines.at(-1)?.rev === 3, 'revision 3');
    const before = w.lines.length;
    await s.client.rpc('reset');
    await until(() => w.lines.length > before, 'the reset');
    expect(w.lines.at(-1)).toEqual({ rev: 0, patch: count(0) });
  });

  it('watches one path: [] while missing, add when it appears, nothing for changes elsewhere, remove when it disappears', async () => {
    const s = await session();
    const w = start(s.client, 'extra');
    await until(() => w.lines.length === 1, 'the first line');
    expect(w.lines).toEqual([{ rev: 0, patch: [] }]);
    await s.send('extra.set', { note: 'a' });
    await until(() => w.lines.length === 2, 'the path to appear');
    expect(w.lines[1]).toEqual({ rev: 1, patch: add({ note: 'a' }) });
    await s.send('count.add', { by: 1 });
    await quiet();
    expect(w.lines).toHaveLength(2);
    await s.send('extra.clear');
    await until(() => w.lines.length === 3, 'the path to disappear');
    expect(w.lines[2]).toEqual({ rev: 3, patch: [{ op: 'remove', path: '' }] });
  });

  it('ends with exit 0 when interrupted and prints nothing after', async () => {
    const s = await session();
    const w = start(s.client);
    await until(() => w.lines.length === 1, 'the first line');
    w.controller.abort();
    expect(await w.done).toBe(0);
    await s.send('count.add', { by: 1 });
    await quiet();
    expect(w.lines).toHaveLength(1);
  });

  it('ends on the daemon error frame with its exit code', async () => {
    let eventsCalls = 0;
    const flaky: DaemonTarget = {
      id: 'stub',
      info: () => ({ id: 'stub', platform: 'headless', appId: 'com.example.watch', connectedAt: 0, rev: 0 }),
      async run(op) {
        if (op === 'events') {
          eventsCalls += 1;
          // The watcher's own cursor read succeeds; the stream's backlog read finds the target gone.
          if (eventsCalls === 1) return { events: [], nextSeq: 0, truncated: false };
          throw new IronbirdError('TARGET_DISCONNECTED', 'Target stub disconnected', { target: 'stub', op: 'events' });
        }
        return { rev: 0, path: '', value: {} };
      },
      onEvent: () => () => {},
      onState: () => () => {},
      dispose: async () => {},
    };
    const daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', targets: [flaky], defaultTarget: 'stub', log: () => {} });
    cleanups.push(() => daemon.close());
    const w = start(createDaemonClient({ url: daemon.url }));
    expect(await w.done).toBe(1);
    expect(w.lines).toEqual([{ error: { code: 'TARGET_DISCONNECTED', message: 'Target stub disconnected', details: { target: 'stub', op: 'events' } } }]);
  });
});
```

- [ ] **Step 8: Run them**

Run: `pnpm exec vitest run --project unit packages/cli/src/watch/watch.integration.test.ts`
Expected: PASS (8 tests). These depend on Task 2's reset notification and Task 4's barrier; with either reverted, the reset test or every boundary test times out.

- [ ] **Step 9: Add the binary test ended by SIGINT**

In `packages/cli/test/cli.integration.test.ts`, add inside `describe('ironbird CLI against the example app', ...)`:

```ts
  it('watch prints the first value and each change as JSON lines, and exits 0 on SIGINT', async () => {
    await ironbird('reset');
    const child = spawn('node', [bin, 'watch', '--path', 'cart.items'], { cwd: example, env, stdio: ['ignore', 'pipe', 'inherit'] });
    const lines: Array<{ rev: number; patch: Array<{ op: string; path: string; value?: unknown }> }> = [];
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, end)) as (typeof lines)[number]);
        buffer = buffer.slice(end + 1);
      }
    });
    const exitCode = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const until = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 1_000 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!ready()) throw new Error(`timed out waiting for ${what}`);
    };
    await until(() => lines.length === 1, 'the first line');
    expect(lines[0]).toEqual({ rev: 0, patch: [{ op: 'add', path: '', value: [] }] });
    await ironbird('send', 'cart.addItem', '{"sku":"cut-45","qty":1}');
    await until(() => lines.length === 2, 'the change');
    expect(lines[1]?.patch).toEqual([{ op: 'add', path: '/0', value: expect.objectContaining({ sku: 'cut-45' }) }]);
    child.kill('SIGINT');
    expect(await exitCode).toBe(0);
  });
```

Run: `pnpm --filter @ironbird/core build && pnpm --filter @ironbird/cli build && pnpm exec vitest run --project serial packages/cli/test/cli.integration.test.ts`
Expected: PASS, including the existing tests in the file.

- [ ] **Step 10: Update cli.md**

In `docs/cli.md`, replace the whole `### watch (P1)` section (heading, `text` block, and its one-line description) with:

````md
### watch

```text
ironbird watch [--path <path>]
```

Prints one JSON line per change to the state at `--path` (default: the whole state), regardless of TTY, until interrupted: `{ "rev": 7, "patch": [...] }`. `patch` is a JSON Patch (RFC 6902) that turns the last printed value into the new one. Its pointers are relative to the value at `--path`, so the root is `""`, and keys escape `~` as `~0` and `/` as `~1` (RFC 6901). `rev` is the revision the read returned.

- The first line is always printed: `[{ "op": "add", "path": "", "value": ... }]` with the current value, or `[]` when the path is missing. A path is missing when it doesn't resolve or holds `undefined`; `null` is a value.
- Later, a path that disappears prints `[{ "op": "remove", "path": "" }]` and one that appears prints an `add` at `""`. A change that leaves the watched value equal prints nothing.
- Objects are compared by key (`add`, `remove`, `replace`). Arrays are compared index by index: changed items are replaced whole, extra old items are removed from the highest index down, and new items are added at the end. A change of type is a `replace`.
- `watch` samples state. The daemon sends at most 10 state frames per second and coalesces the revisions in between, so intermediate values can be skipped; use `events --follow` when every recorded event matters. Revisions restart after `reset` and `reload`, so `rev` can go backwards.
- It opens the stream before its first read and reads only after the daemon's first `state` frame, so no change after it starts is missed. Reads never overlap, and any frame that arrives during a read causes one more read after it.
- SIGINT ends it with exit 0. An `error` frame, such as `TARGET_DISCONNECTED` when a connected app goes away, or a read that fails, prints `{ "error": ... }` as the last line and exits with that error's code. `watch` doesn't reconnect.

```sh
ironbird watch --path todos
{"rev":3,"patch":[{"op":"add","path":"","value":[{"title":"milk","done":false}]}]}
{"rev":4,"patch":[{"op":"replace","path":"/0","value":{"title":"milk","done":true}}]}
{"rev":5,"patch":[{"op":"add","path":"/1","value":{"title":"eggs","done":false}}]}
```
````

- [ ] **Step 11: Write the changeset**

Create `.changeset/m5-watch.md`:

```md
---
"@ironbird/cli": patch
---
New command `ironbird watch [--path <path>]`. It prints `{ rev, patch }` JSON lines, where `patch` is an RFC 6902 JSON Patch from the last printed value to the new one, with pointers relative to `--path`. The first line is an `add` at `""` with the current value, or `[]` when the path is missing; a path that later disappears or appears prints a `remove` or `add` at `""`. It opens the stream before its first read and waits for the daemon's initial `state` frame, keeps one read in flight, and reads again after any frame that arrived during a read, so it misses no change, including after a `reset`. State is sampled at up to 10 frames per second. SIGINT exits 0; an `error` frame or a failed read prints `{ error }` and exits with that error's code.
```

- [ ] **Step 12: Commit**

```bash
git add packages/cli/src/watch/watch.ts packages/cli/src/watch/watch.test.ts packages/cli/src/watch/watch.integration.test.ts packages/cli/src/cli/output.ts packages/cli/src/cli/program.ts packages/cli/src/cli/program.test.ts packages/cli/test/cli.integration.test.ts docs/cli.md .changeset/m5-watch.md
git commit -m "Add ironbird watch"
```

---

## Final verification

Not a task; the last implementer or the controller runs it before the branch review.

- [ ] Run `pnpm build && pnpm lint && pnpm typecheck && pnpm test`. Expected: every package builds and verifies, lint and typecheck report nothing, every `unit` and `serial` test passes.
- [ ] Run `pnpm test` again under Node 22 (`nvm use 22` or equivalent), as CI does.
- [ ] Run `git grep -n "(P1)" docs/protocol.md docs/cli.md`. Expected: no `snapshotSave`, `snapshotLoad`, `snapshot`, or `watch` line (`doctor (P1)` is plan 3's to change).
- [ ] Run `git grep -n "INVALID_SNAPSHOT" docs/protocol.md docs/cli.md docs/api.md`. Expected: the §6 row and §7 paragraph, the exit-code row and snapshot section, and the createTarget paragraph and Other exports row.
- [ ] Run `git status --short`. Expected: nothing under `.superpowers/` staged or committed.

This plan moves no roadmap exit criterion directly; it delivers R15 and R17, two of M5's scope items (spec §1), measured by the §11 "Snapshots" and "Watch" tests above.

---

## Spec ambiguities and decisions

| # | Spec or contract says | This plan does | Why |
|---|---|---|---|
| 1 | The contract sketches `serializeSnapshot(value): { ok: true, value } \| { ok: false, path, reason }` "or the exact name the spec gives"; spec §4 says it "returns JSON-safe data or throws `INVALID_SNAPSHOT`" | Follows the spec: returns the data or throws | The spec is authoritative (contract header); the name is unchanged, and plan 1 consumes only the error code |
| 2 | §5 originally said a read is repeated only when a frame seen during it carries a `rev` different from the one the read returned | Reads again after **any** frame seen during a read, and reads on every frame that arrives while idle. Spec §5 was updated to this rule after the codex plan review (finding 5) | Revisions restart on `reset`/`reload` and coalesce at 10 frames per second, so a reset plus *n* quick dispatches can land on the revision just read with another state (common with `scenario run`, which resets). Re-reading costs one `getState` whose empty patch prints nothing, and it can never miss a change. Every line still carries the revision its read returned |
| 3 | §5 names `reset` moving the revision backwards but no notification for it | The headless target calls its state listeners with the new revision after a successful `reset` or `reload` (Task 2), documented in protocol.md §2.2 and §4.1 | Without it `watch` keeps showing the old session until the next change. Additive: one more `state` frame |
| 4 | §4 converts `restore` errors only | `createTarget` also converts a plain error from `persist` into `INVALID_SNAPSHOT` `{ path: '', reason }` | Otherwise the daemon reports it as `INTERNAL`, "a bug in ironbird", for an app-side failure (Review Focus 2) |
| 5 | §4: "any other error" a `restore` throws becomes `INVALID_SNAPSHOT` | Any `IronbirdError` passes through unchanged; everything else is converted | The adapters throw `INVALID_SNAPSHOT` with a real path; rewrapping would lose it. An app that throws another coded error meant it |
| 6 | §4 doesn't say how to treat a malformed `app` or a missing `snapshot`, or where the check lives | `parseSnapshotLoadParams` in core, shared by the headless target and the bridge: non-string `app` (including `null`) or missing `snapshot` → `INVALID_PAYLOAD` `{ name: 'snapshotLoad', issues }`; order is capability (`UNSUPPORTED`), `app` type, `APP_MISMATCH`, `snapshot` presence, then `restore` | Rule 4 (validate where applied) in one place for both targets; `UNSUPPORTED` first matches the remote target, which refuses before forwarding |
| 7 | §4 doesn't give `snapshot save`'s output or file errors | `save` prints `{ target, app, rev, file }` (absolute `file`); unreadable or unwritable files are usage errors (exit 2, message on stderr), as `verify-bundle` treats a missing path | Agents need to know where the file went; a bad path is the caller's mistake, not the target's |
| 8 | §4: `app` comes "from the target's `status` entry" | `save` calls `snapshotSave` first, then `status`, and looks the entry up by the envelope's target id; if the target left in between, it fails `TARGET_DISCONNECTED` `{ target, op: 'snapshotSave' }` and writes nothing | Without `--target` the CLI doesn't know which target the daemon picks until the save answers |
| 9 | D5: the initial frame carries "the target's current revision" | `target.info().rev`: the live session's revision for headless; for a remote target the last revision the bridge notified, 0 before its first notification | The daemon has no other source for a remote revision without a round trip; `watch` never compares against the barrier's revision, so a stale one is harmless |
| 10 | §5 doesn't say what `watch` does when a read fails, or when the stream ends with no error frame | A failed read prints `{ error }` and exits with its code, like an error frame; a stream the daemon ends without an error frame lets the read in flight print and exits 0, as `events --follow` does; a stream that fails to open rejects and the CLI prints the error | Consistency with `events --follow`, and the last line is always final (Review Focus 5) |
| 11 | §5 doesn't say which target `watch` follows without `--target` | It pins the target id from the envelope of its first call (`events` with `limit: 0`) for the stream and every read | The stream and the reads must follow the same target even if another app connects meanwhile |
| 12 | §4 doesn't fix the path format in `INVALID_SNAPSHOT` details | Dot path (`a.b.0`), `''` at the root, as everywhere else in the protocol; the message says `<root>` | Protocol §1 convention; JSON Pointer stays specific to `watch` patches |
| 13 | §4's rejection list doesn't mention `-0`, symbol-keyed, non-index array, or non-enumerable properties, null-prototype objects, Array subclasses, or unreadable proxies | `-0` is accepted (JSON writes `0`); an enumerable non-index property on an array is rejected as `array-property` at its path (`items.extra`), and an enumerable symbol-keyed property on an array or plain object as `symbol-key` (`meta.Symbol(tag)`), each after the keys JSON keeps; non-enumerable properties are ignored, as JSON does; null-prototype objects are plain; an Array subclass is rejected by its class name; a revoked proxy is `unreadable` | §4 requires the first lossy path to be rejected, and JSON drops enumerable array extras and symbol keys silently, so accepting them would save a snapshot that loads back without that data (codex plan review, finding 3). Non-enumerable keys aren't data. An Array subclass is "any other non-plain object" |
| 14 | Spec doesn't place the new code in `ERROR_CODES` | After `INVALID_SCENARIO`, making 22 codes | Groups the `INVALID_*` codes; order has no wire meaning |
| 15 | D10 gives every package a `minor` changeset for 0.1.0 | This plan's changesets are `patch` | Plan 5 owns the 0.1.0 `minor` changesets (contract); a `minor` there supersedes these in the Version Packages PR |
| 16 | Spec doesn't say what `watch` does against a daemon that predates the barrier | It waits for the first state change before its first line; no timeout | Daemon and CLI ship from one package; plan 3's `doctor` `versions` check catches skew |
| 17 | §11 asks for CLI integration tests "against a daemon" | Boundary tests run `runWatch` in process against a real `startDaemon` with port 0 (unit project); one test spawns the built binary and ends it with a real SIGINT (serial project) | In-process hooks are the only way to place a change exactly at each boundary; the binary test proves the signal path and exit code |

## Self-Review

**Spec coverage.** D4 (snapshots P0 on both targets, served from `persist`/`restore`, strict serializer before replying, `snapshotLoad` `app?` checked by the applying target): Tasks 1, 2, 3. D5 (watch over `/v1/stream`, stream first, barrier, one read at a time, `{ rev, patch }` against the last printed value, the one additive frame, in-house differ): Tasks 4, 6, 7. D12 (`INVALID_SNAPSHOT` `{ path, reason }`, `APP_MISMATCH` extended, no version bump): Task 1 (code, protocol rows), Tasks 2 and 3 (raised). §4 strict serializer (every listed kind, `undefined` properties omitted, `reason` kind): Task 1; restore errors from `createTarget` and the api.md validation duty: Task 1; `snapshotLoad` params, `APP_MISMATCH` before anything else, missing `app` skips the check, mutating queue: Tasks 1, 2, 3; CLI `save`/`load`, file validation before mutation, `INVALID_PAYLOAD` `{ name: 'snapshotLoad', issues }`, `target` informational, exit-code table: Task 5. §5 Startup (events `limit: 0`, `since`, barrier, first read labelled with its rev): Tasks 4, 7; Steady state (one read in flight, re-read, rev from the read, patch against the last printed value, empty patch prints nothing, sampling documented): Task 7 (with decision 2); Values and patches (relative pointers, root `""`, RFC 6901 escaping, presence by `value` property, first line rules, appear/disappear, object and array rules, type change): Tasks 6, 7; Ending (SIGINT exit 0, error frame printed with its exit code): Task 7. §7 (protocol.md: P1 dropped, `app?`, strict save, `INVALID_SNAPSHOT` row, `APP_MISMATCH`, §2.2 frame; api.md: `serializeSnapshot` and the `restore` duty; cli.md: `snapshot`, `watch`; changesets): Tasks 1, 2, 4, 5, 7. The adapter signatures in api.md (D1, D2, `withIronbirdRestore`, `actor()`) are plan 1's, and `doctor` in cli.md is plan 3's, per the contract. §11 rows: serializer kinds and paths and omitted `undefined` (Task 1); headless and bridge handler tests for `INVALID_SNAPSHOT` on save, `APP_MISMATCH` with `app`, no check without it, `UNSUPPORTED` without the capabilities (Tasks 2, 3); CLI round trip and malformed file with state unchanged (Task 5); differ property test with `~` and `/` keys, array shifts, disappear/reappear (Task 6); daemon-backed boundaries (before the stream, between barrier and first read, during the first read, during a slow later read), backwards `reset`, `--path`, SIGINT, error frame (Task 7); the initial frame after the backlog with the current revision (Task 4).

**Placeholder scan.** Every code step has the complete file or an exact replacement with its anchor text; every run step names the command and the expected result. The doc steps carry their full text. No step says "similar to", "add handling", or "TBD".

**Type consistency.** `serializeSnapshot(value: unknown): unknown` and `parseSnapshotLoadParams(params, appId): { snapshot: unknown }` are defined in Task 1 and called with those signatures in Tasks 2 and 3. `notesDefinition` and its commands (`note.add`, `note.clear`, `state.junk`) are defined in Task 2 and used unchanged in Task 5. `SnapshotFile`, `parseSnapshotFile(text, file)`, and `formatSnapshotFile(record)` are defined and used in Task 5. `JsonPatchOp`, `Presence`, `escapePointerToken`, `diff(prev, next)`, and `patchBetween(prev, next)` are defined in Task 6; `runWatch` in Task 7 imports `patchBetween` and `Presence`. `asErrorShape` moves to output.ts in Task 7 Step 3 and both program.ts and watch.ts import it from there. The `harness` `signal` option is added in Task 5 Step 5 and used by Task 7's program tests. `WatchOptions` fields (`client`, `target`, `path`, `signal`, `write`) match every call in watch.test.ts, watch.integration.test.ts, and program.ts.

**Review Focus.** Each line has its test in the owning task: reset while watching and the equal-revision coincidence (Task 2 notification test; Task 7 "reads again after a frame during a read even when it carries the revision the read returned" and "follows a reset that moves the revision backwards"); plain errors from `persist`/`restore` (Task 1 `createTarget` test; Task 2 refusal test with state and revision unchanged); bad file paths (Task 5 "exits 2 when the file cannot be read or written"); `__proto__`, `~`, `/` keys (Task 1 serializer test, Task 5 "keeps a __proto__ key in the snapshot as data", Task 6 property test and escaping test); SIGINT or an error mid-read (Task 7 "ends with 0 on abort and prints nothing for a read still in flight" and "ends on an error frame with its exit code, after nothing else").
