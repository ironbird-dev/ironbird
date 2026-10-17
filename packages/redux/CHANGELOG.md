# @ironbird/redux

## 0.1.0

### Minor Changes

- e929a6b: 0.1.0: the first published version. `fromStore` adapts a Redux store to an ironbird target, and `withIronbirdRestore` lets snapshots restore its root state.

### Patch Changes

- e929a6b: New package. `@ironbird/redux` turns a Redux 5 store into a core `Target` with `fromStore(store, { commands, toAction?, select?, restore? })`. The registry validates commands before `toAction` sees them. The default `toAction` is `{ type: name, payload }`, the Redux Toolkit action shape. `select` shapes what `getState`, `waitFor`, and `watch` see, and the revision moves only when the root state changes. `persist` saves the root state. `restore` exists only when the app passes `restore: { schema }` and wraps its root reducer with the exported `withIronbirdRestore`. The snapshot is parsed with the schema first. A schema failure, or a store that ignores the restore because its reducer isn't wrapped, fails `INVALID_SNAPSHOT` with `{ path, reason }` and leaves the state as it was. A command mapped to the internal restore action fails `DISPATCH_FAILED`. ESM and CommonJS builds; `@ironbird/core`, `redux` ^5, and `zod` ^4.2 are peers.
- Updated dependencies [e929a6b]
- Updated dependencies [c096b90]
- Updated dependencies [e929a6b]
- Updated dependencies [e929a6b]
- Updated dependencies [e929a6b]
  - @ironbird/core@0.1.0
