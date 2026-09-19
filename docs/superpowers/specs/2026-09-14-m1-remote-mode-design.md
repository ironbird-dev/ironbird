# M1: Remote mode, design

| | |
|---|---|
| Status | Approved 2026-09-14 |
| Milestone | M1 in [roadmap.md](../../roadmap.md) |
| Builds on | [architecture.md](../../architecture.md) §6.5, §7.2, §7.3, §8, §9 · [protocol.md](../../protocol.md) §3, §4 · [api.md](../../api.md) `@ironbird/react-native` · [cli.md](../../cli.md) `screenshot`, `step`, `verify-bundle` |

This spec records only what the existing docs leave open for M1. Everything they already fix, such as the handshake, target ids, the settle algorithm, and the `step` result shape, is referenced rather than restated. Where this spec and an older doc disagree, this spec wins and the doc is updated in plan 2 or plan 3.

## 1. Scope

M1 delivers remote mode: a dev build on a simulator or emulator drives the same operations the headless target accepts, plus `screenshot` and `step`, and `verify-bundle` proves the bridge is absent from release output. Two roadmap items are already in place and need no work: the tracker reports real-clock timers due within its threshold, and the config carries the `devices.ios` and `devices.android` mapping that Q4 falls back to.

Out of scope for M1: physical devices on a LAN (the token path is implemented and tested in Node, not on hardware), `scenario run`, fake controls beyond what M0 exposes, and any native code.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The example app is an Expo SDK 57 app inside the existing `examples/checkout` package, run in Expo Go | Matches the documented one-package layout where the headless and device entries sit side by side; no native build; running in Expo Go verifies Q9 by construction |
| D2 | Motion for the Q5 comparison uses core React Native only: `Animated` on the native driver, `LayoutAnimation`, and an image swap, toggled at runtime by a `ui.setMotion` command | Covers all three blind spots Q5 names without a Babel plugin or a dependency; both arms run against one build in one session |
| D3 | The daemon models every connected app through a `DaemonTarget` interface generalized from the headless target's surface; a `RemoteTarget` implements it over one WebSocket | Keeps the M0 queue, epoch, and request-bound semantics identical across targets and keeps the app-side code small. Alternatives rejected: wrapping the socket as a core `Target` (settle would move to the wrong side and `waitFor` would poll across the socket) and a thin relay (ordering guarantees would live in every app build) |
| D4 | The daemon's WebSocket server is the `ws` package | Node ships a WebSocket client but no server |
| D5 | The device build wires the M0 hand-written fakes on the real clock | Realistic asynchronous effects on the simulator with no backend, and `fakeControl` works remotely because the fakes are in the build |
| D6 | No navigation library in the example | The checkout flow is one screen with three sections; navigation adapters are P2 |
| D7 | The harness compares screenshots with `pngjs`, a dev dependency of the example | A pixel comparison needs a PNG decoder; nothing else in the repo does |
| D8 | The 300-step harness is a script, not a test | Its output is a measurement to record in the evals doc, not a pass or fail |

## 3. Work breakdown

Three implementation plans, in dependency order. Plan 1 and plan 2 share the protocol and can be developed against each other in Node; plan 3 needs both.

1. **Bridge:** `@ironbird/react-native`, plus `verify-bundle` because it exists to detect the bridge's marker.
2. **Daemon and CLI:** the `DaemonTarget` interface, the shared operation queue, the remote channel, device resolution, `screenshot`, `step`, and the `serve` changes.
3. **Example app and measurement:** the Expo app, the harness, the reload test, the Q5 finding, and the M1 exit-criteria record.

## 4. Bridge: `@ironbird/react-native`

Peer dependencies `react-native` and `@ironbird/core`. Built with tsup to ESM and CJS like core. No native code, enforced by the existing lint rule that bans `node:` imports in the package and by a build check that the package's output never imports anything but `react-native` and `@ironbird/core`.

| Module | Responsibility |
|---|---|
| `marker.ts` | The constant `__IRONBIRD_BRIDGE_v1__`, referenced from `hello` so minifiers keep it. Core's build check already fails if the string leaks into core |
| `connection.ts` | Socket lifecycle: connect to `url`, send `hello`, handle `welcome` and `reject`, answer `ping` with `pong`, reconnect with exponential backoff from `reconnect.initialDelayMs` (500) to `reconnect.maxDelayMs` (5000) after any close except a `reject` or `stop()`. A `reject` is final: it is logged once and the bridge stays stopped, because a protocol or app mismatch cannot be retried into success |
| `handlers.ts` | One handler per operation the docs mark as supported remotely: `describe`, `dispatch`, `getState`, `waitFor`, `settle`, `events`, `fakeControl`, `fakeCalls`, and `snapshotSave` and `snapshotLoad` when the target implements `persist` and `restore`. `waitFor` subscribes to the target and resolves on the first revision that satisfies the condition, or fails with `WAIT_TIMEOUT` on the injected clock; nothing polls across the socket. `clockAdvance`, `clockNow`, and `reset` answer `UNSUPPORTED` |
| `settle.ts` | The algorithm in architecture §6.5, unchanged: yield a macrotask, wait until the tracker has nothing pending, wait `settle.frames` (default 2) animation frames, re-check the tracker, all timed by the injected `Clock`. `requestAnimationFrame` is used directly as a rendering signal |
| `messages.ts` | Validates the shape of every inbound frame and every payload against the app's own registry before anything runs. A malformed frame is logged and dropped; an invalid payload answers `INVALID_PAYLOAD` |
| `index.ts` | `startBridge` as documented in api.md: reads `Platform.OS`, builds the handshake from the target's description, wires the modules, and returns the handle. When `__DEV__` is false and `allowInNonDevBuilds` is unset, it logs one warning and returns an inert handle whose `connected` is false and `targetId` is null |

Notifications flow out on the side: every recorded event as `notify` kind `event`; state revisions as kind `state`, throttled to 10 per second with the latest revision winning; serialization warnings as kind `warning`, once per path per connection.

The capabilities in `hello` are `settle`, `events`, `fakes` when `fakes` were passed, and `persist` and `restore` when the target implements them. Never `clock` or `reset`.

**Node testability.** The bridge takes `WebSocket` and `requestAnimationFrame` from globals at call time, and imports `react-native` only for `Platform`, through a one-line `platform.ts` that the test config aliases to a stub. The `serial` test project runs the real bridge against the real daemon in one Node process, with the `ws` client installed as the global `WebSocket` and a manual clock driving settle and backoff.

**`verify-bundle`.** Lives in `@ironbird/cli` as a command that needs no daemon. It walks the given paths, byte-searches every file for the marker, and exits 1 listing the files that contain it, 0 otherwise, 2 on a missing path. Hermes bytecode is covered because its string table stores ASCII strings contiguously; the M1 eval confirms this against a real `expo export`.

## 5. Daemon and CLI

**`DaemonTarget`.** The headless target's current surface becomes an interface in `packages/cli/src/daemon-target.ts`:

```ts
interface DaemonTarget {
  readonly id: string;
  info(): TargetInfo;
  run(op: string, params: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: RecordedEvent) => void): () => void;
  onState(listener: (rev: number) => void): () => void;
  dispose(): Promise<void>;
}
```

The daemon's target map, `status`, the SSE stream, and target selection work against this interface only.

**Operation queue.** The per-target queue for mutating operations, its epoch counter, and the rule that abandons queued and in-flight work with `TARGET_DISCONNECTED` move from `headless-target.ts` into `operation-queue.ts`. The headless target keeps its reset semantics on top of it; the remote target uses it as is. The existing headless queue tests move with the code.

**Remote channel.** `serve` starts a `ws` server on `bridge.port` (default 4568), bound to the same host as the HTTP API, so a non-loopback bind requires the token in `hello` exactly as HTTP requires it in the header. `target-registry.ts` assigns ids per platform in connection order and reserves them across disconnects, as architecture §7.3 describes. `remote-target.ts` implements `DaemonTarget` over one socket:

- Sends requests with ids and resolves the matching response; the daemon's existing request bound applies unchanged.
- Turns `notify` frames into `onEvent` and `onState`; the last state revision seen is what `info()` reports as `rev`.
- Sends `ping` every 5 s and closes the socket after three missed `pong`s.
- Requests `describe` after `welcome` and caches it for the life of the connection; capabilities from `hello`, minus `clock` and `reset`, decide which operations answer `UNSUPPORTED` without a round trip.
- On close, fails every in-flight request with `TARGET_DISCONNECTED` and never retries, because the command may already have been applied. The target leaves the map; its id stays reserved.

When the config has no headless entry, the first bridge's app id becomes the session's app id; a later `hello` with a different id is rejected with `APP_MISMATCH` and close code 4002. `PROTOCOL_MISMATCH` closes with 4001 and `UNAUTHORIZED` with 4003.

**Device resolution.** `devices.ts` maps a target to a capture device in this order: `--device`, then `devices.<platform>` from config, then the single booted simulator from `xcrun simctl list devices booted -j` or the single entry from `adb devices`, else `AMBIGUOUS_DEVICE` with the candidates in `details`.

**Screenshot and step.** Capture runs `xcrun simctl io <udid> screenshot <path>` or `adb -s <serial> exec-out screencap -p`, writing to `<artifactsDir>/screenshots/<timestamp>-<target>.png` unless `out` is given. A tool failure is `SCREENSHOT_FAILED` with `{ tool, stderr }`. `step` runs `dispatch` through the target's queue with the given `settle`, captures after settling ends whether or not it reached idle, and returns the step result plus `screenshot` and `settledBeforeCapture`. `screenshot` and `step` default to the only connected remote target and fail with `AMBIGUOUS_TARGET` otherwise; `send` and the rest keep `defaultTarget`.

**`serve`.** Prints the bridge URL next to the HTTP URL. When `adb` is on the path, runs `adb reverse tcp:<bridge.port> tcp:<bridge.port>` for each connected Android device, logging and continuing when it fails. `daemon.json` gains `bridgePort`.

**CLI.** `screenshot`, `step` (exit 3 when the step is applied but unsettled, 1 on failure, 5 with no daemon), and `verify-bundle`. Option and output shapes are as documented in cli.md.

## 6. Example app and measurement

**Files added to `examples/checkout`.** `app.json`, `index.js`, `App.tsx`, `src/core/instance.ts`, `src/ironbird/device.ts`, `metro.config.js` if the spike needs it, `assets/` with two product images, and `scripts/measure.mjs`. The headless entry is untouched, and the existing bundle check still proves it never reaches `react-native`.

**Wiring.** `instance.ts` creates the real clock, tracker, and recorder with `enabled: __DEV__`, wraps the M0 fake reader and fake API through `tracker.wrap` on that clock, and builds the app core. `device.ts` calls `startBridge` with the target, tracker, recorder, fakes, clock, and `appId`. `index.js` requires `device.ts` inside `if (__DEV__)` and registers the root component.

**Screen.** `App.tsx` renders one screen from `useSyncExternalStore` over the core: the cart with add and remove buttons and a visible item count, the payment card showing the status machine, and the receipt. The reducer gains a `ui` slice with `motion: 'full' | 'reduced'` (default `full`) and a `ui.setMotion` command; the headless target accepts it too, where it is harmless. With motion full, the payment card animates status changes with `Animated` on the native driver, cart rows animate with `LayoutAnimation`, and the cart header shows a product image that alternates between the two bundled images on every add or remove, so image decoding is exercised on every harness step. With motion reduced, all three render instantly.

**The pnpm spike.** The first task of plan 3 starts the app in Expo Go from the workspace as it stands. If Metro cannot resolve through pnpm's isolated `node_modules`, the fallback is a `metro.config.js` with `watchFolders` and `nodeModulesPaths` covering the monorepo root, and only if that fails a hoisted linker. The plan records which one was needed.

**The harness.** `scripts/measure.mjs` drives a running daemon and app. It freezes the status bar (`xcrun simctl status_bar <udid> override` on iOS, System UI demo mode on Android), then runs 300 `step`s cycling through cart add, cart remove, payment start, and payment cancel, so every step changes the screen. After each step's capture it takes a second screenshot one second later and compares pixels with `pngjs`; a difference above a small threshold marks the first capture stale, as testing-strategy.md defines. It records per-step latency and settle outcome, runs once per motion arm, and writes `summary.json` plus the images under `<artifactsDir>/metrics/<run>/`. The same script runs against the Android emulator.

**The reload test.** A device test starts a `waitFor` that cannot be satisfied, triggers a reload, asserts the request fails with `TARGET_DISCONNECTED`, then asserts that `getState` on target `ios` succeeds after the bridge reconnects. The reload comes from Metro's dev-server reload endpoint if Expo's server exposes one, otherwise from terminating and relaunching Expo Go through `simctl`; both create a fresh JavaScript context, which is what the criterion exercises.

## 7. Testing

| Layer | What it covers |
|---|---|
| Unit (`unit` project, Node) | `settle.ts` under a manual clock with a stubbed `requestAnimationFrame`: idle, timeout with pending items, an effect that starts during the frame wait. `messages.ts`: malformed frames dropped, invalid payloads answered. `target-registry.ts`: ids per platform, reservation, two same-platform builds reconnecting. `devices.ts`: resolution order and `AMBIGUOUS_DEVICE`. `verify-bundle`: text, a synthetic binary, a nested directory, a missing path. `operation-queue.ts`: the headless queue tests moved onto it |
| Serial (Node, daemon-driving) | The real bridge against the real daemon over the `ws` client: handshake and `welcome`; `PROTOCOL_MISMATCH`, `APP_MISMATCH`, and `UNAUTHORIZED` rejections with their close codes; `dispatch` with settle; `waitFor` resolving from a subscription; notifications reaching the SSE stream; heartbeat timeout closing the socket; disconnect failing an in-flight request while the reconnect takes the same id |
| Device (`device` project, local only) | Screenshot capture on the booted simulator, one `step` end to end, the reload test |

The harness is not a test (D8). CI runs unit and serial only, as today.

## 8. Errors

No new codes. The bridge reports `INVALID_PAYLOAD`, `UNKNOWN_COMMAND`, `UNKNOWN_FAKE`, `UNKNOWN_CONTROL`, `WAIT_TIMEOUT`, and `UNSUPPORTED` in the existing error shape. The daemon owns `TARGET_DISCONNECTED`, `AMBIGUOUS_TARGET`, `AMBIGUOUS_DEVICE`, `SCREENSHOT_FAILED`, and the handshake rejections `PROTOCOL_MISMATCH`, `APP_MISMATCH`, and `UNAUTHORIZED`.

## 9. Docs, versioning, and the gate

- api.md: final `startBridge` behavior notes and the inert-handle rule. cli.md: the "(M1)" markers come off `screenshot`, `step`, and `verify-bundle`; `serve` documents the bridge URL and `adb reverse`. protocol.md: the `warning` notification's once-per-path rule.
- `docs/evals/m1-remote-mode.md` records the five exit criteria with the harness numbers for both motion arms, the Android run, the reload test, the `verify-bundle` result on a real `expo export` and on a deliberately broken export, and the Q5 finding.
- At the gate: ADR-0003 and ADR-0005 get their decision, and spec rows Q5 and Q9 close.
- Changesets: `@ironbird/react-native` new at `0.0.1`; patches for `@ironbird/cli` (new commands, `ws`) and `@ironbird/core` (listener isolation).

## 10. Deferred M0 items folded in

- Listener isolation: a throwing subscriber in `EventRecorder.record()` or a throwing tracker `onChange` listener no longer aborts later listeners (core, plan 1).
- A direct unit test of the daemon's `sameSite` check (plan 2).
- `bootTimeoutMs` in config (plan 2).

## 11. Risks

| Risk | Mitigation |
|---|---|
| pnpm's isolated `node_modules` against Metro | The spike in plan 3 with two fallbacks (§6) |
| Expo's dev server has no reload endpoint | `simctl` terminate and relaunch (§6) |
| The stale rate stays above 1% with motion full | Expected to some degree; that is the Q5 finding. The roadmap's "narrow if needed" clause applies only if the reduced arm also misses |
| Two same-platform builds swapping ids on simultaneous reload | Documented in architecture §7.3; not addressed until Q4 |
