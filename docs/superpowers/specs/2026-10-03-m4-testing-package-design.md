# M4: Testing package, design

| | |
|---|---|
| Status | Drafted 2026-10-03 under the maintainer's autonomy grant; revised after a codex review (CJS runner subpath, schema handling, race witness and deterministic smoke, test discovery, fc.check, trace output, Stryker config) |
| Milestone | M4 in [roadmap.md](../../roadmap.md) |
| Builds on | [architecture.md](../../architecture.md) §2 package table · [api.md](../../api.md) "@ironbird/testing (P1, sketch)" · [testing-strategy.md](../../testing-strategy.md) coverage targets and guidance · [M2 design](2026-09-25-m2-fakes-and-scenarios-design.md) D5 (CLI-side runner) · [M3 design](2026-09-29-m3-agent-interface-design.md) §4.1 (headless lifecycle) |

This spec records only what the existing docs leave open for M4. Where it and an older doc disagree, this spec wins, and the older doc is updated in the same pull request as the code.

## 1. Scope

M4 delivers R18 (`@ironbird/testing`), resolves Q6, and raises the clock and tracker mutation score:

- `@ironbird/testing`: an in-process test target, a scenario runner for test suites, and `modelTest`, a model-based testing helper built on fast-check.
- A JSON-Schema-to-fast-check payload generator (Q6).
- StrykerJS mutation testing for `packages/core/src/clock.ts` and `tracker.ts`, and the tests needed to reach the target.
- A guide for pairing ironbird with React Native Testing Library.

The exit criteria and how each is measured:

| Criterion (roadmap) | Measured by |
|---|---|
| With the planted scenario removed, model-based testing finds the race within 1,000 runs for at least 9 of 10 seeds | `examples/checkout/test/model.gate.test.ts`, run by `pnpm gate:m4`: `modelTest` against the example's headless definition with `PLANT_RACE=1`, steps and invariant as in §6.4, `numRuns: 1000`, seeds 1 to 10. No scenario file is involved. It records, per seed, whether a counterexample was found and after how many runs. A control run of the same configuration without `PLANT_RACE` must find nothing in 10 × 1,000 runs, so the invariant is not trivially false |
| Mutation score ≥ 70% on the clock and tracker | `pnpm mutation` runs StrykerJS on `clock.ts` and `tracker.ts` with the core unit tests; its `break` threshold is 70 |

Both results go in `docs/evals/m4-testing-package.md`.

Out of scope: a browser runner, fake-backed component rendering inside `@ironbird/testing`, `fc.commands`-style stateful models with a separate model state (the app is the model; invariants check it), parallel runs, and snapshot steps (R15, M5).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `@ironbird/testing` is a new Node-only package (ESM and CommonJS builds) depending on `@ironbird/core`, `@ironbird/cli`, and `fast-check` ^4. It imports the CLI only through a new dual-format subpath, `@ironbird/cli/runner`, which exports `createHeadlessTarget`, `loadScenarioFiles`, `parseScenario`, `runScenario`, and their types | It reuses the CLI's headless target and scenario engine instead of re-implementing them, so suites and agents run identical code. The CLI's main entry is ESM-only (`require('@ironbird/cli')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`), so CommonJS users and Jest need a subpath that ships both formats; the runner modules have no top-level await. New dependencies outside core and the bridge need no ADR (AGENTS.md rule 7); the PR carries the justification line |
| D2 | Tests run against an in-process target: an adapter that implements the CLI's `DaemonClient` over a `HeadlessTarget`, with no daemon, port, or child process | Fast enough for 10,000-run model tests, and `runScenario` already takes a `DaemonClient` (M2 D5) |
| D3 | Q6: payload arbitraries are derived from the JSON Schema that `describe()` emits, by a small in-house generator, with per-command and per-control overrides | The JSON Schema is what agents already see, so tests and agents explore the same payload space. It decouples the helper from the Zod version (Q8). The maintained Zod-to-fast-check libraries target Zod 3. Overrides cover what a schema can't say, such as "a SKU in the catalog" |
| D4 | The app is the model: each run boots a fresh target, applies a generated sequence of steps, and checks every invariant against the whole state after each step | No second model to keep in sync. Invariants express what must never happen, which is what the planted race violates |
| D5 | A step the app rejects (`DISPATCH_FAILED`, `UNSUPPORTED`, a fake control's error) is recorded and the run continues; `onStepError: 'fail'` makes it fail the run instead. `INVALID_PAYLOAD` always fails, because the generator promised valid payloads | Random sequences often try actions that are invalid in the current state; that is not a bug. A generator producing invalid payloads is |
| D6 | A counterexample is reported as an `IronbirdError` with the new code `INVARIANT_FAILED` and written as a scenario file. The details are `{ invariant, seed, path, runs, steps, scenarioFile }`, and the file is the shrunk steps in scenario YAML | Errors crossing a package boundary are `IronbirdError`s (rule 8). The scenario file lets a developer or agent replay the failure with `ironbird scenario run` on headless or a device, which closes the loop with M2 and M3 |
| D7 | The M4 race gate runs in a separate Vitest project, `gate`, through `pnpm gate:m4`, and is not part of `pnpm test`. CI instead runs a deterministic smoke: a fixed witness sequence must violate the invariant, and `modelTest` with one seed measured by the gate to find the race within 1,000 runs must find it again | Ten seeds of 1,000 runs, plus the control, may take minutes. A random smoke with unmeasured seeds would be flaky; at about 0.5% per run (codex's simulation of the proposed steps), two unmeasured 200-run seeds both succeed only about 41% of the time. Determinism for a fixed seed makes the measured seed a stable regression check |
| D8 | Mutation testing uses StrykerJS with the Vitest runner, scoped to `clock.ts` and `tracker.ts` and to core's unit tests, run by `pnpm mutation` and not in CI | The testing strategy names StrykerJS. Mutation runs are slow, and the target is a milestone gate, not a per-commit check |
| D9 | `@ironbird/testing` imports no test framework. Vitest exercises it, and a one-file Jest smoke runs its CommonJS build in CI | "Runs scenarios in Vitest or Jest" (R18) is then demonstrated, not claimed. The Jest smoke needs no transform because it requires the built CommonJS output |
| D10 | The React Native Testing Library guide is documentation with code samples, not a new example test suite | The example deliberately has no component tests (AGENTS.md); the guide shows how a team shares commands and the headless definition between RNTL tests and ironbird |

## 3. Work breakdown

Three plans, in dependency order:

1. **Testing package:** the package scaffold, `createTestTarget`, `runScenario`, the schema generator, `modelTest` with shrinking and scenario output, `INVARIANT_FAILED`, the Jest smoke, and the docs (api.md, the RNTL guide).
2. **Race gate:** the example's model test, `pnpm gate:m4`, the CI smoke, and the measured result.
3. **Mutation:** the Stryker setup, `pnpm mutation`, the added clock and tracker tests, and the measured score.

Plan 3 is independent of plans 1 and 2.

## 4. The in-process target

```ts
function createTestTarget(options: {
  headless: HeadlessDefinition;
  appId?: string;                       // default 'test'
  env?: Record<string, string | undefined>;
  clockStart?: string;
  settleTimeoutMs?: number;             // default 5000
}): Promise<TestTarget>;

interface TestTarget {
  readonly client: DaemonClient;        // the CLI's client interface, served in process; stream() is UNSUPPORTED
  send(command: string, payload?: unknown): Promise<StepResult>;
  fake(fake: string, control: string, payload?: unknown): Promise<StepResult>;
  advance(ms: number): Promise<StepResult & { now: number }>;
  state<T = unknown>(path?: string): Promise<T>;
  describe(): Promise<Description>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}
```

`client.call(op, params)` maps to `target.run(op, params)` and returns `{ target: 'headless', result }`; `rpc` returns the result alone; errors propagate as the target's `IronbirdError`s. The convenience methods wrap the same calls. The adapter lives in `@ironbird/testing`; `createHeadlessTarget` comes from `@ironbird/cli`.

## 5. The scenario runner

```ts
function runScenario(file: string, options: {
  headless: HeadlessDefinition;
  env?: Record<string, string | undefined>;
  artifacts?: string | false;           // default false: test suites write nothing unless asked
}): Promise<ScenarioResult>;
```

It loads and validates the file with the CLI's `loadScenarioFiles`, boots a test target, runs `@ironbird/cli`'s `runScenario` with `reset: true`, disposes the target, and returns the result. An invalid file throws `INVALID_SCENARIO`. A scenario that fails returns `passed: false`, so the suite asserts on it (`expect(result.passed).toBe(true)`), keeping `failedStep` visible in the assertion diff. This replaces the sketch's signature in api.md.

## 6. `modelTest`

```ts
function modelTest<S = unknown>(options: {
  headless: HeadlessDefinition;
  env?: Record<string, string | undefined>;
  steps: Array<
    | string                                              // a command; payload generated from its schema
    | { command: string; payload: fc.Arbitrary<unknown> | unknown[] }
    | { fake: string; control: string; payload?: fc.Arbitrary<unknown> | unknown[] }
    | { clock: { maxMs: number } }
  >;
  invariants: Record<string, (state: S) => boolean>;
  maxSteps?: number;        // default 20
  numRuns?: number;         // default 100
  seed?: number;            // default: fast-check's
  onStepError?: 'skip' | 'fail';   // default 'skip'
  artifacts?: string | false;      // default '.ironbird/model'; counterexample scenario files go here
}): Promise<ModelTestResult>;

interface ModelTestResult { runs: number; seed: number; stepsApplied: number; stepsRejected: number }
```

### 6.1 Generation

- A run is `fc.array(stepArbitrary, { minLength: 1, maxLength: maxSteps })`, where `stepArbitrary` is `fc.oneof` over the declared steps, each equally weighted.
- A command or control without an explicit `payload` gets an arbitrary from its JSON Schema (§6.3). A `payload` that is an array is `fc.constantFrom(...array)`.
- A clock step is `fc.integer({ min: 0, max: maxMs })`.
- The declared steps are checked against `describe()` before any run. An unknown command, fake, or control fails with `UNKNOWN_COMMAND`, `UNKNOWN_FAKE`, or `UNKNOWN_CONTROL` and suggestions, as the CLI does. A clock step on a target without `clock` fails with `UNSUPPORTED`.

### 6.2 Execution

- Each run uses one test target created once per `modelTest` call. The property resets it at the start of every execution, including every shrink attempt, so runs are independent and deterministic for a seed (the manual clock, fresh fakes).
- Each step is one operation with settling: `dispatch`, `fakeControl`, or `clockAdvance`.
- After every step, including rejected ones, every invariant runs against the root state. An invariant that returns false or throws is a violation. Its error message is kept.
- `fc.check(fc.asyncProperty(...), { numRuns, seed })` drives the runs and returns `RunDetails`. `fc.assert` throws without structured details, so it is not used. Fast-check shrinks a failing run to a minimal step sequence. On failure, `modelTest` reads `counterexample`, `counterexamplePath`, `seed`, and `numRuns` from the details, resets, replays the counterexample once to capture which invariant failed and its message, and then throws.

### 6.3 The schema generator (Q6)

`arbitraryFromSchema(schema: JsonSchema): fc.Arbitrary<unknown>` covers the subset Zod 4's `toJSONSchema` emits for payload schemas:

| Schema | Arbitrary |
|---|---|
| `type: object` with `properties` and `required` (`additionalProperties` absent or `false`; zod's plain `z.object` omits it, `z.strictObject` emits `false`) | `fc.record` with the keys in `required` always present and the others sometimes; no extra keys are ever generated, so strict and loose objects both accept the output |
| `enum`, `const` | `fc.constantFrom`, `fc.constant` |
| `type: string`, with `minLength` / `maxLength` | `fc.string` with those bounds |
| `type: integer` / `number`, with `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` | `fc.integer` / `fc.double` (no NaN, no infinities) within the bounds |
| `type: boolean`, `type: null` | `fc.boolean`, `fc.constant(null)` |
| `type: array` with `items`, `minItems`, `maxItems` | `fc.array` |
| `anyOf`, `oneOf` | `fc.oneof` |

Annotation keywords (`description`, `title`, `default`, `examples`, `$schema`, `deprecated`, `readOnly`) are ignored. Any other keyword, such as `pattern`, `format`, or `$ref`, throws `INVALID_PAYLOAD`. Its details name the command and the schema path and say to pass a `payload` override. A generated payload is therefore always valid against the schema the app declared, and something the generator can't produce is never guessed.

### 6.4 The counterexample

On a violation, `modelTest` throws `IronbirdError('INVARIANT_FAILED', ...)`:

- The message is `Invariant "<name>" failed after <k> steps (seed <seed>, path <path>); trace: <file>`, or without the trace clause when no file was written.
- `details` is `{ invariant, message, seed, path, runs, steps, scenarioFile }`, where `steps` are the shrunk steps as scenario step objects.
- Unless `artifacts` is `false`, the shrunk run is written as a **trace**: a valid scenario file under `artifacts`, named `<timestamp>-<invariant-slug>.trace.yaml`, that drives the target into the violating state. It has no `expect`, because invariants are code, not conditions, so running it passes; it reproduces the state rather than asserting on it. The docs say to add `wait` and `expect` steps to turn a trace into a regression scenario. The file is exactly:

```yaml
name: "Counterexample: <invariant>"
description: "modelTest seed <seed>, path <path>. A trace: it reproduces the violating state; add expect steps to make it a regression check."
steps:
  - reset: true
  - send: <command>
    payload: <payload>
  - fake: <fake>
    control: <control>
    payload: <payload>
  - clock: <ms>
```

with one entry per shrunk step, in order, and `clock` steps as plain millisecond numbers, not optional, because the trace's timing is exact only on headless. A unit test round-trips every written trace through `parseScenario`. When `artifacts` is `false`, the message omits the replay instruction and `scenarioFile` is `null`.

The gate configuration for the example:

```ts
await modelTest<CheckoutState>({
  headless,
  env: { PLANT_RACE: '1' },
  steps: [
    { command: 'cart.addItem', payload: [{ sku: 'cut-45', qty: 1 }, { sku: 'beard-20', qty: 2 }] },
    { command: 'payment.start', payload: [{ method: 'saved' }, { method: 'card' }] },
    { fake: 'api', control: 'setEcho', payload: [{ mode: 'manual' }, { mode: 'auto' }] },
    { fake: 'api', control: 'emit', payload: [{ event: 'payment.succeeded' }, { event: 'order.confirmed' }, { event: 'payment.failed' }] },
    { clock: { maxMs: 1000 } },
  ],
  invariants: {
    'completed orders have a non-zero total': (s) => !(s.order.status === 'completed' && s.order.totalCents === 0),
  },
  numRuns: 1000,
  seed,
});
```

The SKUs come from the example's catalog, not from the schema, because `sku` is a free string; this is what overrides exist for.

The race needs a clock advance: after `payment.start` with `saved`, the payment is `submitting`, and success is ignored until the fake's submission resolves 300 ms later and moves it to `awaitingServerEcho`. Two witnesses exist:
- The reliable one has five steps: manual echo, add an item, start a saved payment, advance at least 300 ms, then emit success.
- A shorter one has four: the same without manual echo, with an advance of 300 to 799 ms so success arrives before the automatic confirmation.

Codex's sampling of the proposed step distribution estimates about 0.5% of runs contain a witness, which makes 9 of 10 seeds within 1,000 runs plausible but not certain. Plan 2 measures it first. The CI smoke uses the reliable witness as a fixed sequence.

## 7. Mutation testing

- Root dev dependencies: `@stryker-mutator/core` and `@stryker-mutator/vitest-runner`, at matching current versions.
- `stryker.config.json` at the root sets `mutate` to `packages/core/src/clock.ts` and `packages/core/src/tracker.ts`. It runs core's unit tests through the Vitest runner, with `vitest.configFile` set to a new `packages/core/vitest.stryker.config.ts` that includes only `packages/core/src/**/*.test.ts`; the root config's projects include daemon and device tests. The plan confirms the collected test list and records the Stryker and Vitest versions with the score. The config uses the `clear-text` and `json` reporters, and sets `thresholds: { high: 85, low: 70, break: 70 }`.
- `pnpm mutation` runs it; `reports/mutation/` is gitignored.
- The plan measures first, then adds tests that kill surviving mutants that represent real behavior. Equivalent mutants are listed in the evals record with reasons rather than chased.
- Tests stay in `clock.test.ts` and `tracker.test.ts`, including fast-check property tests where an invariant from testing-strategy.md covers the mutant.

## 8. Testing

- **Unit (`packages/testing`):**
  - `arbitraryFromSchema` over every row of §6.3, with generated values validated against the source Zod schema, plus every unsupported keyword.
  - The `DaemonClient` adapter: ok, error, and stream `UNSUPPORTED`.
  - `runScenario` passing, failing, and on an invalid file.
  - `modelTest` against a small inline headless definition with a deliberate bug: it finds the bug, shrinks to the minimal sequence, throws `INVARIANT_FAILED` with the details, writes a valid scenario file that `parseScenario` accepts, and is deterministic for a seed.
  - `modelTest` with no bug finds nothing. `onStepError` behaves both ways.
  - Declared steps are validated before runs.
- **Jest smoke:** `packages/testing/jest/smoke.test.cjs` requires the CommonJS build, which requires `@ironbird/cli/runner`'s CommonJS build, and runs one scenario and one tiny model test. It runs in CI as `pnpm --filter @ironbird/testing test:jest` on both Node versions. A unit test also checks that `require('@ironbird/cli/runner')` and `import('@ironbird/cli/runner')` both load.
- **Serial:** the CI race smoke from D7, in `examples/checkout/test/model.smoke.test.ts`. The `serial` project's `include` gains that file, and the new `gate` project includes only `examples/checkout/test/model.gate.test.ts`. The plan verifies both with `vitest list`.
- **Gate:** `pnpm gate:m4` (§1).
- **Mutation:** `pnpm mutation` (§7).

## 9. Errors, types, and docs

- New error code `INVARIANT_FAILED`, details `{ invariant, message, seed, path, runs, steps, scenarioFile }`. This is an additive protocol change: protocol.md's error table gains the row and `PROTOCOL_VERSION` is unchanged. It never crosses the wire. It lives in the shared table because rule 8 requires codes from it.
- api.md: the `@ironbird/testing` section is rewritten from the sketch to the final API (§4–§6).
- New `docs/guides/react-native-testing-library.md`. It shows sharing `commands` and the app core between an RNTL component test and the headless definition, driving the same commands in both, and when to use which.
- spec.md: R18 ticked at the gate; Q6 marked resolved with D3. roadmap.md: M4 criteria ticked. architecture.md §2: the package table row for `@ironbird/testing` loses "(P1)" and lists its real dependencies.
- New `docs/evals/m4-testing-package.md` with both measurements.
- Changesets: `@ironbird/testing` (new package, initial version 0.0.1 through the normal pipeline), `@ironbird/core` for `INVARIANT_FAILED`, and `@ironbird/cli` for the `./runner` subpath. cli.md and api.md document the subpath.
- **Release note:** a new package can't be published over OIDC until it exists on npm (the 0.0.2 lesson). The milestone PR says so: the maintainer publishes `@ironbird/testing` once by hand before merging the Version Packages PR, then adds trusted publishing.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Uniform step weighting makes the race too rare to find in 1,000 runs | Codex's sampling estimates about 0.5% per run (§6.4). Plan 2 measures on day one. If fewer than 9 of 10 seeds find it, the documented fix is per-step weights (a `weight` on a step, fed to `fc.oneof`), recorded in the evals record. The gate itself does not change |
| 10,000 runs are too slow | The in-process target avoids the daemon; the M2 determinism test ran 500 scenario runs in about 1.5 s. Measured on day one |
| Stryker cannot run Vitest projects from the root config | The Stryker config points at a core-only Vitest config file created for it |
| `@ironbird/cli` as a dependency pulls in esbuild, ws, and the MCP SDK for test users | Acceptable for a dev dependency; the reuse avoids a second scenario engine. Revisit if users object |
| Mutants equivalent by construction keep the score under 70% | They are listed with reasons; the threshold applies to the score Stryker reports, and the evals record shows the gap honestly if it remains |
