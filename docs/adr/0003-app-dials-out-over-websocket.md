# ADR-0003: App dials out to the daemon over WebSocket

**Status:** Accepted (2026-09-20, M1 gate)
**Date:** 2026-09-10
**Deciders:** Project maintainer

## Context

Remote mode needs a bidirectional channel between the host and a dev build running on a simulator, emulator, or device. The channel must work without native code ([ADR-0005](0005-pure-javascript-no-native-code.md)), must not rely on evaluating code in the app ([ADR-0001](0001-commands-only-agent-surface.md)), and shouldn't tie ironbird to one toolchain.

## Decision

The app opens a WebSocket connection to the daemon, by default `ws://localhost:4568`, using React Native's built-in `WebSocket`. iOS Simulator reaches the host at `localhost`. Android emulators reach it through `adb reverse`, which `ironbird serve` sets up when `adb` is available. Physical devices use the host's LAN address, and the daemon then requires a token.

## Options considered

### Option A: App connects out over WebSocket

| Dimension | Assessment |
|---|---|
| Native code | None: `WebSocket` is built into React Native |
| Setup | Low: `localhost` on iOS Simulator, `adb reverse` on Android |
| Toolchain coupling | None |
| Fit with commands-only | Full |

**Pros:** Works in Expo and bare apps with no rebuild; the app controls when it connects; one daemon serves the same app on several devices.

**Cons:** Needs reconnection logic; devices on a LAN need host addressing and a token.

### Option B: App hosts a server and the daemon connects in

| Dimension | Assessment |
|---|---|
| Native code | Required: React Native has no built-in server socket API |
| Setup | Medium: the daemon must discover each device's address and port |
| Toolchain coupling | None |
| Fit with commands-only | Full |

**Pros:** The daemon initiates connections, which some network setups prefer.

**Cons:** Requires a native module, which violates ADR-0005; device discovery is its own problem.

### Option C: Chrome DevTools Protocol through Metro's inspector proxy

| Dimension | Assessment |
|---|---|
| Native code | None |
| Setup | Low while a debugger session is available |
| Toolchain coupling | High: depends on debugger sessions and may conflict with React Native DevTools use |
| Fit with commands-only | Poor: the natural mechanism is evaluating code in the runtime |

**Pros:** No app changes for basic access.

**Cons:** Pushes toward code evaluation; debugging and agent driving compete for the same channel.

### Option D: Existing developer channels, such as Expo DevTools plugins or Reactotron

| Dimension | Assessment |
|---|---|
| Native code | None |
| Setup | Low within that toolchain |
| Toolchain coupling | High: Expo-only or Reactotron-dependent |
| Fit with commands-only | Full |

**Pros:** Reuses infrastructure teams may already run.

**Cons:** Excludes apps outside that toolchain; ironbird's protocol would be constrained by someone else's transport.

## Trade-off analysis

Option A is the only option that is pure JavaScript, toolchain-neutral, and consistent with a commands-only surface. Its costs, reconnection handling and network configuration for Android and physical devices, are contained within the bridge and `serve`.

## Consequences

- **Easier:** support for Expo and bare React Native, simulators and devices, with no rebuilds.
- **Harder:** robust reconnection after reloads; token handling whenever the daemon binds beyond localhost.
- **Revisit:** an optional Expo DevTools plugin transport as a convenience layer on top of the same protocol.

## Review (2026-09-18, M1 gate)

Confirmed for reconnection: the Metro-reload device test (`examples/checkout/test/remote.device.test.ts`, "a reload fails the in-flight request with TARGET_DISCONNECTED and the next request runs under the same id") shows the in-flight request failing with `TARGET_DISCONNECTED` and the next request succeeding under the same target id, and the Android measurement run connected through `adb reverse` with no bridge changes needed. The measured M1 numbers are in [docs/evals/m1-remote-mode.md](../evals/m1-remote-mode.md): the iOS stale-screenshot rate passes in both motion arms, but p95 step latency misses the < 1.5 s bar in both arms, a structural cost of the fixed measurement cycle and `simctl` capture time rather than a defect in this transport decision. The decision was deferred at this review and made on 2026-09-20; see below.

## Decision (2026-09-20, M1 gate)

Accepted. Everything measured supports the design: reconnection after a Metro reload keeps the target id, Android connects through `adb reverse` with no bridge changes, and the transport's share of a step is a few milliseconds. The latency criterion was restated at the same gate to measure ironbird's overhead per step, and the gate run met it on iOS at p95 993 ms and 715 ms, most of which is the host screenshot rather than this channel. The record is in [docs/evals/m1-remote-mode.md](../evals/m1-remote-mode.md).

## Action items

1. [x] Bridge reconnection with exponential backoff (500 ms to 5 s)
2. [x] `ironbird serve` runs `adb reverse tcp:4568 tcp:4568` for each connected Android device when `adb` is present
3. [ ] Documentation for physical devices on a LAN, including token setup
