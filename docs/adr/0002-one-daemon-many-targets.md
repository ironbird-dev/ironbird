# ADR-0002: One daemon, many targets, one protocol

**Status:** Accepted with amendment (2026-09-13)
**Date:** 2026-09-10
**Deciders:** Project maintainer

## Context

Agents invoke the CLI one command at a time, and each invocation is a new process. Headless mode needs app state, timers, subscriptions, in-flight effects, and fakes to survive between those invocations. Remote mode needs a stable endpoint for apps to connect to. Both modes should accept the same operations, so scenarios and agent habits carry over from one to the other.

## Decision

A single long-lived daemon, started with `ironbird serve`, hosts the headless target in-process and accepts remote targets over WebSocket. CLI invocations and the MCP server are thin HTTP clients of the daemon. Snapshot files (P1) complement the daemon for saving and restoring specific states, but they are not how state survives between calls.

## Options considered

### Option A: Long-lived daemon with pluggable targets

| Dimension | Assessment |
|---|---|
| Complexity | Medium: process lifecycle, ports, target registry |
| Latency per call | Low: the app stays loaded |
| Fidelity | High: effects, timers, and subscriptions live across calls |
| Scenario portability | High: one protocol for both modes |

**Pros:** Fast calls; real async behavior between steps; the MCP server is just another client; headless and remote results are directly comparable.

**Cons:** A background process to manage; state lives in memory.

### Option B: Stateless CLI with snapshot files

Each invocation loads a snapshot, rebuilds the app, applies one operation, and saves a new snapshot.

| Dimension | Assessment |
|---|---|
| Complexity | Low: no background process |
| Latency per call | High: the app is rebuilt every time |
| Fidelity | Low: in-flight effects, timers, and subscriptions can't span invocations |
| Scenario portability | Medium |

**Pros:** Simple mental model; every state is a file.

**Cons:** Loses exactly the async interleavings ironbird is meant to exercise; every target must implement persist and restore; no natural home for remote connections.

### Option C: Separate tools per mode

A test-runner-style tool for headless work and a separate tool for devices.

| Dimension | Assessment |
|---|---|
| Complexity | Medium, duplicated across two tools |
| Latency per call | Low |
| Fidelity | High |
| Scenario portability | Low: two vocabularies, and scenarios don't transfer |

**Pros:** Each tool can be optimized for its mode.

**Cons:** Double the concepts for agents and humans to learn; the headless-to-device handoff becomes a translation step.

## Trade-off analysis

Option B fails on fidelity, which is the property that matters most for reproducing timing bugs. Option C doubles the surface and breaks the "same scenario, any target" promise. Option A's cost is process lifecycle management, which is a well-understood problem with known mitigations.

## Consequences

- **Easier:** one mental model, one protocol, and comparable results across modes.
- **Harder:** daemon lifecycle, including port conflicts, stale daemons, and version skew between the CLI and the daemon; `reset` becomes important because state lives in memory.
- **Revisit:** auto-starting the daemon from the first CLI call; more than one app per daemon session (P2).

## Review (2026-09-13, M0 gate)

M0 shipped the daemon with the headless target hosted in-process and the CLI as an HTTP client of it; the WebSocket channel for remote targets is M1 scope, so "many targets" is still to be exercised.

**Amendment.** A daemon session serves one app. The session's app id comes from the headless target, or from the first bridge to connect when there is no headless entry, and a later `hello` with a different app id is rejected with `APP_MISMATCH` ([architecture.md §7.3](../architecture.md#73-connection-lifecycle), [protocol.md](../protocol.md)). Config, scenarios, and the headless entry are all per app, so several apps per session stays P2 as the "Revisit" line already anticipated.

## Action items

1. [ ] The CLI detects version skew with the daemon and reports it clearly (the daemon reports its protocol version from `status`; the CLI does not compare it yet, and `PROTOCOL_MISMATCH` is first raised by the bridge handshake in M1)
2. [x] `ironbird status` shows version, uptime, and targets
3. [ ] Port-in-use errors name the conflicting process when the platform allows it (M0 names the port and suggests `--port`; the process is not identified)
