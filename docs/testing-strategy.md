# ironbird: Testing Strategy

| | |
|---|---|
| Status | Draft |
| Last updated | 2026-09-11 |
| Related | [spec.md](spec.md) · [roadmap.md](roadmap.md) · [AGENTS.md](../AGENTS.md) |

ironbird's tests have two jobs: prove that ironbird works, and measure how far its results can be trusted. The second job matters as much as the first, because a verification tool that is quietly wrong is worse than having none.

## Test layers

| Layer | Tooling | Runs | Covers |
|---|---|---|---|
| Unit | Vitest | Every commit | Registry validation and suggestions, path resolution, serialization placeholders, recorder sequencing, manual clock ordering, tracker idle and quiescence logic, scenario parsing |
| Property | Vitest with fast-check | Every commit | Clock, tracker, recorder, and serialization invariants (below) |
| Protocol contract | Vitest | Every commit | Shared message fixtures that both the daemon and the bridge must accept and produce; fixtures are kept per protocol version |
| Daemon integration | Vitest in Node | Every commit | Every CLI command against the example app's headless entry: outputs, error codes, exit codes, reset isolation, two concurrent clients including a `wait` in one satisfied by a `clock advance` in the other |
| Bridge integration, no device | Vitest in Node | Every commit | The real bridge running in Node with shims for `Platform`, `requestAnimationFrame`, and `WebSocket` and a manual clock, connected to a real daemon: handshake, reconnection, the app-id check, request ordering, settle timeouts, the dev-only guard |
| Device end to end | Vitest on a macOS runner with iOS Simulator and an Android emulator | Nightly and before each release | Example app: 300-step stale-screenshot run, Metro reload reconnection, `step` latency, `verify-bundle` against real release and export output |
| Agent evals | Scripted sessions with a coding agent | Per milestone from M3, and before each release | Fresh-session tasks on the example app; task success rate and false "verified" claims |

Device tests are named `*.device.test.ts` and are excluded from `pnpm test`.

## Invariants checked with fast-check

- Advancing a manual clock by `a` and then by `b` fires the same timers, in the same order, as advancing by `a + b`.
- Timers fire in non-decreasing due order, and ties fire in the order they were scheduled.
- Cleared timers never fire.
- Recorder sequence numbers strictly increase, and `since(n)` never returns an event with `seq <= n`.
- The tracker reports idle only when no wrapped promise is unresolved.
- Serialization never throws for any input, including cyclic values and `BigInt`, omits `undefined` properties, and marks every other non-JSON value.

## Example test cases

**Settle reports pending effects on timeout**
- Given a remote target whose wrapped `reader.collectPayment` never resolves
- When the agent runs `ironbird send payment.start '{"method":"card"}' --settle-timeout 200ms`
- Then the result has `idle: false` and `pending` contains `reader.collectPayment`, the revision reflects the dispatch, and the CLI exits 3

**Quiescence in headless mode**
- Given the fake reader's `collectPayment` is scheduled 1,200 ms ahead on the manual clock
- When the agent sends `payment.start`
- Then the step returns in under 50 ms with `idle: false`, `quiescent: true`, pending `reader.collectPayment`, and `nextTimerInMs: 1200`, and the CLI exits 0

**Disconnect mid-request**
- Given an iOS target processing a slow dispatch
- When the app reloads through Metro
- Then the in-flight request fails with `TARGET_DISCONNECTED`, the app reconnects under the same target id, and the next request succeeds

**Bridge absent from production output**
- Given the example app exported with `npx expo export` in production mode
- When `ironbird verify-bundle dist` runs
- Then it exits 0, including when the export contains `@ironbird/core`, and it exits 1 against a deliberately broken build that imports the bridge outside the `__DEV__` branch

**Invalid payload never reaches app code**
- Given `cart.addItem` requires `qty` to be a positive integer
- When the agent sends `{"sku":"x","qty":0}`
- Then the error is `INVALID_PAYLOAD` with an issue at path `qty`, the revision is unchanged, and the app's dispatch was never called

**Headless load failure names the culprit**
- Given `src/core/pricing.ts` imports a module that imports `react-native`
- When `ironbird serve` starts
- Then it exits 2 with `HEADLESS_LOAD_FAILED`, and `importChain` lists `headless.ts → … → pricing.ts → react-native`

**Disabled tracker and recorder are inert**
- Given `createTracker({ enabled: false })` and `createEventRecorder({ enabled: false })`
- When a wrapped port method is called and an event is recorded
- Then `wrap` returned the same object it was given, `pending()` is empty, and `since()` returns no events

## Coverage targets

| Area | Target |
|---|---|
| `@ironbird/core` line and branch coverage | ≥ 90% |
| Clock and tracker mutation score (StrykerJS) | ≥ 70% by M4 |
| Documented error codes with at least one integration test each | 100% |

Coverage is a floor, not the goal. The reliability indicators below are what show whether ironbird can be trusted.

## Reliability indicators

| Indicator | How it is measured | Target |
|---|---|---|
| Stale-screenshot rate | After each step on a static screen, capture a second screenshot 1 s later; a pixel difference above a small threshold marks the first capture stale. Freeze the status bar with `xcrun simctl status_bar <device> override` on iOS and System UI demo mode on Android so the clock doesn't cause false positives | ≤ 1% |
| Settle timeout rate | Share of steps ending `idle: false` on screens with no deliberately slow effects | ≤ 0.5% |
| Device suite flake rate | Tests that fail and then pass on rerun with no code change | ≤ 1% of runs per week; flaky tests quarantined within a day |
| Headless determinism | Final-state divergence across 100 runs of each example scenario | 0 |
| Agent false-verified rate | Share of an agent's "verified" claims that fail human spot checks in evals | Tracked from M3; ≤ 5% before 1.0 |
| Escaped defects | Bugs found by users that an existing scenario or test should have caught | Each one becomes a regression scenario |

Retries never hide failures: a test that passes only on retry counts as a flake in these indicators.

## Guidance for apps using ironbird

These practices keep fakes from becoming a comfortable fiction:

- Build fake behavior from recorded production event sequences, not from API documentation alone.
- Keep a standard set of misbehaving-server scenarios: missing, duplicated, reordered, delayed, and malformed events.
- Periodically run the same scenarios against staging with real adapters, once per relevant backend or payment configuration, and compare outcomes with the fake runs.
- Let agents gather evidence, but let deterministic checks decide pass or fail.
- Turn every production bug in an ironbird-covered flow into a scenario.

## Known gaps

- UI-thread animations and image decoding are invisible to JS-only settle detection (spec Q5).
- ironbird can't capture screenshots from physical iOS devices in v0.
- iOS device testing requires macOS; Linux and Windows hosts can run headless mode and Android only.
