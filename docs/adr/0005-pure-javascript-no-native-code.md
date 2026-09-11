# ADR-0005: Pure JavaScript, no native code in v0

**Status:** Proposed
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

## Action items

1. [ ] M1 experiment comparing stale-screenshot rates with animations enabled and reduced
2. [ ] Documentation on reducing motion in agent-driven dev builds
3. [ ] Lint rule keeping native-module imports out of `@ironbird/react-native`
