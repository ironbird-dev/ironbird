# M2 Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ironbird scenario run <path...>` parse YAML scenario files, validate them before anything runs, run each step as one existing daemon operation against a pinned target, report a structured `ScenarioResult`, and write a run directory of artifacts under the daemon's artifacts directory.

**Architecture:** Three files in `packages/cli/src/scenario/`. `parse.ts` turns a file into a validated `Scenario` with the `yaml` package for line numbers and Zod for shape, reusing core's `parseCondition` and the CLI's `parseDuration`. `run.ts` exports `runScenario(client, scenario, options)`: it sends `describe` first, pins the target from the reply envelope, decides support for every step from that description (never by catching `UNSUPPORTED`), and maps each step to one operation through the `DaemonClient`. `artifacts.ts` creates `runs/<stamp>-<slug>/`, captures the `events` and `fakeCalls` cursors at the start and after every `reset`, and collects the result, a copy of the scenario, the event log, the final state, and each fake's calls, best effort. Client commands do not load the config, so `serve` records `artifactsPath` in `daemon.json` and `resolveDaemon` returns an `artifactsDir`. No protocol change: the daemon gains no operation.

**Tech Stack:** `@ironbird/core` (`parseCondition`, `conditionHolds`, `suggestNames`, `IronbirdError`, `ScenarioResult`), `yaml` 2.9 (new `@ironbird/cli` dependency, design D8), `zod` 4 (already a cli dependency), `commander` 15, `node:fs/promises`, Vitest 5 `unit` project (the `serve` test is in the `serial` project).

**Spec:** [docs/superpowers/specs/2026-09-25-m2-fakes-and-scenarios-design.md](../specs/2026-09-25-m2-fakes-and-scenarios-design.md) §2 D5 to D8, §6, §8 (CLI unit tests for scenarios), §9, §10. Cross-plan names: [.superpowers/sdd/m2-contract.md](../../../.superpowers/sdd/m2-contract.md) (not committed).

**Prerequisites:** Plan 1 (`2026-09-25-m2-fakes.md`) provides the `fakeControl` and `fakeCalls` operations on the headless target and the `FakeCallsResult` type in core. Only Task 5 imports that type; every runner test uses a scripted `DaemonClient`, so nothing here needs plan 1's runtime code. Task 5's Interfaces block says what to do if plan 1 has not landed.

## Global Constraints

Copied from [AGENTS.md](../../../AGENTS.md) hard rules:

1. `@ironbird/core` imports only `zod`. No `react-native`, no `node:*` modules, no DOM or browser globals. It must run unmodified in Node and Hermes. Lint enforces this.
2. No arbitrary code execution anywhere. No `eval`, no `new Function`, and no protocol operation that runs caller-supplied code. Agents act only through declared commands and fake controls ([ADR-0001](../../adr/0001-commands-only-agent-surface.md)).
3. The bridge stays dev-only. `startBridge` must no-op when `__DEV__` is false unless `allowInNonDevBuilds` is set, and the bridge marker must stay referenced in the `hello` message so `ironbird verify-bundle` can detect it after minification. The marker constant is defined in `@ironbird/react-native` and nowhere else: `@ironbird/core` ships in release bundles, so the string must not appear in it or in any other package.
4. Validate every payload where it is applied, including inside the app. Never trust the daemon.
5. Protocol changes update [docs/protocol.md](../../protocol.md) in the same PR. Breaking changes bump `PROTOCOL_VERSION` and need an ADR.
6. Public API or CLI changes update [docs/api.md](../../api.md) or [docs/cli.md](../../cli.md) in the same PR and include a changeset.
7. New runtime dependencies in `core` or `react-native` need an ADR. New dependencies in `cli` need a one-line justification in the PR.
8. Errors that cross a package boundary are `IronbirdError` with a code from the protocol error table. No bare string throws.
9. Headless determinism is a feature. Library code and example app logic take time from the injected `Clock`, never from global `setTimeout`, `setInterval`, or `Date.now`. The bridge is library code too: it uses the `Clock` passed to `startBridge`, which defaults to the real clock. `requestAnimationFrame` is a rendering signal rather than a clock and may be used directly. Inside `@ironbird/core`, `clock.ts` and `scheduler.ts` are the only files that may use global timers or `Date.now`, and lint enforces that.

From the spec and the conventions:

- Every error that leaves a module is an `IronbirdError` with a code from the protocol error table. `INVALID_SCENARIO` is new in this plan and joins the table, `ERROR_CODES`, and the CLI's usage set (exit 2).
- CLI output is JSON when stdout is not a TTY or `--json` is passed, and its shapes must match docs/cli.md. `scenario run` prints one `ScenarioResult` per file as JSON lines in that mode.
- Durations are milliseconds in public APIs, the protocol, and MCP tools; only the CLI and scenario files accept `ms`, `s`, and `m` suffixes, and the parser turns them into milliseconds before the runner sees them.
- Doc updates and changesets land in the same change as the behavior they describe. The new `cli` dependency, `yaml`, is justified in the commit message that adds it (design D8).
- Node code in `@ironbird/cli` may use `Date.now` and global timers; the runner measures `durationMs` with `Date.now`.
- Commit messages are plain imperative subjects with no attribution trailers. Never commit `.superpowers/`.

---

## File Structure

```text
packages/core/src/
  errors.ts                       INVALID_SCENARIO in ERROR_CODES
  errors.test.ts                  the code count becomes 20
  protocol.ts                     ScenarioResult per spec §6
packages/cli/
  package.json                    yaml ^2.9.0
  src/cli/exit-codes.ts           INVALID_SCENARIO in the usage set
  src/cli/helpers.test.ts         exit code assertion
  src/scenario/parse.ts           parseScenario, loadScenarioFiles, Scenario, ScenarioStep, ScenarioIssue
  src/scenario/parse.test.ts
  src/scenario/artifacts.ts       run directory naming, cursors, best-effort collection
  src/scenario/artifacts.test.ts  slug and directory naming
  src/scenario/run.ts             runScenario, RunScenarioOptions
  src/scenario/run.test.ts        against a scripted DaemonClient
  src/scenario/format.ts          the TTY rendering of a ScenarioResult
  src/daemon-info.ts              artifactsPath
  src/daemon-info.test.ts         new: round trip and validation
  src/cli/client.ts               resolveDaemon returns artifactsDir
  src/cli/client.test.ts
  src/cli/commands/serve.ts       writes artifactsPath
  src/cli/commands/serve.test.ts  asserts it (serial project)
  src/cli/program.ts              scenario run; Context gains artifactsDir and json
  src/cli/program.test.ts
  src/index.ts                    new exports
docs/cli.md, docs/protocol.md
.changeset/m2-scenarios.md
```

---

### Task 1: `INVALID_SCENARIO` and the M2 `ScenarioResult`

**Files:**
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/src/errors.test.ts`
- Modify: `packages/core/src/protocol.ts` (the `ScenarioResult` interface)
- Modify: `packages/cli/src/cli/exit-codes.ts`
- Modify: `packages/cli/src/cli/helpers.test.ts`
- Modify: `docs/protocol.md` (§4.2 table, §5 types, §6 error table)
- Modify: `docs/cli.md` (exit codes table, output shapes)
- Create: `.changeset/m2-scenarios.md`

**Interfaces:**
- Consumes: `ERROR_CODES` and `ErrorCode` in `packages/core/src/errors.ts`; `ErrorShape` in `packages/core/src/protocol.ts`; the `USAGE` set in `packages/cli/src/cli/exit-codes.ts` (all exist today).
- Produces: `'INVALID_SCENARIO'` as an `ErrorCode`; `interface ScenarioResult { scenario: string; file: string; target: string; passed: boolean; durationMs: number; stepsRun: number; failedStep?: { index: number; step: unknown; repetition?: number; expected?: unknown; actual?: unknown; error?: ErrorShape }; skipped: number[]; artifacts: string | null; artifactErrors?: string[] }`; `exitCodeForError('INVALID_SCENARIO') === 2`. Tasks 2, 4, 5, and 7 use them.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/errors.test.ts`, replace the last test with:

```ts
  it('lists every documented code once', () => {
    expect(new Set(ERROR_CODES).size).toBe(20);
    expect(ERROR_CODES).toContain('APP_MISMATCH');
    expect(ERROR_CODES).toContain('INVALID_CONFIG');
    expect(ERROR_CODES).toContain('INVALID_SCENARIO');
    expect(PROTOCOL_VERSION).toBe(1);
  });
```

In `packages/cli/src/cli/helpers.test.ts`, inside `it('maps error codes to the documented exit codes', ...)`, add this line after the `INVALID_CONFIG` expectation:

```ts
    expect(exitCodeForError('INVALID_SCENARIO')).toBe(2);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/core/src/errors.test.ts packages/cli/src/cli/helpers.test.ts`
Expected: 2 failed. `errors.test.ts`: `expected 19 to be 20`. `helpers.test.ts`: `expected 1 to be 2`.

- [ ] **Step 3: Add the code and the result shape**

In `packages/core/src/errors.ts`, insert `'INVALID_SCENARIO',` after `'INVALID_CONFIG',` so the array reads:

```ts
export const ERROR_CODES = [
  'UNKNOWN_COMMAND',
  'INVALID_PAYLOAD',
  'DISPATCH_FAILED',
  'UNKNOWN_FAKE',
  'UNKNOWN_CONTROL',
  'WAIT_TIMEOUT',
  'UNSUPPORTED',
  'NO_TARGET',
  'AMBIGUOUS_TARGET',
  'TARGET_DISCONNECTED',
  'AMBIGUOUS_DEVICE',
  'SCREENSHOT_FAILED',
  'HEADLESS_LOAD_FAILED',
  'INVALID_CONFIG',
  'INVALID_SCENARIO',
  'CLOCK_RUNAWAY',
  'PROTOCOL_MISMATCH',
  'APP_MISMATCH',
  'UNAUTHORIZED',
  'INTERNAL',
] as const;
```

In `packages/core/src/protocol.ts`, replace the `ScenarioResult` interface (the last declaration in the file) with:

```ts
/**
 * The output of the CLI's scenario runner, one per scenario file. No daemon operation returns
 * it; it lives here so the M3 MCP server and `@ironbird/testing` can share the type.
 */
export interface ScenarioResult {
  /** The scenario's `name`. */
  scenario: string;
  /** Absolute path of the scenario file. */
  file: string;
  /** The target id the run was pinned to, from the first `describe`'s envelope. */
  target: string;
  passed: boolean;
  durationMs: number;
  /** Steps that ran, including a failed one and excluding skipped ones. */
  stepsRun: number;
  failedStep?: { index: number; step: unknown; repetition?: number; expected?: unknown; actual?: unknown; error?: ErrorShape };
  /** Indexes of optional steps skipped because the target can't run them. */
  skipped: number[];
  /** The run directory, or null when the caller turned artifacts off. */
  artifacts: string | null;
  /** Artifact files that could not be written, for example the state after a disconnect. */
  artifactErrors?: string[];
}
```

In `packages/cli/src/cli/exit-codes.ts`, replace the `USAGE` line with:

```ts
const USAGE: ReadonlySet<ErrorCode> = new Set(['AMBIGUOUS_TARGET', 'AMBIGUOUS_DEVICE', 'HEADLESS_LOAD_FAILED', 'INVALID_CONFIG', 'INVALID_SCENARIO', 'UNAUTHORIZED', 'PROTOCOL_MISMATCH', 'APP_MISMATCH']);
```

- [ ] **Step 4: Rebuild core and run the tests to verify they pass**

The CLI resolves `@ironbird/core` from its `dist`, so the new code must be built before the CLI's typecheck sees it.

Run: `pnpm --filter @ironbird/core build && pnpm exec vitest run --project unit packages/core/src/errors.test.ts packages/cli/src/cli/helpers.test.ts`
Expected: the build passes its verify step, then 2 files passed.

- [ ] **Step 5: Update the docs**

`docs/protocol.md`:

1. In §4.2, delete the row `| \`scenarioRun\` | \`file\`, \`target?\`, \`bail?\` | \`ScenarioResult\` |`. The following paragraphs already speak only of `screenshot` and `step`.
2. In §5, delete the `interface ScenarioResult { ... }` block (from `interface ScenarioResult {` through its closing `}` and the blank line after it) and add this sentence directly after the closing ` ``` ` of the types block. Plan 1 (Task 1 Step 7) has already inserted a paragraph about `pending` calls between that fence and "Capabilities say which operations...", so this sentence goes before plan 1's paragraph, as its own paragraph:

```md
`ScenarioResult`, the output of `ironbird scenario run`, is documented in [cli.md's output shapes](cli.md#output-shapes): no daemon operation returns it, and it is exported from `@ironbird/core` only so other packages can share the type.
```

3. In §6, insert this row after the `INVALID_CONFIG` row:

```md
| `INVALID_SCENARIO` | A scenario file fails to parse or validate; raised by the CLI before any operation is sent, never by a target | `{ file, issues }` |
```

`docs/cli.md`:

1. In the exit codes table, replace the `2` row with:

```md
| 2 | Usage or configuration error | Bad arguments, `AMBIGUOUS_TARGET`, `AMBIGUOUS_DEVICE`, `HEADLESS_LOAD_FAILED`, `INVALID_CONFIG`, `INVALID_SCENARIO`, `UNAUTHORIZED`, `PROTOCOL_MISMATCH`, `APP_MISMATCH` |
```

2. At the end of the "Output shapes" section, after the paragraph beginning "The CLI prints the daemon's `result` object", add:

````md
`scenario run` prints one scenario result per file. The type is exported from `@ironbird/core` so other packages can share it:

```ts
interface ScenarioResult {
  scenario: string;           // the scenario's name
  file: string;               // absolute path of the scenario file
  target: string;             // the target id the run was pinned to
  passed: boolean;
  durationMs: number;
  stepsRun: number;           // steps that ran, including a failed one, excluding skipped ones
  failedStep?: { index: number; step: unknown; repetition?: number; expected?: unknown; actual?: unknown; error?: ErrorShape };
  skipped: number[];          // indexes of optional steps skipped because the target can't run them
  artifacts: string | null;   // the run directory, or null when the caller turned artifacts off
  artifactErrors?: string[];  // artifact files that could not be written, for example after a disconnect
}
```
````

- [ ] **Step 6: Add the changeset**

`.changeset/m2-scenarios.md` (Task 7 rewrites this text once the command exists):

```md
---
"@ironbird/core": patch
"@ironbird/cli": patch
---
`INVALID_SCENARIO` joins the error codes and exits 2 in the CLI. `ScenarioResult` gains `file`, `stepsRun`, `failedStep.repetition`, `failedStep.expected`, and `artifactErrors`, and `artifacts` becomes nullable. The daemon-side `scenarioRun` operation, which no daemon ever implemented, leaves the protocol docs: scenarios run in the CLI.
```

- [ ] **Step 7: Lint, typecheck, and commit**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

```sh
git add packages/core/src/errors.ts packages/core/src/errors.test.ts packages/core/src/protocol.ts packages/cli/src/cli/exit-codes.ts packages/cli/src/cli/helpers.test.ts docs/protocol.md docs/cli.md .changeset/m2-scenarios.md
git commit -m "Add INVALID_SCENARIO and the M2 ScenarioResult shape"
```

---

### Task 2: Parse and validate a scenario file

**Files:**
- Modify: `packages/cli/package.json` (dependency)
- Modify: `pnpm-lock.yaml` (by `pnpm add`)
- Create: `packages/cli/src/scenario/parse.ts`
- Create: `packages/cli/src/scenario/parse.test.ts`

**Interfaces:**
- Consumes: `IronbirdError`, `isIronbirdError`, `messageOf`, `parseCondition`, `Condition` from `@ironbird/core` (exist); `UsageError`, `parseDuration` from `packages/cli/src/cli/durations.ts` (exist); `INVALID_SCENARIO` from Task 1; `yaml`'s `LineCounter`, `parseDocument`, `isMap`, `isSeq`, `isScalar`, `isNode`, `YAMLMap` (verified against `yaml@2.9.0`'s declarations: `parseDocument(source, { lineCounter })` sets `linePos` on each `doc.errors[i]`, every parsed node has `range: [start, valueEnd, nodeEnd]`, and `LineCounter.linePos(offset)` returns a 1-based `{ line, col }`); Zod 4's `z.strictObject`, `z.ZodError`, and the `unrecognized_keys` issue with its `keys` array.
- Produces: `export function parseScenario(source: string, file: string): Scenario` (throws `IronbirdError` `INVALID_SCENARIO` with details `{ file, issues: ScenarioIssue[] }`); `export interface ScenarioIssue { path: Array<string | number>; message: string; line?: number }`; `export type ScenarioStep` (a `kind`-discriminated union, each member carrying `optional: boolean` and `raw: Record<string, unknown>`, the step as written); `export interface Scenario { name: string; description?: string; target?: string; steps: ScenarioStep[] }`. Tasks 3, 4, and 7 use them.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add yaml@^2.9.0 --filter @ironbird/cli`
Expected: `packages/cli/package.json` gains `"yaml": "^2.9.0"` under `dependencies` (alphabetically after `ws`), and `pnpm-lock.yaml` links `yaml` to the `2.9.0` already in the lockfile. No download beyond the lockfile update.

- [ ] **Step 2: Write the failing tests**

`packages/cli/src/scenario/parse.test.ts`:

```ts
import { isIronbirdError } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { parseScenario, type ScenarioIssue } from './parse';

const FILE = '/app/ironbird/scenarios/x.yaml';

function failure(source: string): { message: string; details: { file: string; issues: ScenarioIssue[] } } {
  try {
    parseScenario(source, FILE);
  } catch (error) {
    if (isIronbirdError(error) && error.code === 'INVALID_SCENARIO') return { message: error.message, details: error.details as { file: string; issues: ScenarioIssue[] } };
    throw error;
  }
  throw new Error('expected INVALID_SCENARIO');
}

const EVERY_KIND = `name: Every kind
description: One of each
target: headless
steps:
  - send: cart.addItem
    payload: { sku: cut-45, qty: 1 }
    repeat: 2
    settle: false
  - send: cart.clear
  - fake: api
    control: emit
    payload: { event: payment.succeeded }
    optional: true
  - clock: 300ms
  - clock: 1500
    settle: false
  - wait: payment.status
    equals: awaitingServerEcho
    timeout: 2s
  - wait: order.id
    exists: true
  - expect: order.totalCents
    notEquals: 0
  - expect: receipt.text
    matches: ^Thank
  - screenshot: after-pay
    optional: true
  - reset: true
`;

describe('parseScenario', () => {
  it('parses every step kind, normalizing durations, defaults, and conditions, and keeps the raw step', () => {
    expect(parseScenario(EVERY_KIND, FILE)).toEqual({
      name: 'Every kind',
      description: 'One of each',
      target: 'headless',
      steps: [
        { kind: 'send', command: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, repeat: 2, settle: false, optional: false, raw: { send: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, repeat: 2, settle: false } },
        { kind: 'send', command: 'cart.clear', payload: {}, repeat: 1, settle: true, optional: false, raw: { send: 'cart.clear' } },
        { kind: 'fake', fake: 'api', control: 'emit', payload: { event: 'payment.succeeded' }, repeat: 1, settle: true, optional: true, raw: { fake: 'api', control: 'emit', payload: { event: 'payment.succeeded' }, optional: true } },
        { kind: 'clock', ms: 300, settle: true, optional: false, raw: { clock: '300ms' } },
        { kind: 'clock', ms: 1500, settle: false, optional: false, raw: { clock: 1500, settle: false } },
        { kind: 'wait', path: 'payment.status', condition: { equals: 'awaitingServerEcho' }, timeoutMs: 2_000, optional: false, raw: { wait: 'payment.status', equals: 'awaitingServerEcho', timeout: '2s' } },
        { kind: 'wait', path: 'order.id', condition: { exists: true }, timeoutMs: 5_000, optional: false, raw: { wait: 'order.id', exists: true } },
        { kind: 'expect', path: 'order.totalCents', condition: { notEquals: 0 }, optional: false, raw: { expect: 'order.totalCents', notEquals: 0 } },
        { kind: 'expect', path: 'receipt.text', condition: { matches: '^Thank' }, optional: false, raw: { expect: 'receipt.text', matches: '^Thank' } },
        { kind: 'screenshot', name: 'after-pay', optional: true, raw: { screenshot: 'after-pay', optional: true } },
        { kind: 'reset', optional: false, raw: { reset: true } },
      ],
    });
  });

  it('omits description and target when the file has none, and keeps YAML 1.2 strings such as on and yes', () => {
    const scenario = parseScenario('name: Minimal\nsteps:\n  - wait: flag\n    equals: on\n  - expect: other\n    equals: yes\n', FILE);
    expect(scenario).toEqual({
      name: 'Minimal',
      steps: [
        { kind: 'wait', path: 'flag', condition: { equals: 'on' }, timeoutMs: 5_000, optional: false, raw: { wait: 'flag', equals: 'on' } },
        { kind: 'expect', path: 'other', condition: { equals: 'yes' }, optional: false, raw: { expect: 'other', equals: 'yes' } },
      ],
    });
    expect('description' in scenario).toBe(false);
    expect('target' in scenario).toBe(false);
  });

  it('rejects an unknown step key with its path and line', () => {
    const { message, details } = failure('name: Typo\nsteps:\n  - send: cart.addItem\n    payloads: { qty: 1 }\n');
    expect(details).toEqual({ file: FILE, issues: [{ path: ['steps', 0, 'payloads'], message: 'unknown key payloads', line: 4 }] });
    expect(message).toBe(`Invalid scenario ${FILE}:4: steps.0.payloads: unknown key payloads`);
  });

  it('rejects an unknown top-level key, a missing name, and empty steps', () => {
    expect(failure('name: X\nsteps: []\nsteps2: []\n').details.issues).toEqual([
      { path: ['steps'], message: 'Too small: expected array to have >=1 items', line: 2 },
      { path: ['steps2'], message: 'unknown key steps2', line: 3 },
    ]);
    expect(failure('steps:\n  - reset: true\n').details.issues).toEqual([{ path: ['name'], message: 'Invalid input: expected string, received undefined', line: 1 }]);
  });

  it('requires exactly one step kind per step', () => {
    expect(failure('name: X\nsteps:\n  - optional: true\n  - send: a\n    clock: 1s\n').details.issues).toEqual([
      { path: ['steps', 0], message: 'expected exactly one of send, fake, clock, wait, expect, screenshot, reset, got none', line: 3 },
      { path: ['steps', 1], message: 'expected exactly one of send, fake, clock, wait, expect, screenshot, reset, got send and clock', line: 4 },
    ]);
  });

  it('validates conditions through parseCondition and reports them with the step line', () => {
    expect(failure('name: X\nsteps:\n  - wait: a\n  - expect: b\n    equals: 1\n    exists: true\n  - expect: c\n    matches: "("\n').details.issues).toEqual([
      { path: ['steps', 0], message: 'expected exactly one condition, got 0', line: 3 },
      { path: ['steps', 1], message: 'expected exactly one condition, got 2', line: 4 },
      { path: ['steps', 2, 'matches'], message: expect.stringContaining('Invalid regular expression'), line: 8 },
    ]);
    expect(failure('name: X\nsteps:\n  - wait: a\n    exists: maybe\n').details.issues).toEqual([{ path: ['steps', 0, 'exists'], message: 'Invalid input: expected boolean, received string', line: 4 }]);
  });

  it('validates durations with the CLI duration parser', () => {
    expect(failure('name: X\nsteps:\n  - clock: soon\n  - wait: a\n    exists: true\n    timeout: 2h\n').details.issues).toEqual([
      { path: ['steps', 0, 'clock'], message: 'Invalid duration "soon"; use a number with an optional ms, s, or m suffix', line: 3 },
      { path: ['steps', 1, 'timeout'], message: 'Invalid duration "2h"; use a number with an optional ms, s, or m suffix', line: 6 },
    ]);
  });

  it('rejects repeat below 1, reset other than true, and a payload-less control name', () => {
    expect(failure('name: X\nsteps:\n  - send: a\n    repeat: 0\n  - reset: false\n  - fake: api\n').details.issues).toEqual([
      { path: ['steps', 0, 'repeat'], message: 'Too small: expected number to be >=1', line: 4 },
      { path: ['steps', 1, 'reset'], message: 'Invalid input: expected true', line: 5 },
      { path: ['steps', 2, 'control'], message: 'Invalid input: expected string, received undefined', line: 6 },
    ]);
  });

  it('reports YAML syntax errors with the line the parser blames, and a non-mapping document', () => {
    const syntax = failure('name: [\n  oops\nsteps: []\n');
    expect(syntax.details.issues[0]).toMatchObject({ path: [], line: 3 });
    expect(syntax.details.issues[0]?.message).toContain('Flow sequence');
    expect(failure('just text\n').details.issues).toEqual([{ path: [], message: 'expected a mapping with name and steps', line: 1 }]);
    expect(failure('').details.issues).toEqual([{ path: [], message: 'expected a mapping with name and steps', line: 1 }]);
  });

  it('counts the extra issues in the message', () => {
    expect(failure('name: X\nsteps:\n  - clock: soon\n  - clock: later\n').message).toBe(`Invalid scenario ${FILE}:3: steps.0.clock: Invalid duration "soon"; use a number with an optional ms, s, or m suffix (and 1 more)`);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/scenario/parse.test.ts`
Expected: FAIL, the import of `./parse` cannot be resolved.

- [ ] **Step 4: Write the parser**

`packages/cli/src/scenario/parse.ts`:

```ts
import { IronbirdError, isIronbirdError, messageOf, parseCondition, type Condition } from '@ironbird/core';
import { LineCounter, isMap, isNode, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { z } from 'zod';
import { UsageError, parseDuration } from '../cli/durations';

/** One problem in a scenario file, as `INVALID_SCENARIO` reports it under `details.issues`. */
export interface ScenarioIssue {
  path: Array<string | number>;
  message: string;
  /** 1-based line in the file, when the problem maps to a node in it. */
  line?: number;
}

interface StepBase {
  /** Skip rather than fail when the target can't run this step (docs/cli.md, "Scenario files"). */
  optional: boolean;
  /** The step as written in the file, reported as `failedStep.step`. */
  raw: Record<string, unknown>;
}

export type ScenarioStep =
  | (StepBase & { kind: 'send'; command: string; payload: unknown; repeat: number; settle: boolean })
  | (StepBase & { kind: 'fake'; fake: string; control: string; payload: unknown; repeat: number; settle: boolean })
  | (StepBase & { kind: 'clock'; ms: number; settle: boolean })
  | (StepBase & { kind: 'wait'; path: string; condition: Condition; timeoutMs: number })
  | (StepBase & { kind: 'expect'; path: string; condition: Condition })
  | (StepBase & { kind: 'screenshot'; name: string })
  | (StepBase & { kind: 'reset' });

export interface Scenario {
  name: string;
  description?: string;
  target?: string;
  steps: ScenarioStep[];
}

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

const STEP_KINDS = ['send', 'fake', 'clock', 'wait', 'expect', 'screenshot', 'reset'] as const;
type StepKind = (typeof STEP_KINDS)[number];

const optional = z.boolean().optional();
const settle = z.boolean().optional();
const repeat = z.number().int().min(1).optional();
const payload = z.unknown().optional();
// A number is milliseconds; a string goes through the CLI's duration parser in `durationMs`.
const duration = z.union([z.number().nonnegative(), z.string().min(1)]);
const conditionKeys = { equals: z.unknown().optional(), notEquals: z.unknown().optional(), exists: z.boolean().optional(), matches: z.string().optional() };

// Strict, so a typo such as `payloads` fails at parse time instead of being ignored at run time.
const stepSchemas = {
  send: z.strictObject({ send: z.string().min(1), payload, repeat, settle, optional }),
  fake: z.strictObject({ fake: z.string().min(1), control: z.string().min(1), payload, repeat, settle, optional }),
  clock: z.strictObject({ clock: duration, settle, optional }),
  wait: z.strictObject({ wait: z.string(), ...conditionKeys, timeout: duration.optional(), optional }),
  expect: z.strictObject({ expect: z.string(), ...conditionKeys, optional }),
  screenshot: z.strictObject({ screenshot: z.string().min(1), optional }),
  reset: z.strictObject({ reset: z.literal(true), optional }),
};

const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  target: z.string().min(1).optional(),
  steps: z.array(z.record(z.string(), z.unknown())).min(1),
});

/** A problem found while normalizing one validated step; `path` is relative to the step. */
class StepIssue extends Error {
  constructor(
    readonly path: Array<string | number>,
    message: string,
  ) {
    super(message);
    this.name = 'StepIssue';
  }
}

function durationMs(value: number | string, key: string): number {
  if (typeof value === 'number') return Math.round(value);
  try {
    return parseDuration(value);
  } catch (error) {
    throw new StepIssue([key], error instanceof UsageError ? error.message : messageOf(error));
  }
}

/** Reads the condition keys through core's `parseCondition`, so scenarios and `waitFor` agree on what a condition is. */
function conditionOf(raw: Record<string, unknown>): Condition {
  try {
    return parseCondition(raw);
  } catch (error) {
    if (isIronbirdError(error) && error.code === 'INVALID_PAYLOAD') {
      const issue = (error.details as { issues?: Array<{ path: Array<string | number>; message: string }> } | undefined)?.issues?.[0];
      throw new StepIssue(issue?.path ?? [], issue?.message ?? error.message);
    }
    throw error;
  }
}

const normalizers: { [K in StepKind]: (raw: Record<string, unknown>) => ScenarioStep } = {
  send: (raw) => {
    const step = stepSchemas.send.parse(raw);
    return { kind: 'send', command: step.send, payload: step.payload === undefined ? {} : step.payload, repeat: step.repeat ?? 1, settle: step.settle ?? true, optional: step.optional ?? false, raw };
  },
  fake: (raw) => {
    const step = stepSchemas.fake.parse(raw);
    return { kind: 'fake', fake: step.fake, control: step.control, payload: step.payload === undefined ? {} : step.payload, repeat: step.repeat ?? 1, settle: step.settle ?? true, optional: step.optional ?? false, raw };
  },
  clock: (raw) => {
    const step = stepSchemas.clock.parse(raw);
    return { kind: 'clock', ms: durationMs(step.clock, 'clock'), settle: step.settle ?? true, optional: step.optional ?? false, raw };
  },
  wait: (raw) => {
    const step = stepSchemas.wait.parse(raw);
    return { kind: 'wait', path: step.wait, condition: conditionOf(raw), timeoutMs: step.timeout === undefined ? DEFAULT_WAIT_TIMEOUT_MS : durationMs(step.timeout, 'timeout'), optional: step.optional ?? false, raw };
  },
  expect: (raw) => {
    const step = stepSchemas.expect.parse(raw);
    return { kind: 'expect', path: step.expect, condition: conditionOf(raw), optional: step.optional ?? false, raw };
  },
  screenshot: (raw) => {
    const step = stepSchemas.screenshot.parse(raw);
    return { kind: 'screenshot', name: step.screenshot, optional: step.optional ?? false, raw };
  },
  reset: (raw) => {
    const step = stepSchemas.reset.parse(raw);
    return { kind: 'reset', optional: step.optional ?? false, raw };
  },
};

type Locator = (path: ReadonlyArray<string | number>) => number | undefined;

/**
 * Finds the 1-based line of the node at `path` in the parsed document. A map key resolves to the
 * key's own line; when the path runs past what the document has, the deepest node reached wins,
 * so an issue about a missing field points at the step that lacks it.
 */
function locator(root: YAMLMap, lines: LineCounter): Locator {
  return (path) => {
    let node: unknown = root;
    let located: unknown = root;
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(segment));
        if (!pair) break;
        located = pair.key;
        node = pair.value;
      } else if (isSeq(node)) {
        const item: unknown = node.items[Number(segment)];
        if (item === undefined) break;
        located = item;
        node = item;
      } else {
        break;
      }
    }
    const range = isNode(located) ? located.range : undefined;
    return range ? lines.linePos(range[0]).line : undefined;
  };
}

function withLine(issue: { path: Array<string | number>; message: string }, lineOf: Locator): ScenarioIssue {
  const line = lineOf(issue.path);
  return line === undefined ? issue : { ...issue, line };
}

/** Zod issues as scenario issues. An unknown-keys issue becomes one issue per key so each gets its own line. */
function fromZod(issues: ReadonlyArray<z.core.$ZodIssue>, prefix: ReadonlyArray<string | number>, lineOf: Locator): ScenarioIssue[] {
  const out: ScenarioIssue[] = [];
  for (const issue of issues) {
    const base = [...prefix, ...issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol')];
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push(withLine({ path: [...base, key], message: `unknown key ${key}` }, lineOf));
    } else {
      out.push(withLine({ path: base, message: issue.message }, lineOf));
    }
  }
  return out;
}

function invalid(file: string, issues: ScenarioIssue[]): IronbirdError {
  const first = issues[0];
  const where = first?.line === undefined ? '' : `:${first.line}`;
  const summary = first === undefined ? 'unknown problem' : first.path.length === 0 ? first.message : `${first.path.join('.')}: ${first.message}`;
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  return new IronbirdError('INVALID_SCENARIO', `Invalid scenario ${file}${where}: ${summary}${more}`, { file, issues });
}

/**
 * Turns scenario YAML into a validated `Scenario`, or throws `INVALID_SCENARIO` listing every
 * problem with its path and line. Payloads are not checked here: their schemas live in the app,
 * so an invalid payload fails its step at run time with `INVALID_PAYLOAD`.
 */
export function parseScenario(source: string, file: string): Scenario {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });
  if (doc.errors.length > 0) {
    throw invalid(
      file,
      doc.errors.map((error) => {
        const line = error.linePos?.[0]?.line;
        const message = error.message.split('\n')[0] ?? error.message;
        return line === undefined ? { path: [], message } : { path: [], message, line };
      }),
    );
  }
  const root = doc.contents;
  if (!isMap(root)) throw invalid(file, [{ path: [], message: 'expected a mapping with name and steps', line: 1 }]);
  const lineOf = locator(root, lines);
  const top = scenarioSchema.safeParse(doc.toJS());
  if (!top.success) throw invalid(file, fromZod(top.error.issues, [], lineOf));

  const issues: ScenarioIssue[] = [];
  const steps: ScenarioStep[] = [];
  top.data.steps.forEach((raw, index) => {
    const at = ['steps', index];
    const present = STEP_KINDS.filter((kind) => kind in raw);
    const kind = present[0];
    if (kind === undefined || present.length !== 1) {
      const got = present.length === 0 ? 'none' : present.join(' and ');
      issues.push(withLine({ path: at, message: `expected exactly one of ${STEP_KINDS.join(', ')}, got ${got}` }, lineOf));
      return;
    }
    try {
      steps.push(normalizers[kind](raw));
    } catch (error) {
      if (error instanceof z.ZodError) issues.push(...fromZod(error.issues, at, lineOf));
      else if (error instanceof StepIssue) issues.push(withLine({ path: [...at, ...error.path], message: error.message }, lineOf));
      else throw error;
    }
  });
  if (issues.length > 0) throw invalid(file, issues);

  return {
    name: top.data.name,
    ...(top.data.description === undefined ? {} : { description: top.data.description }),
    ...(top.data.target === undefined ? {} : { target: top.data.target }),
    steps,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/scenario/parse.test.ts`
Expected: 10 passed. If a Zod message differs from the literal in a test (Zod 4 minor versions have reworded messages), fix the test to the message Zod 4.6 prints, not the parser: the parser passes Zod's message through on purpose. The same goes for the YAML syntax test: `yaml` 2.9.0 blames line 3 (`Flow sequence in block collection must be sufficiently indented and end with a ] at line 3, column 1`) for the unclosed `name: [` fixture, which is what the test expects; a different `yaml` minor may move it.

- [ ] **Step 6: Lint, typecheck, and commit**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

```sh
git add packages/cli/package.json pnpm-lock.yaml packages/cli/src/scenario/parse.ts packages/cli/src/scenario/parse.test.ts
git commit -m "Parse and validate scenario files with yaml and zod" -m "New cli dependency: yaml ^2.9.0, the YAML 1.2 parser the M2 design picks in D8. It has no dependencies of its own, keeps on and yes as strings, reports line numbers for errors, and was already in the lockfile transitively."
```

---

### Task 3: Load scenario files and directories

**Files:**
- Modify: `packages/cli/src/scenario/parse.ts` (imports and one appended function)
- Modify: `packages/cli/src/scenario/parse.test.ts` (appended block)
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Consumes: `parseScenario` and `Scenario` from Task 2; `readFile`, `readdir`, `stat` from `node:fs/promises`.
- Produces: `export async function loadScenarioFiles(paths: string[], cwd: string): Promise<Array<{ file: string; scenario: Scenario }>>`, which resolves each path against `cwd`, expands a directory to its `*.yaml` and `*.yml` files in name order without recursing, parses every file before returning, and throws `INVALID_SCENARIO` for a missing path, an empty directory, or an invalid file. Task 7 and plan 3 use it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/scenario/parse.test.ts`. Replace its import lines with:

```ts
import { isIronbirdError } from '@ironbird/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenarioFiles, parseScenario, type ScenarioIssue } from './parse';
```

and add at the end of the file:

```ts
describe('loadScenarioFiles', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('expands directories to their yaml files in name order, resolves against cwd, and parses everything', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenarios-'));
    await mkdir(path.join(dir, 'scenarios/nested'), { recursive: true });
    await writeFile(path.join(dir, 'scenarios/b.yaml'), 'name: B\nsteps:\n  - reset: true\n');
    await writeFile(path.join(dir, 'scenarios/a.yml'), 'name: A\nsteps:\n  - reset: true\n');
    await writeFile(path.join(dir, 'scenarios/notes.txt'), 'not a scenario');
    await writeFile(path.join(dir, 'scenarios/nested/c.yaml'), 'name: C\nsteps:\n  - reset: true\n');
    await writeFile(path.join(dir, 'single.yaml'), 'name: Single\nsteps:\n  - reset: true\n');
    const loaded = await loadScenarioFiles(['scenarios', 'single.yaml'], dir);
    expect(loaded.map((entry) => [entry.file, entry.scenario.name])).toEqual([
      [path.join(dir, 'scenarios/a.yml'), 'A'],
      [path.join(dir, 'scenarios/b.yaml'), 'B'],
      [path.join(dir, 'single.yaml'), 'Single'],
    ]);
  });

  it('fails with INVALID_SCENARIO for a missing path or a directory without scenario files', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenarios-'));
    await mkdir(path.join(dir, 'empty'));
    const missing = await loadScenarioFiles(['nope.yaml'], dir).catch((error: unknown) => error);
    expect(isIronbirdError(missing) && missing.code).toBe('INVALID_SCENARIO');
    expect(isIronbirdError(missing) && missing.details).toEqual({ file: path.join(dir, 'nope.yaml'), issues: [{ path: [], message: 'no such file or directory' }] });
    const empty = await loadScenarioFiles(['empty'], dir).catch((error: unknown) => error);
    expect(isIronbirdError(empty) && empty.details).toEqual({ file: path.join(dir, 'empty'), issues: [{ path: [], message: 'no scenario files (*.yaml, *.yml) in directory' }] });
  });

  it('parses every file before returning, so one invalid file fails the whole load', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenarios-'));
    await writeFile(path.join(dir, 'a.yaml'), 'name: A\nsteps:\n  - reset: true\n');
    await writeFile(path.join(dir, 'b.yaml'), 'name: B\nsteps:\n  - reset: true\n    extra: 1\n');
    const error = await loadScenarioFiles([dir], dir).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('INVALID_SCENARIO');
    expect(isIronbirdError(error) && (error.details as { file: string }).file).toBe(path.join(dir, 'b.yaml'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/scenario/parse.test.ts`
Expected: 3 failed, `loadScenarioFiles is not a function`; the 10 parser tests still pass.

- [ ] **Step 3: Add the loader**

In `packages/cli/src/scenario/parse.ts`, replace the first import block with:

```ts
import { IronbirdError, isIronbirdError, messageOf, parseCondition, type Condition } from '@ironbird/core';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, isMap, isNode, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { z } from 'zod';
import { UsageError, parseDuration } from '../cli/durations';
```

and append at the end of the file:

```ts
const SCENARIO_FILE = /\.ya?ml$/i;

/**
 * Resolves `paths` against `cwd`, expands each directory to its `*.yaml` and `*.yml` files in
 * name order (no recursion), and parses every file before returning, so an authoring error in
 * any file costs nothing. A missing path or an empty directory is `INVALID_SCENARIO` too.
 */
export async function loadScenarioFiles(paths: string[], cwd: string): Promise<Array<{ file: string; scenario: Scenario }>> {
  const files: string[] = [];
  for (const entry of paths) {
    const resolved = path.resolve(cwd, entry);
    const info = await stat(resolved).catch(() => undefined);
    if (!info) throw new IronbirdError('INVALID_SCENARIO', `No such file or directory: ${resolved}`, { file: resolved, issues: [{ path: [], message: 'no such file or directory' }] });
    if (!info.isDirectory()) {
      files.push(resolved);
      continue;
    }
    const names = (await readdir(resolved)).filter((name) => SCENARIO_FILE.test(name)).sort();
    if (names.length === 0) {
      throw new IronbirdError('INVALID_SCENARIO', `No scenario files (*.yaml, *.yml) in ${resolved}`, { file: resolved, issues: [{ path: [], message: 'no scenario files (*.yaml, *.yml) in directory' }] });
    }
    files.push(...names.map((name) => path.join(resolved, name)));
  }
  const loaded: Array<{ file: string; scenario: Scenario }> = [];
  for (const file of files) loaded.push({ file, scenario: parseScenario(await readFile(file, 'utf8'), file) });
  return loaded;
}
```

In `packages/cli/src/index.ts`, add after the `TargetEvent` export line:

```ts
export { loadScenarioFiles, parseScenario } from './scenario/parse';
export type { Scenario, ScenarioIssue, ScenarioStep } from './scenario/parse';
```

- [ ] **Step 4: Run the tests to verify they pass, lint, typecheck, and commit**

Run: `pnpm exec vitest run --project unit packages/cli/src/scenario/parse.test.ts`
Expected: 13 passed.

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

```sh
git add packages/cli/src/scenario/parse.ts packages/cli/src/scenario/parse.test.ts packages/cli/src/index.ts
git commit -m "Load scenario files and directories in name order"
```

---

### Task 4: The runner

**Files:**
- Create: `packages/cli/src/scenario/artifacts.ts` (directory naming only; Task 5 replaces the file)
- Create: `packages/cli/src/scenario/artifacts.test.ts`
- Create: `packages/cli/src/scenario/run.ts`
- Create: `packages/cli/src/scenario/run.test.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Consumes: `DaemonClient` from `packages/cli/src/cli/client.ts` (`call<T>(op, params?, target?)` returns `{ target?: string; result: T }`; `rpc<T>` returns `result`); `IronbirdError`, `isIronbirdError`, `conditionHolds`, `suggestNames`, `toErrorShape`, and the types `Description`, `ScenarioResult`, `StepResult` from `@ironbird/core`; `Scenario`, `ScenarioStep` from Task 2; `ScenarioResult` from Task 1.
- Produces: `export interface RunScenarioOptions { file: string; target?: string; artifacts: string | false }`; `export async function runScenario(client: DaemonClient, scenario: Scenario, options: RunScenarioOptions): Promise<ScenarioResult>`; in `artifacts.ts`, `export function scenarioSlug(name: string): string`, `export function runDirectoryPath(root: string, name: string, now?: Date): string`, `export async function createRunDirectory(root: string, name: string): Promise<string>`. Tasks 5 and 7 and plan 3 use `runScenario`.

- [ ] **Step 1: Write the failing artifact-naming tests**

`packages/cli/src/scenario/artifacts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runDirectoryPath, scenarioSlug } from './artifacts';

describe('scenarioSlug', () => {
  it('lowercases, joins runs of non-alphanumerics with one dash, trims, and caps the length', () => {
    expect(scenarioSlug('Payment success arrives before order confirmation')).toBe('payment-success-arrives-before-order-confirmation');
    expect(scenarioSlug('  Reader: disconnect!! (mid-collection)  ')).toBe('reader-disconnect-mid-collection');
    expect(scenarioSlug('!!!')).toBe('scenario');
    expect(scenarioSlug('x'.repeat(80))).toHaveLength(60);
  });
});

describe('runDirectoryPath', () => {
  it('places the run under runs/ with a UTC millisecond stamp and the slug', () => {
    expect(runDirectoryPath('/app/.ironbird', 'Shot Me!', new Date('2026-09-25T18:04:12.345Z'))).toBe('/app/.ironbird/runs/2026-09-25T18-04-12-345Z-shot-me');
  });
});
```

- [ ] **Step 2: Write the failing runner tests**

`packages/cli/src/scenario/run.test.ts`:

```ts
import { IronbirdError, type Description } from '@ironbird/core';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DaemonClient } from '../cli/client';
import { parseScenario, type Scenario } from './parse';
import { runScenario } from './run';

interface Call {
  op: string;
  params: Record<string, unknown>;
  target: string | undefined;
}

type Responder = (params: Record<string, unknown>, call: Call) => unknown;

const settled = { idle: true, quiescent: false, waitedMs: 1, pending: [] };
const unsettled = { idle: false, quiescent: false, waitedMs: 5_000, pending: [{ kind: 'effect', label: 'api.load', ageMs: 5_000, fake: false }] };
const stepResult = (settle: unknown = settled) => ({ target: 'headless', rev: 1, path: '', state: {}, events: [], settle });

const description = (overrides: Partial<Description> = {}): Description => ({
  app: { id: 'com.example.checkout', platform: 'headless' },
  commands: {},
  fakes: { api: { controls: {} }, reader: { controls: {} } },
  capabilities: ['settle', 'events', 'fakes', 'clock', 'reset'],
  ...overrides,
});

/** A DaemonClient whose every operation is answered from `responses`; an Error value is thrown. */
function scripted(responses: Record<string, Responder | unknown>, options: { envelopeTarget?: string } = {}) {
  const calls: Call[] = [];
  const client: DaemonClient = {
    url: 'http://127.0.0.1:4567',
    async call<T>(op: string, params: Record<string, unknown> = {}, target?: string): Promise<{ target?: string; result: T }> {
      const call: Call = { op, params, target };
      calls.push(call);
      const responder = responses[op];
      if (responder === undefined) throw new Error(`no response for ${op}`);
      const result = typeof responder === 'function' ? (responder as Responder)(params, call) : responder;
      if (result instanceof Error) throw result;
      return { target: options.envelopeTarget ?? target ?? 'headless', result: result as T };
    },
    async rpc<T>(op: string, params?: Record<string, unknown>, target?: string): Promise<T> {
      return (await client.call<T>(op, params, target)).result;
    },
    async stream() {},
  };
  return { client, calls };
}

const load = (yaml: string): Scenario => parseScenario(yaml, '/app/s.yaml');
const run = (client: DaemonClient, scenario: Scenario, target?: string) => runScenario(client, scenario, { file: '/app/s.yaml', target, artifacts: false });

describe('runScenario', () => {
  it('pins the target from the describe envelope and passes it on every later operation', async () => {
    const { client, calls } = scripted({ describe: description({ app: { id: 'a', platform: 'ios' }, capabilities: ['settle', 'events'] }), dispatch: stepResult() }, { envelopeTarget: 'ios' });
    const result = await run(client, load('name: pin\nsteps:\n  - send: cart.clear\n'));
    expect(result).toEqual({ scenario: 'pin', file: '/app/s.yaml', target: 'ios', passed: true, durationMs: expect.any(Number), stepsRun: 1, skipped: [], artifacts: null });
    expect(calls.map((call) => [call.op, call.target])).toEqual([
      ['describe', undefined],
      ['dispatch', 'ios'],
    ]);
  });

  it('sends describe to the override, else the scenario target, else no target', async () => {
    const override = scripted({ describe: description(), getState: { rev: 1, path: 'a', value: 1 } });
    await run(override.client, load('name: t\ntarget: headless\nsteps:\n  - expect: a\n    equals: 1\n'), 'ios');
    expect(override.calls[0]?.target).toBe('ios');
    const own = scripted({ describe: description(), getState: { rev: 1, path: 'a', value: 1 } });
    await run(own.client, load('name: t\ntarget: headless\nsteps:\n  - expect: a\n    equals: 1\n'));
    expect(own.calls[0]?.target).toBe('headless');
    const none = scripted({ describe: description(), getState: { rev: 1, path: 'a', value: 1 } });
    await run(none.client, load('name: t\nsteps:\n  - expect: a\n    equals: 1\n'));
    expect(none.calls[0]?.target).toBeUndefined();
  });

  it('maps every step kind to its operation with the parsed parameters', async () => {
    const { client, calls } = scripted(
      {
        describe: description({ app: { id: 'a', platform: 'ios' } }),
        dispatch: stepResult(),
        fakeControl: stepResult(),
        clockAdvance: { ...stepResult(), now: 300 },
        waitFor: { rev: 2, path: 'payment.status', value: 'awaitingServerEcho', waitedMs: 3 },
        getState: { rev: 2, path: 'order.totalCents', value: 4_500 },
        screenshot: { path: '/x.png', device: 'SIM-1', capturedAt: 1 },
        reset: { rev: 0, path: '', value: {} },
      },
      { envelopeTarget: 'ios' },
    );
    const scenario = load(
      [
        'name: every kind',
        'steps:',
        '  - send: cart.addItem',
        '    payload: { sku: cut-45, qty: 1 }',
        '  - fake: api',
        '    control: emit',
        '    payload: { event: payment.succeeded }',
        '    settle: false',
        '  - clock: 300ms',
        '  - wait: payment.status',
        '    equals: awaitingServerEcho',
        '    timeout: 2s',
        '  - expect: order.totalCents',
        '    equals: 4500',
        '  - screenshot: receipt',
        '  - reset: true',
        '',
      ].join('\n'),
    );
    const result = await run(client, scenario);
    expect(result).toMatchObject({ passed: true, stepsRun: 7, skipped: [], target: 'ios' });
    expect(calls.map((call) => [call.op, call.params])).toEqual([
      ['describe', {}],
      ['dispatch', { name: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, settle: true }],
      ['fakeControl', { fake: 'api', control: 'emit', payload: { event: 'payment.succeeded' }, settle: false }],
      ['clockAdvance', { ms: 300, settle: true }],
      ['waitFor', { path: 'payment.status', equals: 'awaitingServerEcho', timeoutMs: 2_000 }],
      ['getState', { path: 'order.totalCents' }],
      ['screenshot', {}],
      ['reset', {}],
    ]);
    expect(calls.every((call) => call.target === 'ios' || call.op === 'describe')).toBe(true);
  });

  it('fails an unsupported step with UNSUPPORTED before sending anything, and skips optional ones', async () => {
    const remote = description({ app: { id: 'a', platform: 'ios' }, fakes: {}, capabilities: ['settle', 'events'] });
    const { client, calls } = scripted({ describe: remote, dispatch: stepResult() }, { envelopeTarget: 'ios' });
    const result = await run(client, load('name: s\nsteps:\n  - clock: 1s\n    optional: true\n  - reset: true\n    optional: true\n  - fake: api\n    control: emit\n    optional: true\n  - send: cart.clear\n  - clock: 1s\n  - send: cart.clear\n'));
    expect(result).toMatchObject({ passed: false, stepsRun: 1, skipped: [0, 1, 2] });
    expect(result.failedStep).toEqual({ index: 4, step: { clock: '1s' }, error: { code: 'UNSUPPORTED', message: 'Target ios does not support clockAdvance', details: { op: 'clockAdvance', target: 'ios' } } });
    expect(calls.map((call) => call.op)).toEqual(['describe', 'dispatch']);

    const headless = scripted({ describe: description() });
    const shot = await run(headless.client, load('name: s\nsteps:\n  - screenshot: a\n    optional: true\n  - screenshot: b\n'));
    expect(shot).toMatchObject({ passed: false, stepsRun: 0, skipped: [0], failedStep: { index: 1, step: { screenshot: 'b' }, error: { code: 'UNSUPPORTED', details: { op: 'screenshot', target: 'headless' } } } });
    expect(headless.calls.map((call) => call.op)).toEqual(['describe']);
  });

  it('fails a fake step naming a fake the target lacks with UNKNOWN_FAKE and suggestions, or skips it when optional', async () => {
    const { client, calls } = scripted({ describe: description() });
    const result = await run(client, load('name: f\nsteps:\n  - fake: apii\n    control: emit\n'));
    expect(result.failedStep).toEqual({ index: 0, step: { fake: 'apii', control: 'emit' }, error: { code: 'UNKNOWN_FAKE', message: 'Target headless has no fake apii', details: { fake: 'apii', available: ['api', 'reader'], suggestions: ['api', 'reader'] } } });
    expect(calls.map((call) => call.op)).toEqual(['describe']);
    const optional = await run(client, load('name: f\nsteps:\n  - fake: apii\n    control: emit\n    optional: true\n'));
    expect(optional).toMatchObject({ passed: true, stepsRun: 0, skipped: [0] });
  });

  it('fails a send, fake, or clock step that ends neither idle nor quiescent unless settle is false', async () => {
    const responses = { describe: description(), dispatch: stepResult(unsettled), fakeControl: stepResult(unsettled), clockAdvance: { ...stepResult(unsettled), now: 5 } };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['- send: a', { send: 'a' }],
      ['- fake: api\n    control: emit', { fake: 'api', control: 'emit' }],
      ['- clock: 5ms', { clock: '5ms' }],
    ];
    for (const [yaml, raw] of cases) {
      const { client } = scripted(responses);
      const result = await run(client, load(`name: u\nsteps:\n  ${yaml}\n  - send: never\n`));
      expect(result.failedStep).toEqual({ index: 0, step: raw, actual: { settle: unsettled } });
      expect(result.stepsRun).toBe(1);
    }
    const optedOut = scripted(responses);
    const result = await run(optedOut.client, load('name: u\nsteps:\n  - send: a\n    settle: false\n  - fake: api\n    control: emit\n    settle: false\n  - clock: 5ms\n    settle: false\n'));
    expect(result.passed).toBe(true);
    expect(optedOut.calls.slice(1).map((call) => call.params['settle'])).toEqual([false, false, false]);
    const quiescent = scripted({ describe: description(), dispatch: stepResult({ ...unsettled, quiescent: true }) });
    expect((await run(quiescent.client, load('name: q\nsteps:\n  - send: a\n'))).passed).toBe(true);
  });

  it('runs a repeated step that many times and reports the repetition that failed', async () => {
    let dispatches = 0;
    const { client, calls } = scripted({
      describe: description(),
      dispatch: () => {
        dispatches += 1;
        return dispatches === 2 ? new IronbirdError('DISPATCH_FAILED', 'boom', { name: 'a', message: 'boom' }) : stepResult();
      },
    });
    const result = await run(client, load('name: r\nsteps:\n  - send: a\n    repeat: 3\n'));
    expect(result.failedStep).toEqual({ index: 0, step: { send: 'a', repeat: 3 }, repetition: 2, error: { code: 'DISPATCH_FAILED', message: 'boom', details: { name: 'a', message: 'boom' } } });
    expect(calls.filter((call) => call.op === 'dispatch')).toHaveLength(2);
    expect(result.stepsRun).toBe(1);

    const ok = scripted({ describe: description(), fakeControl: stepResult() });
    const passed = await run(ok.client, load('name: r\nsteps:\n  - fake: api\n    control: emit\n    repeat: 2\n'));
    expect(passed.passed).toBe(true);
    expect(ok.calls.filter((call) => call.op === 'fakeControl')).toHaveLength(2);

    let controls = 0;
    const unsettledThird = scripted({
      describe: description(),
      fakeControl: () => {
        controls += 1;
        return controls === 3 ? stepResult(unsettled) : stepResult();
      },
    });
    const third = await run(unsettledThird.client, load('name: r\nsteps:\n  - fake: api\n    control: emit\n    repeat: 3\n'));
    expect(third.failedStep).toEqual({ index: 0, step: { fake: 'api', control: 'emit', repeat: 3 }, repetition: 3, actual: { settle: unsettled } });
    expect(unsettledThird.calls.filter((call) => call.op === 'fakeControl')).toHaveLength(3);
  });

  it('reports a wait timeout and a failed expect with expected and actual, and any other error as its shape', async () => {
    const timeout = scripted({ describe: description(), waitFor: new IronbirdError('WAIT_TIMEOUT', 'nope', { path: 'payment.status', value: 'collecting', pending: [] }) });
    const waited = await run(timeout.client, load('name: w\nsteps:\n  - wait: payment.status\n    equals: awaitingServerEcho\n  - send: never\n'));
    expect(waited.failedStep).toEqual({ index: 0, step: { wait: 'payment.status', equals: 'awaitingServerEcho' }, expected: { equals: 'awaitingServerEcho' }, actual: 'collecting' });
    expect(waited).toMatchObject({ passed: false, stepsRun: 1 });
    expect(timeout.calls.map((call) => call.op)).toEqual(['describe', 'waitFor']);

    const mismatch = scripted({ describe: description(), getState: { rev: 3, path: 'order.totalCents', value: 0 } });
    const expected = await run(mismatch.client, load('name: e\nsteps:\n  - expect: order.totalCents\n    equals: 4500\n'));
    expect(expected.failedStep).toEqual({ index: 0, step: { expect: 'order.totalCents', equals: 4500 }, expected: { equals: 4500 }, actual: 0 });

    const invalid = scripted({ describe: description(), dispatch: new IronbirdError('INVALID_PAYLOAD', 'bad', { name: 'cart.addItem', issues: [] }) });
    const errored = await run(invalid.client, load('name: i\nsteps:\n  - send: cart.addItem\n    payload: { qty: 0 }\n'));
    expect(errored.failedStep).toEqual({ index: 0, step: { send: 'cart.addItem', payload: { qty: 0 } }, error: { code: 'INVALID_PAYLOAD', message: 'bad', details: { name: 'cart.addItem', issues: [] } } });

    const gone = scripted({ describe: description(), waitFor: new IronbirdError('TARGET_DISCONNECTED', 'gone', { target: 'headless', op: 'waitFor' }) });
    const disconnected = await run(gone.client, load('name: g\nsteps:\n  - wait: a\n    exists: true\n'));
    expect(disconnected.failedStep).toEqual({ index: 0, step: { wait: 'a', exists: true }, error: { code: 'TARGET_DISCONNECTED', message: 'gone', details: { target: 'headless', op: 'waitFor' } } });
  });

  it('rejects with the describe error itself when the initial describe fails', async () => {
    const { client } = scripted({ describe: new IronbirdError('NO_TARGET', 'No target is connected or configured', { available: [] }) });
    await expect(run(client, load('name: d\nsteps:\n  - send: a\n'))).rejects.toMatchObject({ code: 'NO_TARGET' });
  });

  it('creates the run directory under <artifacts>/runs and names screenshots by step index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ironbird-runs-'));
    try {
      const { client, calls } = scripted(
        {
          describe: description({ app: { id: 'a', platform: 'ios' }, fakes: {}, capabilities: ['settle', 'events'] }),
          screenshot: { path: '/x.png', device: 'SIM-1', capturedAt: 1 },
          events: { events: [], nextSeq: 0, truncated: false },
          getState: { rev: 0, path: '', value: {} },
        },
        { envelopeTarget: 'ios' },
      );
      const result = await runScenario(client, load('name: Shot Me!\nsteps:\n  - screenshot: receipt\n'), { file: '/app/s.yaml', artifacts: root });
      const dir = result.artifacts as string;
      expect(path.dirname(dir)).toBe(path.join(root, 'runs'));
      expect(path.basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-shot-me$/);
      expect((await stat(dir)).isDirectory()).toBe(true);
      expect(calls.find((call) => call.op === 'screenshot')).toEqual({ op: 'screenshot', params: { out: path.join(dir, '0-receipt.png') }, target: 'ios' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

The `events` and `getState` responders in the last test are unused until Task 5 adds artifact collection; they are here so that task changes no test.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/scenario/artifacts.test.ts packages/cli/src/scenario/run.test.ts`
Expected: FAIL, the imports of `./artifacts` and `./run` cannot be resolved.

- [ ] **Step 4: Write the directory naming**

`packages/cli/src/scenario/artifacts.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const SLUG_MAX = 60;

/** A filesystem-safe form of a scenario name: lowercase, dashes for anything else, at most 60 characters. */
export function scenarioSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug === '' ? 'scenario' : slug;
}

/** `<root>/runs/<UTC stamp with milliseconds>-<slug>`, the stamp with `:` and `.` replaced so it is a valid name everywhere. */
export function runDirectoryPath(root: string, name: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.resolve(root, 'runs', `${stamp}-${scenarioSlug(name)}`);
}

export async function createRunDirectory(root: string, name: string): Promise<string> {
  const dir = runDirectoryPath(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}
```

- [ ] **Step 5: Write the runner**

`packages/cli/src/scenario/run.ts`:

```ts
import { IronbirdError, conditionHolds, isIronbirdError, suggestNames, toErrorShape, type Description, type ScenarioResult, type StepResult } from '@ironbird/core';
import path from 'node:path';
import type { DaemonClient } from '../cli/client';
import { createRunDirectory } from './artifacts';
import type { Scenario, ScenarioStep } from './parse';

export interface RunScenarioOptions {
  /** Fills `ScenarioResult.file`; the artifacts include a copy of the file at this path. */
  file: string;
  /** Overrides the scenario's own `target`. With neither, the daemon picks its default. */
  target?: string;
  /** The artifacts root the run directory goes under, or `false` to write nothing. */
  artifacts: string | false;
}

type FailedStep = NonNullable<ScenarioResult['failedStep']>;
type Failure = Omit<FailedStep, 'index' | 'step'>;

/** Stops the run with a structured failure. Thrown only inside `runScenario`, which turns it into `failedStep`. */
class StepFailed extends Error {
  constructor(readonly failure: Failure) {
    super('scenario step failed');
    this.name = 'StepFailed';
  }
}

interface Support {
  platform: string;
  capabilities: ReadonlySet<string>;
  fakes: string[];
}

/**
 * The error a step would fail with on this target, decided from `describe` before the step runs
 * (design D7, so a skipped step never half-runs), or undefined when the target supports it.
 */
function blocker(step: ScenarioStep, support: Support, target: string): IronbirdError | undefined {
  const needs = (op: string, capability: string): IronbirdError | undefined =>
    support.capabilities.has(capability) ? undefined : new IronbirdError('UNSUPPORTED', `Target ${target} does not support ${op}`, { op, target });
  switch (step.kind) {
    case 'send':
    case 'wait':
    case 'expect':
      return undefined;
    case 'clock':
      return needs('clockAdvance', 'clock');
    case 'reset':
      return needs('reset', 'reset');
    case 'screenshot':
      return support.platform === 'headless' ? new IronbirdError('UNSUPPORTED', `Target ${target} has no screen to capture`, { op: 'screenshot', target }) : undefined;
    case 'fake': {
      const missing = needs('fakeControl', 'fakes');
      if (missing) return missing;
      if (support.fakes.includes(step.fake)) return undefined;
      return new IronbirdError('UNKNOWN_FAKE', `Target ${target} has no fake ${step.fake}`, { fake: step.fake, available: support.fakes, suggestions: suggestNames(step.fake, support.fakes) });
    }
  }
}

/**
 * Runs a mutating step `times` times. A step that ends neither idle nor quiescent fails the
 * scenario (design D6) unless it opted out with `settle: false`. A failure names the repetition
 * when the step repeats.
 */
async function repeated(times: number, settle: boolean, operation: () => Promise<StepResult>): Promise<void> {
  for (let repetition = 1; repetition <= times; repetition += 1) {
    const which = times > 1 ? { repetition } : {};
    let result: StepResult;
    try {
      result = await operation();
    } catch (error) {
      throw new StepFailed({ ...which, error: toErrorShape(error) });
    }
    const outcome = result.settle;
    if (settle && outcome !== null && !outcome.idle && !outcome.quiescent) throw new StepFailed({ ...which, actual: { settle: outcome } });
  }
}

async function runStep(client: DaemonClient, target: string, step: ScenarioStep, index: number, runDir: string | null): Promise<void> {
  switch (step.kind) {
    case 'send':
      return repeated(step.repeat, step.settle, () => client.rpc<StepResult>('dispatch', { name: step.command, payload: step.payload, settle: step.settle }, target));
    case 'fake':
      return repeated(step.repeat, step.settle, () => client.rpc<StepResult>('fakeControl', { fake: step.fake, control: step.control, payload: step.payload, settle: step.settle }, target));
    case 'clock':
      return repeated(1, step.settle, () => client.rpc<StepResult>('clockAdvance', { ms: step.ms, settle: step.settle }, target));
    case 'wait':
      try {
        await client.rpc('waitFor', { path: step.path, ...step.condition, timeoutMs: step.timeoutMs }, target);
      } catch (error) {
        if (isIronbirdError(error) && error.code === 'WAIT_TIMEOUT') {
          throw new StepFailed({ expected: step.condition, actual: (error.details as { value?: unknown } | undefined)?.value });
        }
        throw error;
      }
      return;
    case 'expect': {
      const { value } = await client.rpc<{ value: unknown }>('getState', { path: step.path }, target);
      if (!conditionHolds(value, step.condition)) throw new StepFailed({ expected: step.condition, actual: value });
      return;
    }
    case 'screenshot':
      await client.rpc('screenshot', runDir === null ? {} : { out: path.join(runDir, `${index}-${step.name}.png`) }, target);
      return;
    case 'reset':
      await client.rpc('reset', {}, target);
      return;
  }
}

/**
 * Runs one scenario against the daemon: `describe` first, whose envelope pins the target for
 * every later operation, then each step as one operation. Stops at the first failing step. A
 * failure of the initial `describe` is thrown as is, so the caller can exit with its own code;
 * everything after that becomes a `ScenarioResult`.
 */
export async function runScenario(client: DaemonClient, scenario: Scenario, options: RunScenarioOptions): Promise<ScenarioResult> {
  const started = Date.now();
  const requested = options.target ?? scenario.target;
  const described = await client.call<Description>('describe', {}, requested);
  const target = described.target ?? requested;
  if (target === undefined) throw new IronbirdError('INTERNAL', 'The daemon did not report which target answered describe', { message: 'describe envelope has no target' });
  const support: Support = { platform: described.result.app.platform, capabilities: new Set(described.result.capabilities), fakes: Object.keys(described.result.fakes) };
  const runDir = options.artifacts === false ? null : await createRunDirectory(options.artifacts, scenario.name);

  const skipped: number[] = [];
  let stepsRun = 0;
  let failedStep: FailedStep | undefined;
  for (const [index, step] of scenario.steps.entries()) {
    const blocked = blocker(step, support, target);
    if (blocked) {
      if (step.optional) {
        skipped.push(index);
        continue;
      }
      failedStep = { index, step: step.raw, error: toErrorShape(blocked) };
      break;
    }
    stepsRun += 1;
    try {
      await runStep(client, target, step, index, runDir);
    } catch (error) {
      failedStep = { index, step: step.raw, ...(error instanceof StepFailed ? error.failure : { error: toErrorShape(error) }) };
      break;
    }
  }

  return {
    scenario: scenario.name,
    file: options.file,
    target,
    passed: failedStep === undefined,
    durationMs: Date.now() - started,
    stepsRun,
    ...(failedStep === undefined ? {} : { failedStep }),
    skipped,
    artifacts: runDir,
  };
}
```

In `packages/cli/src/index.ts`, add after the `Scenario` type export line from Task 3:

```ts
export { runScenario } from './scenario/run';
export type { RunScenarioOptions } from './scenario/run';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/scenario/artifacts.test.ts packages/cli/src/scenario/run.test.ts`
Expected: 12 passed (2 in `artifacts.test.ts`, 10 in `run.test.ts`).

- [ ] **Step 7: Lint, typecheck, and commit**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

```sh
git add packages/cli/src/scenario/artifacts.ts packages/cli/src/scenario/artifacts.test.ts packages/cli/src/scenario/run.ts packages/cli/src/scenario/run.test.ts packages/cli/src/index.ts
git commit -m "Run scenarios step by step through the daemon client"
```

---

### Task 5: Artifacts

**Files:**
- Modify: `packages/cli/src/scenario/artifacts.ts` (whole file)
- Modify: `packages/cli/src/scenario/run.ts` (four exact edits)
- Modify: `packages/cli/src/scenario/run.test.ts` (appended block)

**Interfaces:**
- Consumes: `FakeCallsResult` from `@ironbird/core` (`{ calls: FakeCall[]; nextSeq: number; truncated: boolean }`, produced by plan 1, task "call log"), `RecordedEvent`, `Description`, `ScenarioResult`, `messageOf` from `@ironbird/core`; the `events` operation (`{ since?, limit? }` returning `{ events, nextSeq, truncated }`, exists on both targets today) and the `fakeCalls` operation (`{ fake, since?, limit? }`, plan 1); `DaemonClient`; `scenarioSlug`, `runDirectoryPath`, `createRunDirectory` from Task 4 (kept). **Dependency on plan 1:** the controller runs plan 1 before this task so `FakeCallsResult` is exported from core's `dist`. If it is not, do not define a look-alike type here; stop and report, because the cursor semantics (`nextSeq` with `limit: 0` equals the last sequence number, as `EventRecorder.since` does) are what this task relies on.
- Produces: `export interface RunArtifacts { readonly dir: string; capture(): Promise<void>; collect(result: ScenarioResult): Promise<ScenarioResult> }`; `export async function createRunArtifacts(options: { root: string; scenario: Scenario; file: string; client: DaemonClient; target: string; description: Description }): Promise<RunArtifacts>`. Only `run.ts` uses them.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/scenario/run.test.ts`. Replace its `node:fs/promises` import with:

```ts
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
```

and replace the vitest import with:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
```

Then add at the end of the file:

```ts
describe('runScenario artifacts', () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ironbird-artifacts-'));
    file = path.join(root, 'happy.yaml');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the result, a copy of the scenario, and the events, state, and calls recorded after the run started', async () => {
    await writeFile(file, 'name: Happy path\nsteps:\n  - send: cart.clear\n');
    const { client, calls } = scripted({
      describe: description(),
      dispatch: stepResult(),
      events: (params: Record<string, unknown>) => (params['limit'] === 0 ? { events: [], nextSeq: 7, truncated: false } : { events: [{ seq: 8, t: 1, source: 'cart', name: 'cleared' }], nextSeq: 8, truncated: false }),
      fakeCalls: (params: Record<string, unknown>) =>
        params['limit'] === 0
          ? { calls: [], nextSeq: params['fake'] === 'api' ? 3 : 0, truncated: false }
          : { calls: [{ seq: 4, t: 1, fake: params['fake'], method: 'submit', args: [], outcome: 'returned' }], nextSeq: 4, truncated: false },
      getState: { rev: 1, path: '', value: { cart: { items: [] } } },
    });
    const result = await runScenario(client, parseScenario(await readFile(file, 'utf8'), file), { file, artifacts: root });
    const dir = result.artifacts as string;
    expect(result.passed).toBe(true);
    expect(result.artifactErrors).toBeUndefined();
    expect((await readdir(dir)).sort()).toEqual(['calls', 'events.jsonl', 'happy.yaml', 'result.json', 'state.json']);
    expect(JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'))).toEqual(result);
    expect(await readFile(path.join(dir, 'happy.yaml'), 'utf8')).toBe('name: Happy path\nsteps:\n  - send: cart.clear\n');
    expect(await readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":8,"t":1,"source":"cart","name":"cleared"}\n');
    expect(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))).toEqual({ cart: { items: [] } });
    expect(JSON.parse(await readFile(path.join(dir, 'calls/api.json'), 'utf8'))).toEqual([{ seq: 4, t: 1, fake: 'api', method: 'submit', args: [], outcome: 'returned' }]);
    expect(JSON.parse(await readFile(path.join(dir, 'calls/reader.json'), 'utf8'))).toEqual([{ seq: 4, t: 1, fake: 'reader', method: 'submit', args: [], outcome: 'returned' }]);
    expect(calls.map((call) => [call.op, call.params])).toEqual([
      ['describe', {}],
      ['events', { limit: 0 }],
      ['fakeCalls', { fake: 'api', limit: 0 }],
      ['fakeCalls', { fake: 'reader', limit: 0 }],
      ['dispatch', { name: 'cart.clear', payload: {}, settle: true }],
      ['events', { since: 7 }],
      ['getState', { path: '' }],
      ['fakeCalls', { fake: 'api', since: 3 }],
      ['fakeCalls', { fake: 'reader', since: 0 }],
    ]);
    expect(calls.every((call) => call.target === 'headless' || call.op === 'describe')).toBe(true);
  });

  it('captures the cursors again after a reset step, so the logs cover only what came after it', async () => {
    await writeFile(file, 'name: Reset\nsteps:\n  - send: cart.clear\n  - reset: true\n  - send: cart.clear\n');
    let resets = 0;
    const { client, calls } = scripted({
      describe: description(),
      dispatch: stepResult(),
      reset: () => {
        resets += 1;
        return { rev: 0, path: '', value: {} };
      },
      events: (params: Record<string, unknown>) => (params['limit'] === 0 ? { events: [], nextSeq: resets === 0 ? 7 : 0, truncated: false } : { events: [], nextSeq: 0, truncated: false }),
      fakeCalls: (params: Record<string, unknown>) => (params['limit'] === 0 ? { calls: [], nextSeq: resets === 0 ? 5 : 0, truncated: false } : { calls: [], nextSeq: 0, truncated: false }),
      getState: { rev: 0, path: '', value: {} },
    });
    const result = await runScenario(client, parseScenario(await readFile(file, 'utf8'), file), { file, artifacts: root });
    expect(result).toMatchObject({ passed: true, stepsRun: 3 });
    expect(calls.filter((call) => call.op === 'events').map((call) => call.params)).toEqual([{ limit: 0 }, { limit: 0 }, { since: 0 }]);
    expect(calls.filter((call) => call.op === 'fakeCalls').map((call) => call.params)).toEqual([
      { fake: 'api', limit: 0 },
      { fake: 'reader', limit: 0 },
      { fake: 'api', limit: 0 },
      { fake: 'reader', limit: 0 },
      { fake: 'api', since: 0 },
      { fake: 'reader', since: 0 },
    ]);
    expect(calls.map((call) => call.op).slice(0, 8)).toEqual(['describe', 'events', 'fakeCalls', 'fakeCalls', 'dispatch', 'reset', 'events', 'fakeCalls']);
  });

  it('collects best effort: a file that cannot be gathered or written is named in artifactErrors and the rest is still written', async () => {
    const missing = path.join(root, 'missing.yaml');
    const { client } = scripted({
      describe: description({ fakes: {}, capabilities: ['settle', 'events', 'clock', 'reset'] }),
      dispatch: stepResult(),
      events: (params: Record<string, unknown>) => (params['limit'] === 0 ? { events: [], nextSeq: 7, truncated: false } : { events: [{ seq: 9, t: 2, source: 'cart', name: 'cleared' }], nextSeq: 9, truncated: true }),
      getState: new IronbirdError('TARGET_DISCONNECTED', 'Target headless disconnected', { target: 'headless', op: 'getState' }),
    });
    const result = await runScenario(client, load('name: Best effort\nsteps:\n  - send: cart.clear\n'), { file: missing, artifacts: root });
    const dir = result.artifacts as string;
    expect(result.passed).toBe(true);
    expect(result.artifactErrors).toEqual([
      expect.stringMatching(/^missing\.yaml: .*ENOENT/),
      'events.jsonl: the recorder dropped events before seq 7; the log is incomplete',
      'state.json: Target headless disconnected',
    ]);
    expect((await readdir(dir)).sort()).toEqual(['events.jsonl', 'result.json']);
    expect(await readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":9,"t":2,"source":"cart","name":"cleared"}\n');
    expect(JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'))).toEqual(result);
  });

  it('writes nothing and reports null artifacts when turned off', async () => {
    const { client, calls } = scripted({ describe: description(), dispatch: stepResult() });
    const result = await runScenario(client, load('name: Off\nsteps:\n  - send: cart.clear\n'), { file, artifacts: false });
    expect(result.artifacts).toBeNull();
    expect(calls.map((call) => call.op)).toEqual(['describe', 'dispatch']);
    expect(await readdir(root)).toEqual([]);
  });
});
```

The responders that read `params` are annotated `(params: Record<string, unknown>)` on purpose: `scripted`'s `Record<string, Responder | unknown>` collapses to `Record<string, unknown>`, so an unannotated arrow parameter is an implicit `any`, and `packages/cli/tsconfig.json` typechecks test files (`include: ["src/**/*.ts"]`, no test exclusion), so that would fail `pnpm typecheck` in Step 6. Task 4's responders take no parameters, which is why the file typechecks there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/scenario/run.test.ts`
Expected: 3 failed in `runScenario artifacts` (the run directory is empty apart from nothing: `readdir` returns `[]` where files are expected, and `calls` lack the `events` and `fakeCalls` operations). The `writes nothing` test and the 10 earlier tests pass.

- [ ] **Step 3: Replace `artifacts.ts`**

`packages/cli/src/scenario/artifacts.ts`:

```ts
import { messageOf, type Description, type FakeCallsResult, type RecordedEvent, type ScenarioResult } from '@ironbird/core';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonClient } from '../cli/client';
import type { Scenario } from './parse';

const SLUG_MAX = 60;

/** A filesystem-safe form of a scenario name: lowercase, dashes for anything else, at most 60 characters. */
export function scenarioSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug === '' ? 'scenario' : slug;
}

/** `<root>/runs/<UTC stamp with milliseconds>-<slug>`, the stamp with `:` and `.` replaced so it is a valid name everywhere. */
export function runDirectoryPath(root: string, name: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.resolve(root, 'runs', `${stamp}-${scenarioSlug(name)}`);
}

export async function createRunDirectory(root: string, name: string): Promise<string> {
  const dir = runDirectoryPath(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface RunArtifacts {
  /** The run directory, created before the first step so screenshots can land in it. */
  readonly dir: string;
  /**
   * Records where the event log and each fake's call log stand, with `limit: 0` so nothing is
   * transferred. Called after the initial `describe` and again after every `reset` step, which
   * restarts both logs. Never throws: a cursor that can't be read is reported by `collect`.
   */
  capture(): Promise<void>;
  /**
   * Writes `result.json`, a copy of the scenario file, `events.jsonl`, `state.json`, and
   * `calls/<fake>.json`, each best effort: a file that can't be gathered or written is left out
   * and named in the returned result's `artifactErrors`.
   */
  collect(result: ScenarioResult): Promise<ScenarioResult>;
}

interface EventsPage {
  events: RecordedEvent[];
  nextSeq: number;
  truncated: boolean;
}

export async function createRunArtifacts(options: { root: string; scenario: Scenario; file: string; client: DaemonClient; target: string; description: Description }): Promise<RunArtifacts> {
  const { client, target, file } = options;
  const dir = await createRunDirectory(options.root, options.scenario.name);
  const fakes = options.description.capabilities.includes('fakes') ? Object.keys(options.description.fakes) : [];
  const cursors = { events: 0, calls: {} as Record<string, number> };
  const errors: string[] = [];

  const attempt = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      errors.push(`${label}: ${messageOf(error)}`);
    }
  };

  return {
    dir,
    async capture() {
      await attempt('events.jsonl', async () => {
        cursors.events = (await client.rpc<EventsPage>('events', { limit: 0 }, target)).nextSeq;
      });
      for (const fake of fakes) {
        await attempt(`calls/${fake}.json`, async () => {
          cursors.calls[fake] = (await client.rpc<FakeCallsResult>('fakeCalls', { fake, limit: 0 }, target)).nextSeq;
        });
      }
    },
    async collect(result) {
      await attempt(path.basename(file), () => copyFile(file, path.join(dir, path.basename(file))));
      await attempt('events.jsonl', async () => {
        const page = await client.rpc<EventsPage>('events', { since: cursors.events }, target);
        await writeFile(path.join(dir, 'events.jsonl'), page.events.map((event) => `${JSON.stringify(event)}\n`).join(''));
        if (page.truncated) errors.push(`events.jsonl: the recorder dropped events before seq ${cursors.events}; the log is incomplete`);
      });
      await attempt('state.json', async () => {
        const { value } = await client.rpc<{ value: unknown }>('getState', { path: '' }, target);
        await writeFile(path.join(dir, 'state.json'), `${JSON.stringify(value, null, 2)}\n`);
      });
      if (fakes.length > 0) await attempt('calls', () => mkdir(path.join(dir, 'calls'), { recursive: true }));
      for (const fake of fakes) {
        await attempt(`calls/${fake}.json`, async () => {
          const page = await client.rpc<FakeCallsResult>('fakeCalls', { fake, since: cursors.calls[fake] ?? 0 }, target);
          await writeFile(path.join(dir, 'calls', `${fake}.json`), `${JSON.stringify(page.calls, null, 2)}\n`);
        });
      }
      const withErrors = (): ScenarioResult => (errors.length === 0 ? { ...result, artifacts: dir } : { ...result, artifacts: dir, artifactErrors: [...errors] });
      await attempt('result.json', () => writeFile(path.join(dir, 'result.json'), `${JSON.stringify(withErrors(), null, 2)}\n`));
      return withErrors();
    },
  };
}
```

- [ ] **Step 4: Wire the runner to the artifacts**

Four exact edits in `packages/cli/src/scenario/run.ts`.

1. Replace the import line `import { createRunDirectory } from './artifacts';` with:

```ts
import { createRunArtifacts, type RunArtifacts } from './artifacts';
```

2. Replace the line `const runDir = options.artifacts === false ? null : await createRunDirectory(options.artifacts, scenario.name);` with:

```ts
  const artifacts: RunArtifacts | null = options.artifacts === false ? null : await createRunArtifacts({ root: options.artifacts, scenario, file: options.file, client, target, description: described.result });
  const runDir = artifacts === null ? null : artifacts.dir;
  // "During the run" starts here: the cursors captured now bound what `collect` gathers.
  await artifacts?.capture();
```

3. Replace the line `await runStep(client, target, step, index, runDir);` with:

```ts
      await runStep(client, target, step, index, runDir);
      // A reset restarts the event and call logs, so the cursors restart with them.
      if (step.kind === 'reset') await artifacts?.capture();
```

4. Replace the final `return { scenario: scenario.name, ... };` statement with:

```ts
  const result: ScenarioResult = {
    scenario: scenario.name,
    file: options.file,
    target,
    passed: failedStep === undefined,
    durationMs: Date.now() - started,
    stepsRun,
    ...(failedStep === undefined ? {} : { failedStep }),
    skipped,
    artifacts: runDir,
  };
  return artifacts === null ? result : artifacts.collect(result);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/scenario/`
Expected: 29 passed across `artifacts.test.ts`, `parse.test.ts`, and `run.test.ts`.

- [ ] **Step 6: Lint, typecheck, and commit**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

```sh
git add packages/cli/src/scenario/artifacts.ts packages/cli/src/scenario/run.ts packages/cli/src/scenario/run.test.ts
git commit -m "Write scenario run artifacts with cursors captured at the start"
```

---

### Task 6: `artifactsPath` in `daemon.json` and `resolveDaemon`

**Files:**
- Modify: `packages/cli/src/daemon-info.ts`
- Create: `packages/cli/src/daemon-info.test.ts`
- Modify: `packages/cli/src/cli/commands/serve.ts` (one line)
- Modify: `packages/cli/src/cli/commands/serve.test.ts` (one assertion)
- Modify: `packages/cli/src/cli/client.ts` (`resolveDaemon`)
- Modify: `packages/cli/src/cli/client.test.ts` (the `resolveDaemon` block)
- Modify: `docs/cli.md` (the `serve` paragraph)

**Interfaces:**
- Consumes: `DaemonInfo`, `readDaemonInfo`, `writeDaemonInfo` (exist); `ResolvedConfig.artifactsPath` from `packages/cli/src/config.ts` (exists, already absolute); `findArtifactsDir` in `client.ts` (exists, private).
- Produces: `DaemonInfo.artifactsPath?: string`; `export interface ResolvedDaemon { url: string; token?: string; defaultTarget?: string; artifactsDir: string }`; `resolveDaemon(options): Promise<ResolvedDaemon>` where `artifactsDir` is the recorded `artifactsPath`, else the directory holding the `daemon.json` that discovery found, else `<cwd>/.ironbird` (also under `--daemon <url>`). Task 7 uses `artifactsDir`.

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/daemon-info.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDaemonInfo, writeDaemonInfo } from './daemon-info';

describe('daemon info', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips artifactsPath', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-info-'));
    const info = { url: 'http://127.0.0.1:4567', pid: 1, startedAt: 0, version: '0.0.0', artifactsPath: '/app/.ironbird' };
    await writeDaemonInfo(dir, info);
    expect(await readDaemonInfo(dir)).toEqual(info);
  });

  it('rejects a daemon.json whose artifactsPath is not a string', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-info-'));
    await writeFile(path.join(dir, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:4567', pid: 1, startedAt: 0, version: '0.0.0', artifactsPath: 7 }));
    expect(await readDaemonInfo(dir)).toBeUndefined();
  });
});
```

In `packages/cli/src/cli/client.test.ts`, replace the whole `describe('resolveDaemon', ...)` block with:

```ts
describe('resolveDaemon', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('prefers the flag, then daemon.json found walking up, then the default, and reports the artifacts directory', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-client-'));
    await mkdir(path.join(dir, '.ironbird'), { recursive: true });
    await mkdir(path.join(dir, 'src/deep'), { recursive: true });
    await writeFile(path.join(dir, '.ironbird/daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:4999', pid: 1, startedAt: 0, version: '0.0.0', defaultTarget: 'headless', artifactsPath: path.join(dir, 'out') }));
    expect(await resolveDaemon({ flag: 'http://10.0.0.2:4567', cwd: path.join(dir, 'src/deep'), env: {} })).toEqual({ url: 'http://10.0.0.2:4567', token: undefined, defaultTarget: undefined, artifactsDir: path.join(dir, 'src/deep/.ironbird') });
    expect(await resolveDaemon({ cwd: path.join(dir, 'src/deep'), env: { IRONBIRD_TOKEN: 't' } })).toEqual({ url: 'http://127.0.0.1:4999', token: 't', defaultTarget: 'headless', artifactsDir: path.join(dir, 'out') });
    expect(await resolveDaemon({ cwd: tmpdir(), env: {} })).toEqual({ url: 'http://127.0.0.1:4567', token: undefined, defaultTarget: undefined, artifactsDir: path.join(tmpdir(), '.ironbird') });
  });

  it('falls back to the directory holding daemon.json when the file predates artifactsPath', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-client-'));
    await mkdir(path.join(dir, '.ironbird'), { recursive: true });
    await writeFile(path.join(dir, '.ironbird/daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:4999', pid: 1, startedAt: 0, version: '0.0.0' }));
    expect(await resolveDaemon({ cwd: dir, env: {} })).toEqual({ url: 'http://127.0.0.1:4999', token: undefined, defaultTarget: undefined, artifactsDir: path.join(dir, '.ironbird') });
  });
});
```

In `packages/cli/src/cli/commands/serve.test.ts`, in the first test, add after `expect(info?.url).toBe(line['url']);`:

```ts
    expect(info?.artifactsPath).toBe(path.join(example, '.ironbird'));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/daemon-info.test.ts packages/cli/src/cli/client.test.ts`
Expected: `daemon-info.test.ts`: the rejection test fails (`readDaemonInfo` returns the object, since it ignores the unknown field); `client.test.ts`: both `resolveDaemon` tests fail on the missing `artifactsDir`.

Run: `pnpm exec vitest run --project serial packages/cli/src/cli/commands/serve.test.ts`
Expected: the first test fails, `expected undefined to be "<example>/.ironbird"`. (This project loads the example's headless entry; if it fails to resolve `@ironbird/core`, run `pnpm build` once first.)

- [ ] **Step 3: Record and resolve the path**

In `packages/cli/src/daemon-info.ts`, replace the `DaemonInfo` interface with:

```ts
export interface DaemonInfo {
  url: string;
  pid: number;
  startedAt: number;
  version: string;
  defaultTarget?: string;
  bridgeUrl?: string;
  /** The daemon's resolved artifacts directory, so client commands can write under it without loading the config. */
  artifactsPath?: string;
}
```

and in `readDaemonInfo`, add after the `bridgeUrl` check:

```ts
    if (candidate.artifactsPath !== undefined && typeof candidate.artifactsPath !== 'string') return undefined;
```

In `packages/cli/src/cli/commands/serve.ts`, replace the `writeDaemonInfo(...)` line with:

```ts
    await writeDaemonInfo(config.artifactsPath, { url: daemon.url, pid: process.pid, startedAt: Date.now(), version: io.version, defaultTarget, artifactsPath: config.artifactsPath, ...(daemon.bridgeUrl === undefined ? {} : { bridgeUrl: daemon.bridgeUrl }) });
```

In `packages/cli/src/cli/client.ts`, replace the `resolveDaemon` function with:

```ts
export interface ResolvedDaemon {
  url: string;
  token?: string;
  defaultTarget?: string;
  /**
   * Where files written by client commands go: the `artifactsPath` the daemon recorded in
   * `daemon.json`, else the directory that held the `daemon.json` discovery found, else
   * `<cwd>/.ironbird`, including under `--daemon <url>`, which bypasses discovery.
   */
  artifactsDir: string;
}

export async function resolveDaemon(options: { flag?: string; cwd: string; env: Record<string, string | undefined> }): Promise<ResolvedDaemon> {
  const token = options.env['IRONBIRD_TOKEN'];
  const fallback = path.resolve(options.cwd, '.ironbird');
  if (options.flag) return { url: options.flag, token, defaultTarget: undefined, artifactsDir: fallback };
  const found = await findArtifactsDir(options.cwd);
  const info = found ? await readDaemonInfo(found) : undefined;
  if (info && found) return { url: info.url, token, defaultTarget: info.defaultTarget, artifactsDir: info.artifactsPath ?? found };
  return { url: DEFAULT_DAEMON_URL, token, defaultTarget: undefined, artifactsDir: fallback };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/daemon-info.test.ts packages/cli/src/cli/client.test.ts && pnpm exec vitest run --project serial packages/cli/src/cli/commands/serve.test.ts`
Expected: all passed in the three files.

- [ ] **Step 5: Update the docs**

In `docs/cli.md`, in the `serve` section, replace the sentence `` `daemon.json` records `bridgeUrl` alongside `url`. `` with:

```md
`daemon.json` records `bridgeUrl` and `artifactsPath`, the daemon's resolved artifacts directory, alongside `url`; client commands that write files, such as `scenario run`, use `artifactsPath`, so a non-default `artifactsDir` in the config works without the client loading it. With `--daemon <url>`, or with no `daemon.json`, they write under `.ironbird` in the working directory.
```

- [ ] **Step 6: Lint, typecheck, and commit**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

```sh
git add packages/cli/src/daemon-info.ts packages/cli/src/daemon-info.test.ts packages/cli/src/cli/commands/serve.ts packages/cli/src/cli/commands/serve.test.ts packages/cli/src/cli/client.ts packages/cli/src/cli/client.test.ts docs/cli.md
git commit -m "Record artifactsPath in daemon.json and resolve it for client commands"
```

---

### Task 7: `ironbird scenario run`

**Files:**
- Create: `packages/cli/src/scenario/format.ts`
- Modify: `packages/cli/src/cli/program.ts` (`Context`, `context`, the new command)
- Modify: `packages/cli/src/cli/program.test.ts` (harness gains `cwd`; new describe block)
- Modify: `docs/cli.md` (`scenario run` section, "Scenario files" section)
- Modify: `.changeset/m2-scenarios.md` (final text)

**Interfaces:**
- Consumes: `loadScenarioFiles` (Task 3), `runScenario` (Task 4), `resolveDaemon().artifactsDir` (Task 6), `exitCodeForError` (Task 1 maps `INVALID_SCENARIO` to 2), `wrap`, `createOutput`, `Command` from `commander` (exist).
- Produces: `export function formatScenarioResult(result: ScenarioResult, cwd: string): string`; the `scenario run <path...> [--bail]` command using the global `--target` and `--json`; `Context` gains `artifactsDir: string` and `json: boolean`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/cli/program.test.ts`, replace the imports with:

```ts
import { IronbirdError } from '@ironbird/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonClient } from './client';
import { buildProgram } from './program';
```

Replace the whole `function harness(...) { ... }` with:

```ts
function harness(responses: Record<string, Responder>, options: { isTTY?: boolean; streamFrames?: StreamFrame[]; createClient?: () => DaemonClient; cwd?: string } = {}) {
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client: DaemonClient = {
    url: 'http://127.0.0.1:4567',
    async call<T>(op: string, params: Record<string, unknown> = {}, target?: string) {
      calls.push({ op, params, target });
      const responder = responses[op];
      if (responder === undefined) throw new Error(`no response for ${op}`);
      const result = typeof responder === 'function' ? (responder as (p: Record<string, unknown>) => unknown)(params) : responder;
      if (result instanceof Error) throw result;
      return (op === 'status' ? { result } : { target: target ?? 'headless', result }) as { target?: string; result: T };
    },
    async rpc(op, params, target) {
      return (await this.call(op, params, target)).result as never;
    },
    async stream({ onMessage }) {
      const frames = options.streamFrames ?? [{ kind: 'event', data: { seq: 9, name: 'streamed' } }];
      for (const frame of frames) onMessage(frame.kind, frame.data);
    },
  };
  const { run } = buildProgram({
    cwd: options.cwd ?? '/tmp/nowhere',
    env: {},
    isTTY: options.isTTY ?? false,
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    version: '0.0.0-test',
    createClient: options.createClient ?? (() => client),
    signal: AbortSignal.abort(),
  });
  return { run, calls, stdout, stderr, out: () => JSON.parse(stdout.join('')) as Record<string, unknown> };
}
```

Add at the end of the file:

```ts
describe('scenario run', () => {
  let dir: string;
  const described = { app: { id: 'a', platform: 'headless' }, commands: {}, fakes: {}, capabilities: ['settle', 'events', 'clock', 'reset'] };
  // The expect step reads order.totalCents; artifact collection reads the root.
  const getState = (params: Record<string, unknown>) => (params['path'] === '' ? { rev: 1, path: '', value: {} } : { rev: 1, path: 'order.totalCents', value: 0 });
  const collection = { events: { events: [], nextSeq: 0, truncated: false }, getState };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenario-cli-'));
    await mkdir(path.join(dir, 'scenarios'));
    await writeFile(path.join(dir, 'scenarios/b-fails.yaml'), 'name: B fails\nsteps:\n  - expect: order.totalCents\n    equals: 4500\n');
    await writeFile(path.join(dir, 'scenarios/a-passes.yml'), 'name: A passes\nsteps:\n  - send: cart.clear\n');
    await writeFile(path.join(dir, 'broken.yaml'), 'name: Broken\nsteps:\n  - send: cart.clear\n    payloads: {}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('expands a directory in name order, prints one JSON line per scenario, and exits 4 when any scenario fails', async () => {
    const h = harness({ describe: described, dispatch: step(), ...collection }, { cwd: dir });
    expect(await h.run(['scenario', 'run', 'scenarios', '--target', 'headless'])).toBe(4);
    const lines = h.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line['scenario'], line['passed'], line['file']])).toEqual([
      ['A passes', true, path.join(dir, 'scenarios/a-passes.yml')],
      ['B fails', false, path.join(dir, 'scenarios/b-fails.yaml')],
    ]);
    expect(lines[1]).toMatchObject({ target: 'headless', stepsRun: 1, failedStep: { index: 0, step: { expect: 'order.totalCents', equals: 4500 }, expected: { equals: 4500 }, actual: 0 } });
    expect(String(lines[0]?.['artifacts']).startsWith(path.join(dir, '.ironbird/runs/'))).toBe(true);
    expect(h.calls[0]).toEqual({ op: 'describe', params: {}, target: 'headless' });
  });

  it('--bail stops after the first failed scenario', async () => {
    const h = harness({ describe: described, ...collection }, { cwd: dir });
    expect(await h.run(['scenario', 'run', 'scenarios/b-fails.yaml', 'scenarios/b-fails.yaml', '--bail'])).toBe(4);
    expect(h.stdout).toHaveLength(1);
    const all = harness({ describe: described, ...collection }, { cwd: dir });
    expect(await all.run(['scenario', 'run', 'scenarios/b-fails.yaml', 'scenarios/b-fails.yaml'])).toBe(4);
    expect(all.stdout).toHaveLength(2);
  });

  it('exits 2 with INVALID_SCENARIO before running anything when any file is invalid', async () => {
    const h = harness({ describe: described }, { cwd: dir });
    expect(await h.run(['scenario', 'run', 'scenarios', 'broken.yaml'])).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.out()).toEqual({ error: { code: 'INVALID_SCENARIO', message: `Invalid scenario ${path.join(dir, 'broken.yaml')}:4: steps.0.payloads: unknown key payloads`, details: { file: path.join(dir, 'broken.yaml'), issues: [{ path: ['steps', 0, 'payloads'], message: 'unknown key payloads', line: 4 }] } } });
    const missing = harness({ describe: described }, { cwd: dir });
    expect(await missing.run(['scenario', 'run', 'nope.yaml'])).toBe(2);
    expect(missing.out()).toMatchObject({ error: { code: 'INVALID_SCENARIO' } });
  });

  it('exits with the describe error code and prints no result when the first describe fails', async () => {
    const h = harness({ describe: new IronbirdError('NO_TARGET', 'No target is connected or configured', { available: [] }) }, { cwd: dir });
    expect(await h.run(['scenario', 'run', 'scenarios/a-passes.yml'])).toBe(5);
    expect(h.stdout).toHaveLength(1);
    expect(h.out()).toEqual({ error: { code: 'NO_TARGET', message: 'No target is connected or configured', details: { available: [] } } });
    const unauthorized = harness({ describe: new IronbirdError('UNAUTHORIZED', 'Token missing or wrong') }, { cwd: dir });
    expect(await unauthorized.run(['scenario', 'run', 'scenarios/a-passes.yml'])).toBe(2);
  });

  it('prints a summary per scenario in a TTY and JSON lines with --json', async () => {
    const h = harness({ describe: described, dispatch: step(), ...collection }, { cwd: dir, isTTY: true });
    expect(await h.run(['scenario', 'run', 'scenarios'])).toBe(4);
    expect(h.stdout[0]).toMatch(/^PASS A passes {2}headless {2}1 steps {2}\d+ ms {2}\.ironbird\/runs\/\S+-a-passes\n$/);
    expect(h.stdout[1]).toMatch(/^FAIL B fails {2}headless {2}1 steps {2}\d+ ms {2}\.ironbird\/runs\/\S+-b-fails\n {2}step 0: {"expect":"order\.totalCents","equals":4500}\n {2}expected: {"equals":4500}\n {2}actual: 0\n$/);
    h.stdout.length = 0;
    expect(await h.run(['scenario', 'run', 'scenarios/a-passes.yml', '--json'])).toBe(0);
    expect(JSON.parse(h.stdout[0] ?? '')).toMatchObject({ scenario: 'A passes', passed: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts`
Expected: the 5 `scenario run` tests fail with exit code 2 and `unknown command 'scenario'` on stderr; the earlier tests pass.

- [ ] **Step 3: Write the TTY formatter**

`packages/cli/src/scenario/format.ts`:

```ts
import type { ScenarioResult } from '@ironbird/core';
import path from 'node:path';

/** The TTY rendering of one scenario result: a PASS or FAIL line, then the failed step and any artifact problems. */
export function formatScenarioResult(result: ScenarioResult, cwd: string): string {
  const skipped = result.skipped.length === 0 ? '' : `  skipped ${result.skipped.join(',')}`;
  const artifacts = result.artifacts === null ? '' : `  ${path.relative(cwd, result.artifacts) || '.'}`;
  const lines = [`${result.passed ? 'PASS' : 'FAIL'} ${result.scenario}  ${result.target}  ${result.stepsRun} steps  ${result.durationMs} ms${skipped}${artifacts}\n`];
  const failed = result.failedStep;
  if (failed) {
    const repetition = failed.repetition === undefined ? '' : ` (repetition ${failed.repetition})`;
    lines.push(`  step ${failed.index}${repetition}: ${JSON.stringify(failed.step)}\n`);
    if ('expected' in failed) lines.push(`  expected: ${JSON.stringify(failed.expected)}\n`);
    if ('actual' in failed) lines.push(`  actual: ${JSON.stringify(failed.actual)}\n`);
    if (failed.error) {
      lines.push(`  error ${failed.error.code}: ${failed.error.message}\n`);
      if (failed.error.details !== undefined) lines.push(`  ${JSON.stringify(failed.error.details)}\n`);
    }
  }
  for (const problem of result.artifactErrors ?? []) lines.push(`  artifact not written: ${problem}\n`);
  return lines.join('');
}
```

- [ ] **Step 4: Add the command**

In `packages/cli/src/cli/program.ts`:

1. Add to the imports, after the `import { parseJsonOrString, parsePayload } from './values';` line:

```ts
import { formatScenarioResult } from '../scenario/format';
```

2. Replace the `Context` interface with:

```ts
interface Context {
  output: Output;
  client: DaemonClient;
  target: string | undefined;
  /** Where the daemon writes artifacts; scenario runs go under it (see `resolveDaemon`). */
  artifactsDir: string;
  /** True when output is JSON: stdout is not a TTY or `--json` was passed. */
  json: boolean;
}
```

3. Replace the `context` function with:

```ts
  const context = async (command: Command): Promise<Context> => {
    const opts = command.optsWithGlobals<GlobalOptions>();
    const json = Boolean(opts.json) || !io.isTTY;
    const output = createOutput({ json, write: io.stdout });
    const daemon = await resolveDaemon({ flag: opts.daemon, cwd: io.cwd, env: io.env });
    const client = (io.createClient ?? createDaemonClient)({ url: daemon.url, token: opts.token ?? daemon.token });
    return { output, client, target: opts.target, artifactsDir: daemon.artifactsDir, json };
  };
```

4. Insert the command after the `step` command's registration (after the `);` that closes `program.command('step <command> [payload]')...`) and before `program.command('verify-bundle <path...>')`:

```ts
  const scenario = program.command('scenario').description('Run scenario files');
  scenario
    .command('run <path...>')
    .description('Run scenario files, or directories of them, and print one result per scenario')
    .option('--bail', 'stop after the first failed scenario')
    .action(
      wrap(async (ctx, paths: string[], opts: { bail?: boolean }) => {
        // Loaded on demand: the scenario modules pull in yaml and zod, which no other client
        // command needs on its startup path.
        const [{ loadScenarioFiles }, { runScenario }] = await Promise.all([import('../scenario/parse'), import('../scenario/run')]);
        // Every file is parsed before any run, so an authoring error costs nothing.
        const scenarios = await loadScenarioFiles(paths, io.cwd);
        let failed = false;
        for (const { file, scenario: parsed } of scenarios) {
          const result = await runScenario(ctx.client, parsed, { file, target: ctx.target, artifacts: ctx.artifactsDir });
          if (ctx.json) ctx.output.result(result);
          else io.stdout(formatScenarioResult(result, io.cwd));
          if (!result.passed) {
            failed = true;
            if (opts.bail) break;
          }
        }
        return { exit: failed ? 4 : 0 };
      }),
    );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts`
Expected: all passed, including the 5 `scenario run` tests.

- [ ] **Step 6: Update the CLI docs**

In `docs/cli.md`, replace the `### scenario run (M2)` section (heading through "Exits 4 if any scenario fails.") with:

````md
### scenario run

```text
ironbird scenario run <path...> [--bail] [--target <id>]
```

Runs scenario files against one target and prints one scenario result per file. Each `path` is a file or a directory; a directory expands to its `*.yaml` and `*.yml` files in name order, without recursing. Every file is parsed before any scenario runs, so an authoring error costs nothing: an invalid file, or a path that does not exist, fails with `INVALID_SCENARIO` and exit code 2 before the daemon is contacted. `--target` is the global option; it overrides the scenario's own `target`, and with neither the daemon picks its default.

The first operation of every run is `describe`, and the target id in its reply pins the target for every later operation, including `screenshot`, whose default target selection differs from everything else's. A `describe` that fails ends the command with that error and its own exit code: 5 when the daemon is unreachable or has no such target, 2 for `UNAUTHORIZED`, 1 for `TARGET_DISCONNECTED`. The same errors from a later step fail that step like any other.

Output is one `ScenarioResult` per file (see [Output shapes](#output-shapes)), as JSON lines when stdout is not a TTY or `--json` is passed, and otherwise as a `PASS` or `FAIL` line per scenario followed by the failed step with its `expected` and `actual` values or its error, and any artifacts that could not be written. The exit code is 2 if any file is invalid, the `describe` error's own code as above, 4 if any scenario failed, and 0 otherwise. `--bail` stops after the first failed scenario.

```sh
ironbird scenario run ironbird/scenarios
ironbird scenario run ironbird/scenarios/race-success-before-confirmation.yaml --target ios
```

Every run, passed or failed, writes a directory under the daemon's artifacts directory (`artifactsPath` in `daemon.json`, else `.ironbird` under the working directory): `runs/<UTC stamp with milliseconds>-<scenario slug>/`, for example `.ironbird/runs/2026-09-25T18-04-12-345Z-payment-success-arrives-before-order-confirmation/`. It holds:

| File | Contents |
|---|---|
| `result.json` | The `ScenarioResult` |
| the scenario file | A copy, under its own name |
| `events.jsonl` | The events recorded during the run, one per line |
| `state.json` | The whole state after the last step |
| `calls/<fake>.json` | Each fake's port calls during the run, on targets that declare `fakes` |
| `<index>-<name>.png` | One per `screenshot` step, named by the step's index and value |

"During the run" means after the run's first `describe`, or after the last `reset` step, which restarts the event and call logs. Collection is best effort: a file that cannot be gathered, such as the state after a `TARGET_DISCONNECTED`, is left out and named in `artifactErrors`.
````

Replace the `## Scenario files` section (heading through the closing ` ``` ` of the failing-run JSON example, up to but not including `## MCP tools (P1)`) with:

````md
## Scenario files

Scenarios live in `ironbird/scenarios/*.yaml` by default. The example app's gate scenario, which reproduces the planted race:

```yaml
name: Payment success arrives before order confirmation
description: The server reports the payment succeeded before it confirms the order and its total. The receipt must still show the total.
steps:
  - send: ui.setMotion
    payload: { motion: reduced }   # the api.md rule for agent-driven builds
  - fake: api
    control: setEcho
    payload: { mode: manual }
  - send: cart.addItem
    payload: { sku: cut-45, qty: 1 }
  - send: payment.start
    payload: { method: saved }
  - clock: 300ms
    optional: true   # headless: resolves the submission; a remote target's settle already waited for it
  - wait: payment.status
    equals: awaitingServerEcho
  - fake: api
    control: emit
    payload: { event: payment.succeeded }
  - fake: api
    control: emit
    payload: { event: order.confirmed }
  - expect: order.status
    equals: completed
  - expect: order.totalCents
    equals: 4500
```

The top level has `name` (required), `description`, `target` (`--target` overrides it), and a non-empty `steps` list. Each step is exactly one kind, identified by its key, plus the shared `optional` flag. Unknown keys are rejected, so a typo such as `payloads` fails with `INVALID_SCENARIO` before anything runs; its `details.issues` list every problem with its path and line. Payloads are not checked until the step runs, because their schemas live in the app: an invalid one fails its step with `INVALID_PAYLOAD`.

| Step | Fields | Operation | Supported when |
|---|---|---|---|
| `send` | `send` (command), `payload?` (default `{}`), `repeat?`, `settle?` (default `true`) | `dispatch` | Always |
| `fake` | `fake`, `control`, `payload?` (default `{}`), `repeat?`, `settle?` (default `true`) | `fakeControl` | The target declares `fakes` and `describe` lists that fake |
| `clock` | Duration, `settle?` (default `true`) | `clockAdvance` | The target declares `clock` |
| `wait` | `wait` (path), one condition, `timeout?` (default 5 s) | `waitFor` | Always |
| `expect` | `expect` (path), one condition | `getState`, then the condition is checked locally | Always |
| `screenshot` | Name used in the artifact filename | `screenshot` | The platform is not `headless` |
| `reset` | `reset: true` | `reset` | The target declares `reset` |
| `snapshot` (P1) | `snapshot: { save: <file> }` or `snapshot: { load: <file> }` | | Targets that persist or restore |

Durations are a number of milliseconds or a string with an `ms`, `s`, or `m` suffix. Conditions are exactly one of `equals`, `notEquals`, `exists` (`true` or `false`), and `matches` (a regular expression string). YAML 1.2 rules apply, so `on` and `yes` are strings, not booleans.

Whether a step can run is decided from `describe` before it runs, never by trying it. A step the target can't run is skipped when it is `optional`, and its index is added to `skipped`; otherwise it fails before any operation is sent:

| Case | Fails with |
|---|---|
| The target lacks the capability, or the platform has no screen | `UNSUPPORTED`, details `{ op, target }` |
| A `fake` step on a target that declares `fakes` but not the named fake | `UNKNOWN_FAKE`, details `{ fake, available, suggestions }` |

A `send`, `fake`, or `clock` step that ends neither idle nor quiescent fails the scenario with `actual: { settle }`, matching the CLI, where a quiescent headless step exits 0; `settle: false` on the step opts out. `repeat` runs the operation that many times, and a failure names the `repetition` that failed, counting from 1. The runner stops at the first failing step. `stepsRun` counts the steps that ran, including a failed one and excluding skipped ones; a step that fails its support check before anything is sent (the two cases above) is not counted either.

A failing run of the scenario above against the headless target with the race planted prints:

```json
{
  "scenario": "Payment success arrives before order confirmation",
  "file": "/app/ironbird/scenarios/race-success-before-confirmation.yaml",
  "target": "headless",
  "passed": false,
  "durationMs": 41,
  "stepsRun": 10,
  "failedStep": { "index": 9, "step": { "expect": "order.totalCents", "equals": 4500 }, "expected": { "equals": 4500 }, "actual": 0 },
  "skipped": [],
  "artifacts": "/app/.ironbird/runs/2026-09-25T18-04-12-345Z-payment-success-arrives-before-order-confirmation"
}
```

`failedStep` carries `expected` and `actual` for a `wait` that timed out (`actual` is the last value read) and for an `expect` that did not hold, `actual: { settle }` for an unsettled step, and `error` for any other failure, including `INVALID_PAYLOAD`, `DISPATCH_FAILED`, `TARGET_DISCONNECTED`, and `NO_TARGET`.

````

- [ ] **Step 7: Finish the changeset**

Replace the contents of `.changeset/m2-scenarios.md` with:

```md
---
"@ironbird/core": patch
"@ironbird/cli": patch
---
The scenario runner. `ironbird scenario run <path...> [--bail]` parses YAML scenario files with the `yaml` package (YAML 1.2, so `on` and `yes` stay strings, and errors carry line numbers), validates every file before anything runs, and runs each step as one daemon operation against the target pinned by the run's first `describe`: `send`, `fake`, `clock`, `wait`, `expect`, `screenshot`, and `reset`, with `optional` skips decided from `describe`, `repeat`, and `settle` on `fake` and `clock` steps as on `send`. A `send`, `fake`, or `clock` step that ends neither idle nor quiescent fails the scenario. Every run writes `runs/<stamp>-<slug>/` under the daemon's artifacts directory with `result.json`, a copy of the scenario, `events.jsonl`, `state.json`, `calls/<fake>.json`, and screenshots; `serve` now records `artifactsPath` in `daemon.json` so client commands find that directory without loading the config, and `resolveDaemon` returns it as `artifactsDir`. `@ironbird/cli` exports `parseScenario`, `loadScenarioFiles`, and `runScenario`. In core, `INVALID_SCENARIO` joins the error codes (exit 2 in the CLI), and `ScenarioResult` gains `file`, `stepsRun`, `failedStep.repetition`, `failedStep.expected`, and `artifactErrors`, with `artifacts` nullable; the never-implemented daemon-side `scenarioRun` operation leaves the protocol docs.
```

- [ ] **Step 8: Run the whole suite, lint, and typecheck**

Run: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`
Expected: the build succeeds, lint and typecheck report nothing, and every unit and serial test passes. Per the project's CI note, run `pnpm test` once under Node 22 (`nvm use 22` or equivalent) before pushing.

- [ ] **Step 9: Commit**

```sh
git add packages/cli/src/scenario/format.ts packages/cli/src/cli/program.ts packages/cli/src/cli/program.test.ts docs/cli.md .changeset/m2-scenarios.md
git commit -m "Add ironbird scenario run"
```

---

## Spec discrepancies

None found between the spec and the code it builds on; the names in the contract match what the plan produces. Three points the spec leaves open are decided here rather than silently:

1. **Old `daemon.json` without `artifactsPath`.** Spec §6 says `resolveDaemon` returns the recorded path or `<cwd>/.ironbird`. A `daemon.json` written by a daemon that predates this change has no `artifactsPath`; the directory discovery found it in is the artifacts directory by construction (`serve` writes `daemon.json` into `artifactsPath`), so `resolveDaemon` uses that before falling back to `<cwd>/.ironbird` (Task 6). This only widens the spec's rule.
2. **A missing path or an empty directory passed to `scenario run`.** Not covered by the spec. Both fail with `INVALID_SCENARIO` and exit 2 (Task 3), the same class as an invalid file, so the JSON error shape is uniform and `loadScenarioFiles`, which plan 3 and M3 call in process, never throws a CLI-only `UsageError` across the package boundary (hard rule 8).
3. **`repetition` on single-run steps.** Spec §6 says a failure "reports which repetition failed" and `repetition` counts from 1. The runner includes `repetition` only when the step's `repeat` is above 1 (Task 4), so a plain step's `failedStep` stays as cli.md's example shows it. cli.md records this.

Also noted for the record, not deviations: `errors.test.ts` pins the number of error codes and moves from 19 to 20 (Task 1); cli.md's current example scenario and `scenario run` section are replaced per spec §10 (Task 7); and the `@ironbird/testing` sketch in api.md that mentions `runScenario(file, ...)` is a P1 sketch outside this plan and is left alone.

## Self-Review

**Spec coverage.** D5 (CLI-side runner, one existing operation per step, exported for M3): Task 4. D6 (unsettled `send`, `fake`, `clock` fail; quiescent counts; `settle: false` opts out): Task 4, `repeated`. D7 (support decided from `describe`, never by catching `UNSUPPORTED`): Task 4, `blocker`. D8 (`yaml` package, YAML 1.2, line numbers): Task 2. §6 parsing (top-level fields, one kind per step, unknown keys rejected, durations through `parseDuration`, conditions through `parseCondition`, `INVALID_SCENARIO` with `{ file, issues: [{ path, message, line? }] }`, payloads unchecked): Task 2. §6 target pinning from the `describe` envelope and passing it explicitly on every later operation including `screenshot`: Task 4. §6 support table and `UNKNOWN_FAKE` with suggestions for a fake the target lacks: Task 4. §6 `repeat`: Task 4. §6 failure table (four rows): Task 4. §6 initial `describe` failure ends the command with its own exit code: Task 4 throws it, Task 7's `wrap` maps it (5, 2, 1 covered by tests). §6 `ScenarioResult` shape: Task 1. §6 artifacts (`artifactsPath` in `daemon.json`, `resolveDaemon` result, run directory naming, the six kinds of files, cursors at start and after `reset`, best effort with `artifactErrors`, `artifacts: false`): Tasks 4, 5, 6. §6 command (paths, directory expansion in name order, parse everything first, JSON lines or summaries, exit codes 2/describe/4/0, `--bail`, global `--target`): Tasks 3 and 7. §8 CLI unit tests: parsing for every step kind, unknown keys, conditions, durations, line numbers (Task 2); runner against a scripted client for pinning, the support table, optional skips, `UNKNOWN_FAKE` suggestions, the unsettled rule on all three kinds, `repeat`, every failure shape (Task 4), cursors restarting after `reset` and best-effort artifacts (Task 5); `scenario run` exit codes, `--json`, directory expansion (Task 7). §9 `INVALID_SCENARIO` in `ERROR_CODES` and the usage set: Task 1. §10 cli.md (`scenario run`, step table `settle` on `fake` and `clock`, the `UNSUPPORTED`/`UNKNOWN_FAKE` rows, the gate scenario replacing the old example, `expected` in the failure example, `artifactsPath` in the `serve` section, `ScenarioResult` in output shapes): Tasks 1, 6, 7. §10 protocol.md (`scenarioRun` removed, `ScenarioResult` moved out, `INVALID_SCENARIO` in the error table): Task 1. §10 changesets for core and cli including the `yaml` dependency: Tasks 1 and 7; the `yaml` justification in the commit message: Task 2. Plan 1 owns `fakeCalls`, `FakeCall`, `clockAdvance`'s documented `settle?`, and the `fake` command, and plan 3 owns the example scenarios and the gate tests.

**Placeholder scan.** Every code step carries a complete file or an exact replacement quoted in full. Task 5 edits `run.ts` with four quoted replacements rather than a whole-file rewrite; each names the exact line it replaces. Task 4's `artifacts.ts` is a complete module that Task 5 replaces in full. The `events` and `getState` responders in Task 4's last test are declared unused until Task 5 and are stated as such. No step says "similar to" or "add handling".

**Type consistency.** `ScenarioIssue.path` is `Array<string | number>` in `parse.ts`, and `fromZod` filters Zod's `PropertyKey[]` down to that; `locator` accepts `ReadonlyArray<string | number>`. `ScenarioStep` members carry `optional` and `raw`, which `run.ts` reads as `step.optional` and `step.raw`, and the `kind` values match the seven `STEP_KINDS`. `parseScenario(source, file)` and `loadScenarioFiles(paths, cwd)` are called with those argument orders in `run.test.ts` and `program.ts`. `runScenario(client, scenario, { file, target?, artifacts })` is called identically from `run.test.ts` and `program.ts`, and `RunScenarioOptions.artifacts: string | false` maps to `ScenarioResult.artifacts: string | null`. `createRunArtifacts` takes `{ root, scenario, file, client, target, description }` and `run.ts` passes exactly those; `RunArtifacts.collect` returns `ScenarioResult`, which `runScenario` returns as its result. `resolveDaemon` returns `ResolvedDaemon` with `artifactsDir: string`, which `context()` copies into `Context.artifactsDir`; `Context.json` mirrors the `createOutput` flag. `exitCodeForError('INVALID_SCENARIO')` is 2 because `USAGE` gains the code in the same task that adds it to `ERROR_CODES`, and `IronbirdError`'s constructor accepts it only once core's `dist` is rebuilt, which Task 1 does before the CLI typecheck. `FakeCallsResult` is consumed only in Task 5's `artifacts.ts` as a type-only import with the plan 1 dependency stated.

## Cross-plan review (2026-09-26)

- Task 5 Step 1: the five `events`/`fakeCalls` responders are annotated `(params: Record<string, unknown>)`; unannotated they were implicit `any` (the `Responder | unknown` union collapses to `unknown`) and `packages/cli/tsconfig.json` typechecks test files, so `pnpm typecheck` failed. Confirmed in a scratch copy of the tree with all three plans applied: `tsc` clean, the 14 runner tests pass.
- Task 3 Step 1: `mkdir(path.join(dir, 'scenarios/nested'))` gains `{ recursive: true }`; without it the test threw `ENOENT` because `scenarios/` did not exist yet. Confirmed in scratch: all 13 parser tests pass.
- Task 2 Step 2: the YAML syntax test expects `line: 3`, not 2; that is the line `yaml` 2.9.0 reports for the unclosed flow sequence (verified against the package). Step 5's note records it.
- Task 1 Step 5, protocol.md: the `ScenarioResult` cross-reference is placed relative to the `pending` paragraph plan 1 inserts at the same fence, so the two edits compose.
- Task 7 Step 6, cli.md: the `stepsRun` sentence now says a step that fails its support check before anything is sent is not counted, which is what the runner does (`failedStep` is set before `stepsRun` increments) and what the Task 4 test on `stepsRun: 1` asserts.
