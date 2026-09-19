# ironbird: Product Spec

| | |
|---|---|
| Status | Draft |
| Version | 0.1 (pre-implementation) |
| Last updated | 2026-09-18 |
| Related | [architecture.md](architecture.md) · [roadmap.md](roadmap.md) |

## Problem statement

Coding agents now do a large share of React Native implementation work, but they verify it the slow way: build the app, drive a simulator through the accessibility tree or screenshots, and interpret what they see. One check takes minutes, breaks for reasons unrelated to the change, and gives the agent pixels instead of the state it needs. The bugs that cost production apps the most, such as events arriving out of order, duplicate or missing server events, timeouts, and hardware disconnects, are close to impossible to reproduce this way.

On 2026-09-10 Shopify described its answer for native apps: business logic decoupled from the UI, runnable headlessly on a desktop, and exposed to agents through a CLI that can also drive a simulator. No equivalent exists for React Native. Current RN agent tools, including agent-device, agent-react-devtools, react-native-ai-devtools, and stim-cli, operate on the running app from the outside, and none provides a headless, deterministic loop. React Native is unusually well placed for one, because app logic written in TypeScript already runs in Node.

## Goals

| # | Goal | Measure | Target |
|---|---|---|---|
| G1 | Fast inner loop | ironbird overhead per headless command, excluding app logic (p95) | < 5 ms |
| | | CLI invocation end to end, headless, on Apple Silicon (p95) | < 300 ms |
| G2 | Trustworthy remote steps | Send, settle, and screenshot on iOS Simulator (p95) | < 1.5 s |
| | | Stale screenshots over 300 consecutive steps | ≤ 1% |
| G3 | Deterministic reproduction | Final-state divergences across 100 headless runs of one scenario | 0 |
| G4 | Low integration cost | Time for an RN engineer to wire a first flow into an existing app from the docs alone | ≤ 1 working day |
| G5 | No bridge in production | Release or OTA bundles in CI that contain the bridge | 0 |

## Non-goals

| Non-goal | Why it is out of scope |
|---|---|
| UI automation (taps, gestures, element queries) | agent-device, Maestro, and Detox already do this well; ironbird hands off to them for device-level checks |
| A state management library | ironbird adapts to XState, Redux, Zustand, or custom stores through a small `Target` interface |
| Running arbitrary JavaScript inside the app | Keeps the agent surface declared, validated, replayable, and auditable ([ADR-0001](adr/0001-commands-only-agent-surface.md)) |
| Use in production or release builds | Dev and internal QA builds only, enforced by a runtime guard and `ironbird verify-bundle` |
| Visual regression testing in v0 | Screenshots are evidence in v0; baseline diffing is P2 |
| Targets other than React Native in v0 | The protocol shouldn't preclude web React or native apps, but v0 serves React Native only |

## Personas

| Persona | Role | Needs |
|---|---|---|
| Coding agent | Primary operator, through the CLI or MCP | Structured output, fast responses, deterministic behavior, errors it can act on |
| App engineer | Integrates ironbird into an existing RN app | No native code, a small surface, adoption one flow at a time, no release risk |
| Reviewer | Checks work an agent claims is verified | Reproducible evidence: scenario files, event logs, screenshots |
| Contributor | Maintains ironbird | Clear boundaries, a fast test suite, measurable reliability |

## User stories

### Coding agent

1. As a coding agent, I want to list an app's commands and fakes with payload schemas so that I can act without reading the whole codebase.
2. As a coding agent, I want to send a command headlessly and get the resulting state, events, and pending effects in one response so that I can iterate in milliseconds.
3. As a coding agent, I want to inject fake events and advance a controlled clock so that I can reproduce ordering, duplicate, timeout, and disconnect bugs deterministically.
4. As a coding agent, I want to wait for a state condition with a timeout that reports what is still pending so that I never guess with sleeps.
5. As a coding agent, I want to send the same command to a running dev build and get state plus a screenshot taken after the UI settles so that I can verify what a user would see.
6. As a coding agent, I want to save what I did as a scenario file so that humans and CI can rerun it exactly.
7. As a coding agent, when my payload is invalid, I want structured validation issues so that I can correct the call without another lookup.
8. As a coding agent, when the app disconnects mid-request, for example during a Metro reload, I want a specific error and automatic reconnection so that I know whether it is safe to retry.

### App engineer

9. As an app engineer, I want to adopt ironbird for one flow without restructuring the rest of my app so that the first integration fits in a day.
10. As an app engineer, I want CI to prove the bridge is absent from release and OTA bundles so that adoption doesn't need a security exception.
11. As an app engineer, I want ironbird to name the import chain that pulled `react-native` into my headless code so that I can fix boundary violations quickly.

### Reviewer

12. As a reviewer, I want an agent's claim that something is verified to come with a scenario, an event log, and screenshots so that I can confirm it without redoing the work.

## Requirements

### P0: must have for 0.1

**R1. Command registry.** Apps declare commands as a record of names to Zod schemas.
- [ ] Payloads are validated before reaching app code; invalid payloads fail with `INVALID_PAYLOAD` and the Zod issues
- [ ] Unknown names fail with `UNKNOWN_COMMAND` and up to three closest names
- [ ] Every command is describable as JSON Schema, including `.describe()` text
- [ ] Omitted payloads are treated as `{}`

**R2. Target interface.** Any state container can be adapted with `createTarget`.
- [ ] Requires only `commands`, `dispatch`, and `getState`; `subscribe` is optional
- [ ] Each state notification or dispatch increments a revision number returned with every result
- [ ] Non-JSON values in state are replaced with a placeholder and reported once per path, never silently dropped

**R3. Headless daemon.** `ironbird serve` hosts the app's headless definition in Node.
- [ ] Loads a TypeScript headless entry named in config without a separate build step
- [ ] A `react-native` import anywhere in the app's own source graph (dependencies are left external and are not scanned) fails with `HEADLESS_LOAD_FAILED`, naming the import chain
- [ ] `ironbird reset` disposes the app and recreates it with a fresh clock, recorder, tracker, and fakes
- [ ] Binds to 127.0.0.1 by default; a non-loopback host requires a token
- [ ] A daemon session serves one app: a bridge whose app id differs from the session's app is rejected with `APP_MISMATCH`

**R4. Core CLI.** `status`, `commands`, `fakes`, `send`, `state`, `wait`, `settle`, `events`, `fake`, `clock advance`, `clock now`, `reset`.
- [ ] JSON output when stdout isn't a TTY or `--json` is passed
- [ ] Exit codes follow [cli.md](cli.md#exit-codes)
- [ ] A `wait` timeout exits 4 and returns the last value at the path plus pending effects

**R5. Manual clock and effect tracking.**
- [ ] Headless targets get a manual clock; time moves only through `clock advance`, except zero-delay timers, which run as part of every step
- [ ] `advance` fires due timers in time order and lets promise jobs run between them
- [ ] `tracker.wrap` tracks promise-returning port methods by label
- [ ] Settle results distinguish idle (nothing pending) from quiescent (only fake-backed work pending, waiting on the clock or a control)
- [ ] `createTracker({ enabled: false })` returns an inert tracker whose `wrap` returns the port untouched, so release builds carry no effect tracking

**R6. Fakes with controls.**
- [ ] `defineFake` declares controls with Zod schemas, and they appear in `ironbird fakes`
- [ ] `ironbird fake <name> <control>` validates the payload, runs the control, and returns the same result shape as `send`

**R7. Event recorder.**
- [ ] Events carry monotonic sequence numbers; `events --since <seq>` returns only newer events
- [ ] The buffer is bounded (default 10,000 events) and reports truncation
- [ ] `createEventRecorder({ enabled: false })` returns an inert recorder, so release builds carry no event log

**R8. React Native bridge.**
- [ ] `startBridge` connects out to the daemon over WebSocket and reconnects with backoff after reloads
- [ ] It no-ops when `__DEV__` is false unless `allowInNonDevBuilds` is set
- [ ] It re-validates every payload inside the app
- [ ] It contains no native code

**R9. Settle detection in the app.**
- [ ] After a dispatch, waits for tracked effects to finish and then for N animation frames (default 2), within a timeout (default 5 s)
- [ ] A timeout returns `idle: false` with pending items; the command still counts as applied, and the CLI exits 3

**R10. Screenshots and steps.**
- [ ] `ironbird screenshot` captures the iOS Simulator through `simctl`, and Android emulators or devices through `adb`
- [ ] `ironbird step` performs send, settle, and screenshot, and returns all three results
- [ ] Several booted devices with no `--device` fails with `AMBIGUOUS_DEVICE`

**R11. Scenario files.**
- [ ] YAML steps: `send`, `fake`, `clock`, `wait`, `expect`, `screenshot`, `reset`
- [ ] One file runs against headless and remote targets; unsupported steps fail with `UNSUPPORTED` unless marked `optional: true`
- [ ] A failing step reports its index, the expected and actual values, and where artifacts were written

**R12. Bundle verification.**
- [ ] `ironbird verify-bundle <path>` exits non-zero if the bridge marker appears in any file under the path, including Hermes bytecode
- [ ] Docs include CI recipes for release builds and production exports used by OTA updates

### P1: planned for 0.1 if milestones hold

| ID | Requirement | Acceptance summary |
|---|---|---|
| R13 | MCP server (`ironbird mcp`) | Tools mirror the CLI; `ironbird_step` returns the screenshot as image content |
| R14 | Agent skill | A skill file that teaches the loop: describe, send, wait, then escalate to device checks |
| R15 | Snapshots | `snapshot save` and `load` for targets that implement `persist` and `restore`; others return `UNSUPPORTED` |
| R16 | Fake call log | `ironbird fake <name> --calls` lists recorded port calls with arguments and outcomes |
| R17 | `watch` | Streams state revisions and JSON Patch diffs until interrupted |
| R18 | `@ironbird/testing` | Runs scenarios in Vitest or Jest; model-based testing helper built on fast-check |
| R19 | Adapters | `@ironbird/xstate` and `@ironbird/redux` targets, with persistence where the library supports it |
| R20 | `doctor` | Checks Node version, config, headless load, simulator and adb availability, and that `.ironbird/` is gitignored |

### P2: design for, don't build yet

Visual baselines and diffs. Event-stream parity comparison across runs or targets, ignoring volatile fields such as timestamps and IDs. Navigation sync adapters for React Navigation and Expo Router. Automatic mapping of a connection to a simulator UDID. Clock control on device. Screenshots from physical iOS devices through an agent-device integration. More than one app per daemon session. Non-RN targets over the same protocol. One MCP tool per app command for small apps. Standard Schema support alongside Zod.

## Success metrics

### Leading indicators (per milestone)

| Metric | Target | Where it is measured |
|---|---|---|
| Headless overhead per command (p95) | < 5 ms | Benchmark against the example app, M0 |
| Remote step latency on iOS Simulator (p95) | < 1.5 s | 300-step device run, M1 |
| Stale-screenshot rate | ≤ 1% | Double-capture check over 300 steps, M1 |
| Headless determinism | 0 divergences in 100 runs | Example scenario suite, M2 |
| Agent task success | ≥ 4 of 5 fresh sessions | Agent eval on the planted race, M3 |
| Race rediscovery by model-based tests | ≥ 9 of 10 seeds within 1,000 runs | `@ironbird/testing` suite, M4 |

### Lagging indicators (3–6 months after 0.1)

These targets are hypotheses to revisit after the first pilots.

| Metric | Target |
|---|---|
| External apps integrated | 3 within 3 months of 0.1 |
| Time to first working flow, reported by pilot teams | ≤ 1 day, median |
| Pilot teams still using ironbird after 60 days | ≥ 2 of 3 |
| Flakiness issues opened per month | Falling month over month |
| Pilot bugs reproduced as a scenario before being fixed | Tracked; no target yet |

## Open questions

| # | Question | Owner | Blocking |
|---|---|---|---|
| Q1 | ~~Can we claim the `@ironbird` npm scope and an `ironbird` GitHub org?~~ **Resolved 2026-09-10:** `@ironbird` npm org claimed; GitHub org is `ironbird-dev` because `ironbird` was taken; repository `ironbird-dev/ironbird`. The unscoped `ironbird` package is still unpublished and becomes the CLI entry point in M0 | Maintainer | Resolved |
| Q2 | ~~How should the daemon load TypeScript headless entries?~~ **Resolved 2026-09-11:** esbuild bundles the entry with dependencies external; tsconfig `paths` are honored and the metafile yields the `react-native` import chain | Engineering | Resolved |
| Q3 | Does Zod 4's JSON Schema output work cleanly as MCP tool input schemas with the MCP TypeScript SDK? | Engineering | M3 |
| Q4 | How do we map a connected app to a specific simulator when several are booted, without native code? | Engineering | No; config fallback exists |
| Q5 | ~~Are JS-only signals enough to settle around UI-thread animations (for example Reanimated), layout animations, and image decoding, or is an optional native add-on needed?~~ **Resolved 2026-09-18:** yes with motion reduced, zero nonzero pixel diffs across all 1200 reduced-arm measurement captures on both platforms; a native add-on is not warranted on this evidence. The full-motion iOS 0% is a capture-latency artifact, not detection: its ~545 ms capture lands after the 400 ms native-driver payment fade completes, while Android's faster ~190 ms capture lands mid-fade and shows the blind spot directly (60/60 full-motion `payment.start` steps) | Engineering | Resolved |
| Q6 | Should fast-check arbitraries be derived from Zod schemas with an existing library or a minimal in-house generator? | Engineering | M4 |
| Q7 | ~~License: MIT or Apache-2.0?~~ **Resolved 2026-09-12:** MIT. `LICENSE` sits at the repository root and in each published package, and every `package.json` declares `"license": "MIT"` | Maintainer | Resolved |
| Q8 | Do we support apps still on Zod 3, and how? | Engineering | Before 0.1 |
| Q9 | ~~Does the bridge work in Expo Go?~~ **Resolved 2026-09-18:** yes; the example runs in Expo Go with no native code, and every M1 measurement was taken there | Engineering | Resolved |
| Q10 | ~~Is "ironbird" clear of trademark conflicts for a developer tool?~~ **Resolved 2026-09-13:** the trademark search found no conflict in software or developer tools; the name is cleared for publishing | Maintainer | Resolved |

## Timeline and phasing

There are no external deadlines. Work is phased into milestones M0–M5, roughly eight focused weeks, each ending with a go/no-go decision on its exit criteria ([roadmap.md](roadmap.md)). M0 and M1 are the feasibility proof: if remote settle detection can't meet its target, remote mode is narrowed before further investment.

## References

- Shopify Engineering, "Native is now the future of mobile at Shopify" (2026-09-10): https://shopify.engineering/back-to-native
- Shopify Engineering, "Migrating Shop app from React Native to native" (2026-09-10): https://shopify.engineering/shop-app-migration
- callstack/agent-device: https://github.com/callstack/agent-device
- callstackincubator/agent-react-devtools: https://github.com/callstackincubator/agent-react-devtools
- igorzheludkov/react-native-ai-devtools: https://github.com/igorzheludkov/react-native-ai-devtools
- appandflow/stim-cli: https://github.com/appandflow/stim-cli
