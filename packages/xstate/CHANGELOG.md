# @ironbird/xstate

## 0.1.0

### Minor Changes

- e929a6b: 0.1.0: the first published version. `fromActor` adapts an XState v5 actor to an ironbird target, with snapshots through the actor's persisted snapshot.

### Patch Changes

- e929a6b: New package. `@ironbird/xstate` turns a started XState 5 root actor into a core `Target` with `fromActor(actor, { commands, toEvent?, select?, restore? })`, plus `actor()`, which returns the live actor. The registry validates commands before `toEvent` sees them. The default event is `{ ...payload, type: name }`, and a payload that isn't an object is sent as `{ type: name, payload }`. The default state is `{ value, context }`, and the revision moves only when the actor's snapshot changes. A dispatch to an actor that isn't active, or one that puts it in error, fails `DISPATCH_FAILED`; actor errors never escape as uncaught exceptions through the adapter. `persist` returns `getPersistedSnapshot()`. `restore` exists only with `restore: { snapshotSchema, actorOptions? }`. It validates the snapshot, then starts a replacement with `createActor(logic, { ...actorOptions, snapshot })` before touching the live actor. A schema failure, or a replacement that fails to start, throws `INVALID_SNAPSHOT` and keeps the old actor live. On success the adapter subscribes to the replacement, stops the old actor, and notifies once. Invoked actors restart. Delayed transitions that were pending when the snapshot was saved don't fire. ESM and CommonJS builds; `@ironbird/core`, `xstate` ^5, and `zod` ^4.2 are peers.
- Updated dependencies [e929a6b]
- Updated dependencies [c096b90]
- Updated dependencies [e929a6b]
- Updated dependencies [e929a6b]
- Updated dependencies [e929a6b]
  - @ironbird/core@0.1.0
