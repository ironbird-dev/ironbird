# ADR-0001: Commands-only agent surface

**Status:** Proposed
**Date:** 2026-09-10
**Deciders:** Project maintainer

## Context

Agents need a way to change app state and observe the result. The React Native ecosystem offers three approaches today. UI automation tools drive the rendered app through accessibility snapshots and gestures. Debugger-based tools evaluate JavaScript inside the running app, which lets an agent read or change anything. The third approach, which Shopify described for its native apps, exposes a declared set of app actions through a CLI.

ironbird's value depends on scenarios that replay identically on headless and remote targets, on schemas that agents can discover, and on being safe enough to leave in every dev build.

## Decision

Agents change state only through commands declared by the app and controls declared by fakes. Each has a schema and is validated where it is applied. The protocol has no operation that evaluates caller-supplied code, and none will be added.

## Options considered

### Option A: Declared commands and fake controls

| Dimension | Assessment |
|---|---|
| Complexity | Medium: apps declare commands and adapt a target |
| Agent ergonomics | High: discoverable names, JSON Schemas, structured validation errors |
| Reproducibility | High: every step is data that can be saved and replayed on any target |
| Safety | High: nothing runs that the app didn't declare |

**Pros:** Discoverable and self-documenting; scenario files are portable across targets; validation errors guide agents toward correct calls; small attack surface.

**Cons:** Integration work up front; an agent can't reach behavior the app hasn't exposed.

### Option B: Evaluate JavaScript in the running app

| Dimension | Assessment |
|---|---|
| Complexity | Low for apps: nothing to declare |
| Agent ergonomics | Mixed: total power, but the agent must learn app internals |
| Reproducibility | Low: snippets depend on internal names and module state, and don't run headlessly |
| Safety | Low: a code execution channel into every dev build |

**Pros:** Zero setup; convenient for one-off exploration. react-native-ai-devtools (ExecBro) is a current example, pairing a run-JS tool with logs, network, screenshots, and taps.

**Cons:** Encourages poking internals rather than exercising behavior; not portable between targets; hard to audit.

### Option C: UI automation only

| Dimension | Assessment |
|---|---|
| Complexity | Low for apps |
| Agent ergonomics | Medium: works on anything visible |
| Reproducibility | Medium: flows replay, but timing and layout make them brittle |
| Safety | High |

**Pros:** Already well served by agent-device, Maestro, and Detox.

**Cons:** Minutes per check; no headless mode; no way to script the outside world, such as reader disconnects or reordered server events.

## Trade-off analysis

Option A costs integration effort, and in exchange it provides the three properties ironbird exists for: speed through headless execution, determinism through replayable data, and safety. Option B's convenience directly undermines portability and safety. Option C is complementary rather than competing; it remains the device-level check that ironbird hands off to.

## Consequences

- **Easier:** scenario portability, MCP tool schemas, auditing what an agent did, and security review for teams adopting ironbird.
- **Harder:** agents are limited to exposed behavior, so teams must add commands when an agent needs something new.
- **Revisit:** a read-only inspection operation for debugging, if agent evals show that missing visibility, rather than missing actions, is the bottleneck. Teams that want code evaluation for exploratory debugging can run existing tools alongside ironbird.

## Action items

1. [ ] Add "no operation accepts executable code" to the protocol review checklist
2. [ ] Lint rule banning `eval` and `new Function` across the repository
3. [ ] Documentation on naming commands by user intent
