# @ironbird/react-native

## 0.1.0

### Minor Changes

- e929a6b: 0.1.0: the in-app bridge for development builds, with settle detection, reconnection, reload, and snapshots, as docs/api.md describes for 0.1. It stays inert outside development builds and out of release bundles, which `ironbird verify-bundle` checks.

### Patch Changes

- e929a6b: `snapshotSave` is strict: a persisted state holding a `Map`, a `Date`, a class instance, a cycle, or another value that can't be saved losslessly fails with `INVALID_SNAPSHOT` naming its path, instead of saving a placeholder. `snapshotLoad` takes an optional `app` and refuses another app's snapshot with `APP_MISMATCH` before calling `restore`; a non-string `app` or a missing `snapshot` is `INVALID_PAYLOAD`.
- Updated dependencies [e929a6b]
- Updated dependencies [c096b90]
- Updated dependencies [e929a6b]
- Updated dependencies [e929a6b]
- Updated dependencies [e929a6b]
  - @ironbird/core@0.1.0

## 0.0.3

### Patch Changes

- a77bd89: `startBridge` takes an optional `reload` option. The bridge declares the `reload` capability when that option or `DevSettings.reload` exists, and answers `reload` by replying and then calling the option (or `DevSettings.reload()`) on the next tick, so `ironbird reload` can restart a dev build from the bundler. Expo Go apps pass `reloadAppAsync` from `expo`, because `DevSettings.reload` leaves Expo Go without its native modules.
- Updated dependencies [a77bd89]
  - @ironbird/core@0.0.4

## 0.0.2

### Patch Changes

- 431210f: `fakeCalls` takes `since` and `limit` and returns `{ calls, nextSeq, truncated }`, a cursor like `events`. `UNKNOWN_FAKE` details are `{ fake, available, suggestions }`, as the protocol's error table says.
- Updated dependencies [431210f]
- Updated dependencies [431210f]
  - @ironbird/core@0.0.3

## 0.0.1

### Patch Changes

- d26e6b1: The in-app bridge. `startBridge` connects a dev build to the daemon over WebSocket, answers `describe`, `dispatch`, `getState`, `waitFor`, `settle`, `events`, `fakeControl`, `fakeCalls`, and snapshots, settles after each dispatch by waiting for tracked effects and two animation frames, reconnects with backoff, and is inert outside dev builds. Core now exports `parseCondition`, `conditionHolds`, and `deepEqual` (moved from `@ironbird/cli`, which re-exports them), and a throwing subscriber in `EventRecorder`, `Tracker`, or `Target` no longer prevents later subscribers from running. `ironbird verify-bundle <path...>` scans release output for the bridge marker without a daemon and exits 1 listing the files that contain it.
- Updated dependencies [d26e6b1]
  - @ironbird/core@0.0.2
