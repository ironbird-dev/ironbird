# ADR-0005: Pure JavaScript, no native code in v0

**Status:** Accepted (2026-09-20, M1 gate)
**Date:** 2026-09-10
**Deciders:** Project maintainer

## Context

Adoption friction decides whether a developer tool gets used. Native modules bring pod installs, Gradle changes, Expo config plugins, rebuilds, and compatibility work across React Native releases. They can't be delivered through OTA updates and don't run in Expo Go.

Native code would, however, give better signals: visibility into UI-thread animations, device identity for mapping connections to simulators, and in-app screenshots.

## Decision

v0 ships no native code of its own. The bridge uses only React Native's built-in `WebSocket`, `requestAnimationFrame`, and `Platform`. Screenshots are captured on the host with `simctl` and `adb`. An optional native add-on will be reconsidered only if JS-only settle detection misses its stale-screenshot target (spec Q5).

## Options considered

### Option A: Pure JavaScript

| Dimension | Assessment |
|---|---|
| Adoption cost | Low: install packages and wire up JavaScript |
| Signal quality | Medium: no UI-thread insight, no device identity |
| Maintenance | Low |
| Reach | Expo Go (to verify), Expo dev builds, bare React Native; simulators, emulators, Android devices |

**Pros:** Fast adoption; works with OTA-only workflows; the bridge can be tested in Node with shims.

**Cons:** Settle detection has blind spots; device mapping needs configuration; no screenshots from physical iOS devices.

### Option B: Native module required

| Dimension | Assessment |
|---|---|
| Adoption cost | High |
| Signal quality | High |
| Maintenance | High: native code across React Native versions and architectures |
| Reach | Dev builds only; no Expo Go |

**Pros:** Best signals and in-app capture everywhere.

**Cons:** Front-loads cost before the product has proven its value.

### Option C: Pure JavaScript core with an optional native add-on

| Dimension | Assessment |
|---|---|
| Adoption cost | Low by default; higher for teams that opt in |
| Signal quality | High when the add-on is installed |
| Maintenance | Medium to high |
| Reach | Both of the above |

**Pros:** Keeps the easy path while allowing better signals later.

**Cons:** Two code paths to test and document.

## Trade-off analysis

Option A proves the product with the lowest adoption cost. Option C preserves a path to better signals if M1 shows they are needed. Option B spends the largest effort before there is evidence it's required.

## Consequences

- **Easier:** installation, OTA-friendly adoption, and bridge testing without devices.
- **Harder:** settle detection can't see UI-thread animations; mapping a connection to a device is manual (spec Q4); physical iOS screenshots are out of scope for v0.
- **Revisit:** after M1, using the measured stale-screenshot and settle-timeout rates.

## Review (2026-09-18, M1 gate)

The Q5 finding in [docs/evals/m1-remote-mode.md](../evals/m1-remote-mode.md): JS-only signals cannot see native-driver animations. With motion full, Android's capture (~190 ms) lands inside the payment Reveal's 400 ms native-driver fade, so 60 of 60 full-motion `payment.start` steps registered a nonzero diff there; iOS showed no app-level staleness in the same full-motion arm (its one flagged step is a `simctl` capture artifact, not an animation), not because JS-only detection caught the fade but because iOS's slower ~545 ms capture happens to land after it finishes. The mitigation — testing with motion reduced — is fully effective: zero nonzero pixel diffs across all 1200 reduced-arm captures on both platforms. On this evidence, no native add-on is warranted for now: the blind spot is real, but the documented mitigation closes it completely. The decision was deferred at this review and made on 2026-09-20; see below.

## Decision (2026-09-20, M1 gate)

Accepted: ironbird stays pure JavaScript, with no native add-on. The blind spot is real and measured. In the clean gate run, 50 of 60 full-motion Android payment steps were captured while a native-driver fade was still running, and JS-only settle saw none of it. The mitigation is a rule rather than code: agent-driven development builds run with motion reduced, which left zero differing app pixels on both platforms in both runs. The rule is documented in [docs/api.md](../api.md) under "Reduce motion in agent-driven builds", and the record is in [docs/evals/m1-remote-mode.md](../evals/m1-remote-mode.md). Revisit if adopters cannot reduce motion in their development builds, or if staleness appears with motion reduced.

## Action items

1. [x] M1 experiment comparing stale-screenshot rates with animations enabled and reduced
2. [x] Documentation on reducing motion in agent-driven dev builds
3. [x] Keep native-module imports out of `@ironbird/react-native` (enforced at build time by the import allowlist in `packages/react-native/scripts/verify-build.mjs`, which admits only `react-native` and `@ironbird/core`, rather than by a lint rule)
