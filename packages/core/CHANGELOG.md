# @ironbird/core

## 0.1.0

### Minor Changes

- e929a6b: 0.1.0: the first release meant for apps outside this repository. The command registry, targets, fakes, clocks, tracker, recorder, headless definition, and snapshot serialization are the API that docs/api.md describes for 0.1. `zod` 4.2 or later stays the only peer dependency; apps on Zod 3 can follow docs/migrating-from-zod-3.md.

### Patch Changes

- e929a6b: `serializeSnapshot` refuses `-0` with `INVALID_SNAPSHOT` and `{ path, reason: '-0' }`. JSON writes `-0` as `0`, so a saved `-0` loaded back as a different number; `snapshotSave` now fails instead of changing state on the round trip.
- c096b90: New error code `INVARIANT_FAILED`, raised by `@ironbird/testing`'s `modelTest` when a generated sequence of steps violates an invariant, with details `{ invariant, message, seed, path, runs, steps, scenarioFile, traceReplayable }`, where `traceReplayable` is `false` when a rejected step changed state, so the trace may not reproduce the violation. It is raised in the test process and never crosses the wire, so `PROTOCOL_VERSION` stays 1.
- e929a6b: Snapshots. New error code `INVALID_SNAPSHOT` with details `{ path, reason }`. New `serializeSnapshot(value)`, which returns JSON-safe data or throws `INVALID_SNAPSHOT` naming the first value it can't save losslessly (functions, symbols, `BigInt`, `NaN`, `Infinity`, `Map`, `Set`, `Date`, other non-plain objects, cycles, `undefined` or holes in arrays, array properties other than indices, symbol-keyed properties, throwing getters) instead of substituting a placeholder, and `parseSnapshotLoadParams(params, appId)`, which checks `snapshotLoad`'s optional `app` (`APP_MISMATCH` on another app's id) and its `snapshot` before anything is applied. A plain error thrown by a `Target`'s `persist` or `restore` now surfaces as `INVALID_SNAPSHOT` with `{ path: '', reason }` instead of an unclassified error; an `IronbirdError` passes through.
- e929a6b: `defineCommands`, and through it a fake's `create`, now checks every schema when it is called and throws `IronbirdError` with code `INVALID_CONFIG` and details `{ name, reason }` for a schema that isn't a Zod 4.2+ schema: one from `zod` 3 or `zod/v3`, one from `zod/mini`, or anything else. Before, such a schema validated payloads, and `describe()` failed with a bare `TypeError` the first time an agent listed the commands. The message points to docs/migrating-from-zod-3.md.

## 0.0.4

### Patch Changes

- a77bd89: `Capability` gains `reload`, declared by targets that can load the app's current code from a fresh start through the new `reload` operation.

## 0.0.3

### Patch Changes

- 431210f: `defineFake` declares a fake port with Zod-validated controls: `create` returns the port and one handler per control, an extra handler fails instance creation with `UNKNOWN_CONTROL`, and control errors name the control as `<fake>.<control>`. Every fake port records the calls the app makes on it (`FakeInstance.calls(since, limit)` returns `{ calls, nextSeq, truncated }`, kept to 10,000 per fake) and carries the fake mark that `tracker.wrap` reads. `FakeCall.outcome` gains `threw`, and `FakeCall` gains `error` for `threw` and `rejected`. New exports: `defineFake`, `FakeContext`, `ControlHandlers`, `FakeDefinition`, `FakeFactory`, `FakeCallsResult`.
- 431210f: The scenario runner. `ironbird scenario run <path...> [--bail]` parses YAML scenario files with the `yaml` package (YAML 1.2, so `on` and `yes` stay strings, and errors carry line numbers), validates every file before anything runs, and runs each step as one daemon operation against the target pinned by the run's first `describe`: `send`, `fake`, `clock`, `wait`, `expect`, `screenshot`, and `reset`, with `optional` skips decided from `describe`, `repeat`, and `settle` on `fake` and `clock` steps as on `send`. A `send`, `fake`, or `clock` step that ends neither idle nor quiescent fails the scenario. Every run writes `runs/<stamp>-<slug>/` under the daemon's artifacts directory with `result.json`, a copy of the scenario, `events.jsonl`, `state.json`, `calls/<fake>.json`, and screenshots; `serve` now records `artifactsPath` in `daemon.json` so client commands find that directory without loading the config, and `resolveDaemon` returns it as `artifactsDir`. `@ironbird/cli` exports `parseScenario`, `loadScenarioFiles`, and `runScenario`. In core, `INVALID_SCENARIO` joins the error codes (exit 2 in the CLI), and `ScenarioResult` gains `file`, `stepsRun`, `failedStep.repetition`, `failedStep.expected`, and `artifactErrors`, with `artifacts` nullable; the never-implemented daemon-side `scenarioRun` operation leaves the protocol docs. `scenario run` resets a headless target before each file, so files don't share app state; a remote app, which has no `reset`, runs against its current state.

## 0.0.2

### Patch Changes

- d26e6b1: The in-app bridge. `startBridge` connects a dev build to the daemon over WebSocket, answers `describe`, `dispatch`, `getState`, `waitFor`, `settle`, `events`, `fakeControl`, `fakeCalls`, and snapshots, settles after each dispatch by waiting for tracked effects and two animation frames, reconnects with backoff, and is inert outside dev builds. Core now exports `parseCondition`, `conditionHolds`, and `deepEqual` (moved from `@ironbird/cli`, which re-exports them), and a throwing subscriber in `EventRecorder`, `Tracker`, or `Target` no longer prevents later subscribers from running. `ironbird verify-bundle <path...>` scans release output for the bridge marker without a daemon and exits 1 listing the files that contain it.

## 0.0.1

### Patch Changes

- 6377555: Initial primitives for the headless loop: command registry, target, manual and real clocks, effect tracker with idle and quiescent settle, bounded event recorder, JSON-safe serialization, and the headless definition.
- 78490e8: `@ironbird/core` no longer loads zod when it is imported. The command registry produces JSON Schema through each schema's own `toJSONSchema` method, so zod is a type-only import in core, and the core build now fails if any entry imports zod at load time. The zod peer dependency floor moves from `^4.0.0` to `^4.2.0`, the first release with that method; `@ironbird/cli` and the checkout example follow. CLI client commands such as `state`, `status`, `send`, and `wait` start faster because importing core no longer evaluates zod.
- 3408086: Pre-merge fixes for the M0 headless loop.
  
  - `EventRecorder` gains `lastSeq()`, an O(1) read of the latest sequence number.
  - The headless target bounds its factory with `bootTimeoutMs` (default 30 s) and reports every boot failure as `HEADLESS_LOAD_FAILED`, so a hanging or throwing factory can no longer wedge `run`, `reset`, or `dispose`. A read-only `settle` now fails promptly when a reset or dispose abandons it.
  - The daemon bounds each target operation with `requestTimeoutMs` (default 30 s), refuses requests that carry an `Origin` header or a foreign `Host` with 403, and answers unknown routes with `UNSUPPORTED`.
  - A config file that fails to load reports `INVALID_CONFIG` with `{ file, issues }`, and an unknown top-level key in `ironbird.config.ts` is now an error rather than being ignored.
  - A `serve` that fails to bind no longer deletes a running daemon's `.ironbird/daemon.json`.
  - `@ironbird/cli` no longer re-exports the unused `MUTATING_OPS`.
  - `createHeadlessTarget` accepts `entryPath`, reported as `details.entry` on boot failures; the daemon's request bound follows the operation's own timeout.
  - The published packages declare the MIT license and their repository directory, and each ships a `LICENSE` file.
