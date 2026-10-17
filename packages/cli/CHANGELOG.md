# @ironbird/cli

## 0.1.0

### Minor Changes

- e929a6b: 0.1.0: the daemon and CLI as docs/cli.md describes for 0.1, including scenarios, screenshots, `snapshot`, `watch`, `doctor`, `verify-bundle`, and the MCP server with its agent skill. Node 22 or later.

### Patch Changes

- e929a6b: `ironbird watch` and `ironbird events --follow` no longer exit 0 when the daemon closes the stream without an `error` frame, as when it shuts down or the connection drops. `watch` lets a read in flight print first. Both then print `{ "error": { "code": "TARGET_DISCONNECTED", ... } }` with `{ target, op: "stream" }` and exit 1. Every other failure, such as a backlog or cursor read or a stream that fails to open, now also ends with a `{ "error": ... }` JSON line, even in a TTY, rather than human-readable text. SIGINT or SIGTERM still ends them with exit 0, and `events --follow` now honours it while the backlog is still being read.
- c096b90: New subpath `@ironbird/cli/runner`, published in ESM and CommonJS with type declarations: `createHeadlessTarget`, `loadScenarioFiles`, `parseScenario`, `runScenario`, and the `HeadlessTarget`, `HeadlessTargetOptions`, `Scenario`, `ScenarioStep`, `RunScenarioOptions`, and `DaemonClient` types. The main entry stays ESM only; the subpath lets CommonJS callers such as Jest reuse the headless target and the scenario engine, and it is how `@ironbird/testing` reaches the CLI.
- e929a6b: New command `ironbird doctor`, which needs no daemon. It checks the Node version, `ironbird.config.ts`, that the headless entry loads (printing the import chain when it imports `react-native`), that the daemon and bridge ports are free or held by an ironbird daemon, that `.ironbird/` is gitignored, and that every installed ironbird package and the running CLI share one version; `xcrun simctl` and `adb`, with their devices, are reported for information. It prints `{ checks: [{ id, ok, required, detail, fix? }] }` and exits 0 when every required check passes and 1 otherwise. From this release on, every ironbird package is released at the same version.
- e929a6b: The headless target serves `snapshotSave` and `snapshotLoad` when the app's `Target` implements `persist` and `restore`. A save is strict (`INVALID_SNAPSHOT` naming the first value that can't be saved losslessly); a load takes an optional `app`, refused with `APP_MISMATCH` when it isn't this target's app id, and runs in the mutating queue. After a successful `reset` or `reload`, the headless target notifies state listeners, so a stream sees a `state` frame with the new session's revision.
- e929a6b: New commands `ironbird snapshot save <file>` and `ironbird snapshot load <file>`. `save` writes `{ app, target, rev, snapshot }`, taking `app` from the target's status entry, and prints `{ target, app, rev, file }`. `load` validates the file before sending anything (`INVALID_PAYLOAD` with `{ name: 'snapshotLoad', issues }` for a file that isn't JSON or has the wrong shape), then sends `snapshotLoad` with the file's `snapshot` and `app`, so the target refuses another app's snapshot with `APP_MISMATCH`. A file that can't be read or written exits 2. `INVALID_SNAPSHOT` exits 1.
- e929a6b: `/v1/stream` sends a `state` frame with the target's current revision as soon as the stream's state subscription is live, after the event backlog. A client that reads state after that frame misses no later change; `watch` starts this way. The frame is additive, so the protocol version stays 1.
- e929a6b: New command `ironbird watch [--path <path>]`. It prints `{ rev, patch }` JSON lines, where `patch` is an RFC 6902 JSON Patch from the last printed value to the new one, with pointers relative to `--path`. The first line is an `add` at `""` with the current value, or `[]` when the path is missing; a path that later disappears or appears prints a `remove` or `add` at `""`. It opens the stream before its first read and waits for the daemon's initial `state` frame, keeps one read in flight, and reads again after any frame that arrived during a read, so it misses no change, including after a `reset`. State is sampled at up to 10 frames per second. SIGINT exits 0; an `error` frame or a failed read prints `{ error }` and exits with that error's code. `DaemonClient`'s `call` and `rpc` take an optional `CallOptions` `{ signal }` (exported from `@ironbird/cli/runner`); aborting it cancels the request, which rejects with the signal's reason, so `watch` exits on SIGINT even while the daemon or a target is slow to answer.
- Updated dependencies [e929a6b]
- Updated dependencies [c096b90]
- Updated dependencies [e929a6b]
- Updated dependencies [e929a6b]
- Updated dependencies [e929a6b]
  - @ironbird/core@0.1.0

## 0.0.4

### Patch Changes

- a77bd89: Agent interface. `ironbird mcp` is now a stdio MCP server built on `@modelcontextprotocol/server` 2.x (a new dependency, with `@modelcontextprotocol/client` as a dev dependency for the integration test) with sixteen tools, one per daemon operation plus `ironbird_run_scenario`, which runs the scenario runner in process with the same validation, per-file reset, `bail`, and artifacts as `scenario run`. Inputs are Zod 4 schemas; each result is one text block holding the JSON the CLI prints, `ironbird_step` and `ironbird_screenshot` add the PNG as image content, and failures are `isError` results holding the CLI's error JSON. When `ironbird_step` fails with `SCREENSHOT_FAILED` and `details.applied: true`, the command was already applied and only the capture failed, so the tool adds a note not to retry the step. The daemon now sets that optional `details.applied: true` on a step's post-dispatch `SCREENSHOT_FAILED` (documented in protocol.md). The server finds the daemon on every tool call, so it can start first and survives a daemon restart, and writes nothing but MCP messages to stdout. The package now ships an app-agnostic Agent Skills skill in `skills/ironbird/` that teaches the reproduce, pin down, fix, device check, and report-with-evidence loop, and `ironbird agent setup [--skills-dir <dir>]` installs it (default `.claude/skills`) and adds only the `mcpServers.ironbird` entry to `.mcp.json`, failing with `INVALID_CONFIG` and writing nothing when `.mcp.json` is not a JSON object. `@ironbird/cli` exports `createMcpServer` and `agentSetup` with their option and result types.
- a77bd89: New operation and command: `ironbird reload [--timeout <duration>]` loads the app's current code from a fresh start and prints `{ target, rev }`. The headless target re-bundles its entry (`createHeadlessTarget` takes `loadDefinition`, which `serve` passes). A failed reload leaves `HEADLESS_LOAD_FAILED` on every later operation, `reset` included, until a reload succeeds, and `reset` and `reload` run as one serialized lifecycle transition. A connected app reloads through its bridge's `reload` option or `DevSettings.reload()`, and the daemon waits up to `timeoutMs` (default 60 s) for it to reconnect on the same id. It fails with `AMBIGUOUS_TARGET` when another build of the same app is connected on the same platform. `MUTATING_OPS` includes `reload`, `createTargetRegistry().claim` takes a preferred id, and `startBridgeServer` takes a `replacementFor` hook that returns a `ReplacementTicket`. A headless reload's load and boot share one `boot.timeoutMs` deadline, and the daemon bounds a headless `reset` or `reload` request at no less than that plus 5 s (a target reports its own bound as the optional `DaemonTarget.lifecycleTimeoutMs`). A screenshot whose output directory can't be created fails with `SCREENSHOT_FAILED`, and with `applied: true` from `step`.
- a77bd89: `scenario run` and `ironbird_run_scenario` no longer report a scenario path they may not read as missing. A permission or sandbox failure (`EACCES`, `EPERM`) is still `INVALID_SCENARIO`, now with the message `Cannot read <file>: <system error>`; only `ENOENT` and `ENOTDIR` give `No such file or directory`.
- Updated dependencies [a77bd89]
  - @ironbird/core@0.0.4

## 0.0.3

### Patch Changes

- 431210f: The headless target runs `fakeControl` as a settled step and answers `fakeCalls` with `{ calls, nextSeq, truncated }`; an unknown fake fails with `UNKNOWN_FAKE` and `{ fake, available, suggestions }`, and an app that wires no fakes answers `UNSUPPORTED`. New command: `ironbird fake <fake> <control> [payload]` runs a control and prints a step result, and `ironbird fake <fake> --calls [--since <seq>]` prints the fake's recorded calls.
- 431210f: The scenario runner. `ironbird scenario run <path...> [--bail]` parses YAML scenario files with the `yaml` package (YAML 1.2, so `on` and `yes` stay strings, and errors carry line numbers), validates every file before anything runs, and runs each step as one daemon operation against the target pinned by the run's first `describe`: `send`, `fake`, `clock`, `wait`, `expect`, `screenshot`, and `reset`, with `optional` skips decided from `describe`, `repeat`, and `settle` on `fake` and `clock` steps as on `send`. A `send`, `fake`, or `clock` step that ends neither idle nor quiescent fails the scenario. Every run writes `runs/<stamp>-<slug>/` under the daemon's artifacts directory with `result.json`, a copy of the scenario, `events.jsonl`, `state.json`, `calls/<fake>.json`, and screenshots; `serve` now records `artifactsPath` in `daemon.json` so client commands find that directory without loading the config, and `resolveDaemon` returns it as `artifactsDir`. `@ironbird/cli` exports `parseScenario`, `loadScenarioFiles`, and `runScenario`. In core, `INVALID_SCENARIO` joins the error codes (exit 2 in the CLI), and `ScenarioResult` gains `file`, `stepsRun`, `failedStep.repetition`, `failedStep.expected`, and `artifactErrors`, with `artifacts` nullable; the never-implemented daemon-side `scenarioRun` operation leaves the protocol docs. `scenario run` resets a headless target before each file, so files don't share app state; a remote app, which has no `reset`, runs against its current state.
- Updated dependencies [431210f]
- Updated dependencies [431210f]
  - @ironbird/core@0.0.3

## 0.0.2

### Patch Changes

- d26e6b1: The in-app bridge. `startBridge` connects a dev build to the daemon over WebSocket, answers `describe`, `dispatch`, `getState`, `waitFor`, `settle`, `events`, `fakeControl`, `fakeCalls`, and snapshots, settles after each dispatch by waiting for tracked effects and two animation frames, reconnects with backoff, and is inert outside dev builds. Core now exports `parseCondition`, `conditionHolds`, and `deepEqual` (moved from `@ironbird/cli`, which re-exports them), and a throwing subscriber in `EventRecorder`, `Tracker`, or `Target` no longer prevents later subscribers from running. `ironbird verify-bundle <path...>` scans release output for the bridge marker without a daemon and exits 1 listing the files that contain it.
- d26e6b1: Remote mode in the daemon. `ironbird serve` accepts bridge connections on `bridge.port` (default 4568) on the same host as the HTTP API, with the handshake, target ids, heartbeat, and disconnect semantics from docs/protocol.md §3; connected apps appear in `status` and take every operation the headless target takes except the clock and `reset`. New commands: `screenshot` and `step` capture through `xcrun simctl` and `adb`. `serve` runs `adb reverse` for connected Android devices and records `bridgeUrl` in `daemon.json`. The SSE stream carries `target` frames and ends with `TARGET_DISCONNECTED` when its target disconnects. Config gains `boot.timeoutMs`. `@ironbird/cli` now exports `DaemonTarget`, `createOperationQueue`, and the remote-target, bridge-server, device, and screenshot modules.
- Updated dependencies [d26e6b1]
  - @ironbird/core@0.0.2

## 0.0.1

### Patch Changes

- 78490e8: `@ironbird/core` no longer loads zod when it is imported. The command registry produces JSON Schema through each schema's own `toJSONSchema` method, so zod is a type-only import in core, and the core build now fails if any entry imports zod at load time. The zod peer dependency floor moves from `^4.0.0` to `^4.2.0`, the first release with that method; `@ironbird/cli` and the checkout example follow. CLI client commands such as `state`, `status`, `send`, and `wait` start faster because importing core no longer evaluates zod.
- 7cc72e8: First daemon and CLI: serve, status, commands, fakes, send, state, wait, settle, events, clock advance, clock now, reset. Headless entries load through esbuild with react-native import chains reported.
- 3408086: Pre-merge fixes for the M0 headless loop.
  
  - `EventRecorder` gains `lastSeq()`, an O(1) read of the latest sequence number.
  - The headless target bounds its factory with `bootTimeoutMs` (default 30 s) and reports every boot failure as `HEADLESS_LOAD_FAILED`, so a hanging or throwing factory can no longer wedge `run`, `reset`, or `dispose`. A read-only `settle` now fails promptly when a reset or dispose abandons it.
  - The daemon bounds each target operation with `requestTimeoutMs` (default 30 s), refuses requests that carry an `Origin` header or a foreign `Host` with 403, and answers unknown routes with `UNSUPPORTED`.
  - A config file that fails to load reports `INVALID_CONFIG` with `{ file, issues }`, and an unknown top-level key in `ironbird.config.ts` is now an error rather than being ignored.
  - A `serve` that fails to bind no longer deletes a running daemon's `.ironbird/daemon.json`.
  - `@ironbird/cli` no longer re-exports the unused `MUTATING_OPS`.
  - `createHeadlessTarget` accepts `entryPath`, reported as `details.entry` on boot failures; the daemon's request bound follows the operation's own timeout.
  - The published packages declare the MIT license and their repository directory, and each ships a `LICENSE` file.
- Updated dependencies [6377555]
- Updated dependencies [78490e8]
- Updated dependencies [3408086]
  - @ironbird/core@0.0.1
