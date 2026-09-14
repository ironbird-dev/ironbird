# ADR-0004: Zod 4 for command and control schemas

**Status:** Accepted with amendment (2026-09-13)
**Date:** 2026-09-10
**Deciders:** Project maintainer

## Context

Command and control schemas serve three consumers. The app and daemon need runtime validation. Agents and MCP tools need JSON Schema. App developers need TypeScript types inferred from the same definition. Because `@ironbird/core` runs inside dev builds, the schema library also ships in those bundles.

## Decision

Use Zod 4 as a peer dependency, with JSON Schema produced by Zod's built-in conversion. The registry keeps Zod behind a small internal interface, so another schema library can be supported later without changing the protocol.

## Options considered

### Option A: Zod 4

| Dimension | Assessment |
|---|---|
| Runtime validation | Yes |
| JSON Schema output | Built in |
| TypeScript inference | Excellent |
| Familiarity | High among React Native developers |

**Pros:** One dependency covers all three consumers; widely known, so integration docs stay short.

**Cons:** Couples users to Zod 4; transforms and refinements don't translate fully into JSON Schema.

### Option B: The Standard Schema interface (Zod, Valibot, ArkType, and others)

| Dimension | Assessment |
|---|---|
| Runtime validation | Yes, library-agnostic |
| JSON Schema output | Not part of the validation interface; needs a converter per library |
| TypeScript inference | Good |
| Familiarity | Growing |

**Pros:** Users bring the schema library they already use.

**Cons:** JSON Schema output, which agents depend on, would vary in quality from library to library.

### Option C: JSON Schema first, with a JSON Schema validator

| Dimension | Assessment |
|---|---|
| Runtime validation | Yes |
| JSON Schema output | Native |
| TypeScript inference | Needs extra tooling |
| Familiarity | Medium |

**Pros:** The agent-facing schema is the source of truth.

**Cons:** Verbose authoring; separate type tooling; a heavier validator in the app bundle.

### Option D: TypeScript types plus code generation

| Dimension | Assessment |
|---|---|
| Runtime validation | Generated |
| JSON Schema output | Generated |
| TypeScript inference | Native |
| Familiarity | Medium |

**Pros:** Plain TypeScript types as the source.

**Cons:** A build step and generated code in every app repository; slower iteration for agents adding commands.

## Trade-off analysis

Option A gives the best agent-facing output and the best authoring experience with the fewest dependencies. Option B becomes attractive once JSON Schema export is consistent across libraries, and the internal interface keeps that door open. Options C and D trade authoring speed for purity, which works against quick adoption.

## Consequences

- **Easier:** one schema per command drives validation, CLI help, documentation, and MCP tool definitions.
- **Harder:** apps on Zod 3 must upgrade or wait for a compatibility path (spec Q8); schemas with transforms or refinements produce JSON Schema that under-describes them.
- **Revisit:** Standard Schema support (P2); future Zod major versions.

## Review (2026-09-13, M0 gate)

M0 built the registry on Zod 4 and the checkout example declares its commands with it.

**Amendment.** `@ironbird/core` imports Zod as a type only. The registry validates through each schema's own parse method and produces JSON Schema through the schema's own `toJSONSchema` method, so core never evaluates the Zod module at load time and CLI client commands start without it. That structural dependency on two methods is the "small internal interface" the decision called for. The peer dependency floor is `zod@^4.2.0`, the first release with `toJSONSchema` on schema instances.

## Action items

1. [x] Internal schema interface in the registry that isolates Zod-specific calls (realized as the type-only import described above)
2. [x] `describe()` warns for schemas with features JSON Schema can't represent
3. [ ] Compatibility test of generated schemas as MCP tool input schemas (spec Q3)
