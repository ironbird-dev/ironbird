# ironbird: Roadmap

| | |
|---|---|
| Status | Draft |
| Last updated | 2026-09-11 |
| Related | [spec.md](spec.md) (requirement and question IDs) · [testing-strategy.md](testing-strategy.md) |

Estimates assume focused effort and describe a sequence, not calendar dates. Each milestone ends with a short demo and a go/no-go decision against its exit criteria.

## Overview

| Milestone | Theme | Estimate | Delivers | Gate |
|---|---|---|---|---|
| M0 | Headless loop | 1 week | Core, daemon, core CLI, example app logic | An agent completes checkout headlessly |
| M1 | Remote mode | 1 week | Bridge, settle, screenshots, `step`, `verify-bundle` | Stale-screenshot rate ≤ 1% on iOS |
| M2 | Fakes and scenarios | 1 week | Fake controls, scenario runner | Planted race reproduced on both targets |
| M3 | Agent interface | 1 week | MCP server, agent skill | Agent fixes the planted race unaided in 4 of 5 sessions |
| M4 | Testing package | 2 weeks | `@ironbird/testing`, model-based helper | Race rediscovered in 9 of 10 seeds |
| M5 | Adapters and 0.1 | 2 weeks | XState and Redux adapters, second example, `doctor`, publish | A second app integrated in ≤ 1 day |

M0 and M1 together are the feasibility proof. If either gate fails, fix the design before adding scope.

## Before M0

- [x] `@ironbird` npm org claimed (Q1)
- [x] GitHub org `ironbird-dev` created (Q1)
- [ ] Choose a license (Q7) and add `LICENSE`
- [ ] Trademark search for "ironbird" in software and developer tools (Q10)
- [ ] Review ADR-0001 through ADR-0005 and mark each Accepted, amended, or rejected
- [x] Create `ironbird-dev/ironbird` and push these docs as the first commit
- [ ] Protect `main` and require 2FA for org members
- [ ] Enable 2FA on the npm org and plan to publish from GitHub Actions with npm trusted publishing rather than long-lived tokens

## M0: Headless loop

**Scope:** R1–R5 (headless parts), R7. Resolve Q2.

- Monorepo scaffold, lint boundaries, and CI running unit and integration tests
- `@ironbird/core`: registry, `createTarget`, manual clock, tracker, recorder, `defineHeadless`, `IronbirdError`
- `@ironbird/cli`: `serve` (headless only), `status`, `commands`, `send`, `state`, `wait`, `settle`, `events`, `clock advance`, `clock now`, `reset`
- Release pipeline: Changesets plus trusted publishing from GitHub Actions; publish `0.0.x` pre-releases of `ironbird` and `@ironbird/*` at the end of M0, which also secures the unscoped name
- `examples/checkout` app logic: a cart and payment state machine, a hand-written fake card reader and fake payment API scheduled on the manual clock (M2 turns them into `defineFake` fakes with controls), and a planted ordering bug behind `PLANT_RACE=1`. In the planted bug, a duplicated or early `payment.succeeded` event completes the order before the server confirms the total, producing a completed order with a zero total

**Exit criteria**

- [ ] A coding agent, given only the output of `ironbird commands`, completes cart → payment → receipt headlessly
- [ ] ironbird overhead per headless command is under 5 ms at p95, and CLI invocations are under 300 ms at p95
- [ ] A `react-native` import in the headless graph produces `HEADLESS_LOAD_FAILED` with the import chain

## M1: Remote mode

**Scope:** R8–R10, R12. Investigate Q5; verify Q9.

- `@ironbird/react-native`: `startBridge`, handshake, reconnection, settle detection
- Real-clock timer tracking in the tracker, so remote settle waits for short timers as well as wrapped effects
- Daemon: WebSocket target channel, target ids, `screenshot`, `step`, `verify-bundle`
- Example app screens wired to the same core used in M0
- Measurement harness for stale screenshots and step latency

**Exit criteria**

- [ ] 300 consecutive `step`s on iOS Simulator: stale-screenshot rate ≤ 1% and p95 latency < 1.5 s
- [ ] The same run on an Android emulator is recorded, and an Android target is set from the result
- [ ] A Metro reload mid-session fails the in-flight request with `TARGET_DISCONNECTED`, and the next request succeeds under the same target id
- [ ] `verify-bundle` passes on a production `expo export` and fails on a deliberately broken build
- [ ] A short written finding on Q5: stale rate with animations enabled versus reduced

**Narrow if needed:** if the iOS stale rate stays above 5% after a week of iteration, switch remote settling to condition-based `wait` plus a fixed post-render delay, document remote mode as best-effort for 0.1, and open an ADR on an optional native add-on.

## M2: Fakes and scenarios

**Scope:** R6, R11. R16 if time allows.

- `defineFake`, controls, the `fakes` and `fake` commands, call recording; the example's hand-written fakes become `defineFake` fakes with controls
- Scenario runner with YAML steps, optional steps, and structured failure output with artifacts

**Exit criteria**

- [ ] A scenario reproduces the planted race: it fails with `PLANT_RACE=1` and passes without it
- [ ] The same scenario, with clock steps marked optional, reaches the same final state on the headless and iOS targets
- [ ] 100 consecutive headless runs of every example scenario show 0 divergences

## M3: Agent interface

**Scope:** R13, R14, R17. Resolve Q3.

- `ironbird mcp`, with tools mirroring the CLI and screenshots returned as image content
- An agent skill that teaches the loop: describe the app, act headlessly, reproduce with a scenario, then escalate to a device check with evidence
- Agent setup documentation

**Exit criteria**

- [ ] In 5 fresh sessions, an agent given the skill and the report "orders sometimes complete with a zero total" reproduces the bug with a scenario, fixes it, and verifies the fix headlessly and on iOS with evidence, succeeding in at least 4 sessions without human steering
- [ ] Every "verified" claim from those sessions is spot-checked, and the false-claim rate is recorded as a baseline

## M4: Testing package

**Scope:** R18. Resolve Q6.

- Scenario runner for Vitest and Jest
- Model-based testing helper: random interleavings of commands, fake controls, and clock advances against a headless definition, checked against invariants
- Guide for pairing ironbird with React Native Testing Library

**Exit criteria**

- [ ] With the planted scenario removed, model-based testing finds the race within 1,000 runs for at least 9 of 10 seeds
- [ ] Mutation score ≥ 70% on the clock and tracker

## M5: Adapters and 0.1 release

**Scope:** R15, R19, R20. Close Q8.

- `@ironbird/xstate` and `@ironbird/redux`
- `examples/bare-redux`: a bare React Native app using Redux
- `doctor` and snapshots
- Publish 0.1.0 through the pipeline built in M0

**Exit criteria**

- [ ] A developer other than the author wires ironbird into a copy of `examples/bare-redux` that doesn't include it yet, using only the docs, in ≤ 1 day
- [ ] CI passes on the two most recent React Native minor versions and the current Expo SDK
- [ ] Zod 3 support question (Q8) closed, and the migration note published if support is dropped

## Later (P2)

Visual baselines and diffs. Event-stream parity comparison. React Navigation and Expo Router sync. Automatic device mapping. Clock control on device. Physical iOS screenshots through agent-device. Several apps per daemon session. Non-RN targets. Per-command MCP tools. Standard Schema support.
