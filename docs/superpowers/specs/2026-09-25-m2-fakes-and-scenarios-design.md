# M2: Fakes and scenarios, design

| | |
|---|---|
| Status | Reviewed and approved by a second model 2026-09-25; awaiting maintainer approval |
| Milestone | M2 in [roadmap.md](../../roadmap.md) |
| Builds on | [architecture.md](../../architecture.md) §6.3, §6.5 · [protocol.md](../../protocol.md) operation tables, `Description`, `ScenarioResult`, error table · [api.md](../../api.md) `defineFake` · [cli.md](../../cli.md) `fakes`, `fake`, `scenario run`, "Scenario files", exit codes · [testing-strategy.md](../../testing-strategy.md) headless determinism |

This spec records only what the existing docs leave open for M2. Everything they already fix, such as the `StepResult` shape, the condition operators, and the scenario step table, is referenced rather than restated. Where this spec and an older doc disagree, this spec wins, and the older doc is updated in the same pull request as the code.

## 1. Scope

M2 delivers R6 (fakes with controls), R11 (scenario files), and R16 (the fake call log):

- `defineFake` in `@ironbird/core`, with call recording on every fake port.
- The `fakeControl` and `fakeCalls` operations on the headless target, and the `fake` CLI command. The bridge already implements both operations; `fakeCalls` is promoted from P1 to P0.
- The scenario runner and `ironbird scenario run`.
- The example's two hand-written fakes rewritten with `defineFake` and wired into both the headless and the device build, five example scenarios, and the tests that measure the exit criteria.

The exit criteria and how each is measured:

| Criterion (roadmap) | Measured by |
|---|---|
| A scenario reproduces the planted race: it fails with `PLANT_RACE=1` and passes without it | A serial-project test that boots the daemon twice, once per setting, and runs the race scenario on headless (§8). The roadmap's overview row says "on both targets", so the device build gains the same flag (D12) and the evals record includes one iOS run with it set, bundled with `EXPO_PUBLIC_PLANT_RACE=1 pnpm example:ios` after clearing Metro's cache |
| The same scenario, with clock steps marked optional, reaches the same final state on the headless and iOS targets | A device test that runs the race scenario, unplanted, on a freshly reloaded iOS app and on a freshly reset headless target, then compares the whole final state (§8) |
| 100 consecutive headless runs of every example scenario show 0 divergences | A serial-project test in CI, 100 runs per scenario with `reset` between runs (§8) |

Out of scope: `snapshot` steps (P1), the MCP server (M3), a daemon-side scenario operation, a per-step policy for unsettled steps, fake controls on Android beyond what the shared device build gives for free (not measured in M2), and property-based generation (M4).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `defineFake` lives in `@ironbird/core` and validates control payloads with `defineCommands` | One validation path: `INVALID_PAYLOAD` with issues and JSON Schema for `describe` come from the registry. The fake adds its own `UNKNOWN_CONTROL` check, because the registry's unknown-name error is `UNKNOWN_COMMAND` |
| D2 | A fake's control handlers are returned from `create` next to the port, typed as a complete map over the declared controls, instead of registered with `on()` as the api.md sketch has it | TypeScript rejects a missing handler at compile time, and there is no runtime registration state. Verified under TypeScript 6 with Zod 4: `Port` and the handler payloads infer without annotations. TypeScript does not reject an extra handler here, so `create` checks the keys at runtime (§4) |
| D3 | Every fake port is served through a call-recording proxy whose target is a fresh object that forwards to the port, never the port itself; the proxy reports the fake mark | R16 needs the calls. A proxy over the port itself would violate proxy invariants on a frozen port, and `tracker.wrap` proxies the result again (M0 note). Forwarding also keeps class instances, whose methods live on the prototype, working. Quiescence needs the mark |
| D4 | R16 ships in M2: the `fakeCalls` operation and `ironbird fake <fake> --calls` | Maintainer decision; small on top of D3, and agents can confirm what the app asked the outside world for |
| D5 | The scenario runner is a CLI-side module that runs each step as one existing operation through the daemon client | Maintainer decision; no protocol change, works against any target the daemon hosts, and M3's MCP server can call the same exported function in process |
| D6 | A `send`, `fake`, or `clock` step that ends unsettled fails the scenario. A headless step that ends quiescent counts as settled. `settle: false` on the step opts out | Maintainer decision; later `expect`s on an unsettled app are unreliable, and the rule matches the CLI, where a quiescent step exits 0. `clockAdvance` returns a settled `StepResult` and already honors `settle`, so it follows the same rule |
| D7 | Whether an `optional: true` step is skipped is decided from the target's `describe` before the step runs, never by catching `UNSUPPORTED` | A skipped step must not half-run, and a real `UNSUPPORTED` from inside a supported step must still fail the scenario |
| D8 | Scenario files are parsed with the `yaml` package | YAML 1.2 by default, so `on` and `yes` stay strings; no dependencies of its own; reports line numbers for errors; already in the lockfile transitively at 2.9.0 |
| D9 | The race scenario controls the order of server events through an api fake control that turns off the automatic echo | The current fake always sends `order.confirmed` before `payment.succeeded`, so the planted race can never fire without control over ordering |
| D10 | Cross-target equality is a whole-state comparison after a fresh start on each target: `reset` on headless, a Metro reload on iOS | Remote targets have no `reset`. A reload recreates the JS runtime, the fakes, and their id counters, so even `pay_1` and `ord_1` match |
| D11 | The 100-run determinism check is a serial-project test that runs in CI, calling the runner in process, with an environment variable for longer local soaks | Maintainer decision; determinism stays proven on every commit. In process is required for the time budget (§8) |
| D12 | The example's device build plants the race when `EXPO_PUBLIC_PLANT_RACE=1`, the way the headless entry reads `PLANT_RACE` | Today only the headless entry can plant the race, which makes the roadmap's "on both targets" wording unachievable. Expo inlines `EXPO_PUBLIC_*`, as `index.js` already relies on. The value is fixed when Metro bundles, so the planted iOS run needs Metro restarted with the variable set and its cache cleared |
| D13 | `fakeCalls` returns a cursor like `events`: params `since?` and `limit?`, result `{ calls, nextSeq, truncated }` | The runner has to learn where each fake's log stands at the start of a run without transferring up to 10,000 calls, and agents paging through calls get the same model as events |

## 3. Work breakdown

Three implementation plans, in dependency order. Plan 2 needs plan 1 only for `fake` steps and can start against the M0 operations.

1. **Fakes:** `defineFake` and the call log in core; `fakeControl` and `fakeCalls` on the headless target; the bridge's `fakeCalls` result and `UNKNOWN_FAKE` details; the `fake` command; the protocol and API docs.
2. **Scenarios:** parsing and validation, the runner, artifacts, `INVALID_SCENARIO`, and `scenario run`.
3. **Example and gate:** the rewritten fakes, headless and device wiring including D12, the example scenarios, the race and determinism tests, the cross-target device test, and the M2 exit-criteria record. The determinism test's run time is measured on the first day of this plan, not at the gate.

## 4. `defineFake`

```ts
function defineFake<Port extends object, C extends Schemas>(
  name: string,
  definition: {
    description?: string;
    controls: C;
    create(context: FakeContext): { port: Port; controls: ControlHandlers<C> };
  },
): FakeFactory<Port, C>;

interface FakeContext {
  readonly clock: Clock;
  /** Records an event with the fake's name as its source. A no-op without a recorder. */
  record(name: string, data?: unknown): void;
}

type ControlHandlers<C extends Schemas> = {
  [K in keyof C]: (payload: z.output<C[K]>) => void | Promise<void>;
};

interface FakeFactory<Port extends object, C extends Schemas> {
  readonly name: string;
  create(deps: { clock: Clock; recorder?: EventRecorder }): FakeInstance<Port, C>;
}
```

`FakeInstance` keeps the shape core already exports, `name`, `description`, `port`, `controls` (the registry), and `control(name, payload)`, with one change: `calls(since = 0, limit = Infinity)` returns `{ calls, nextSeq, truncated }` like `EventRecorder.since`, instead of a bare array (D13). The bridge is the only consumer today and changes in the same release.

**Creating an instance.** `create` runs the definition's `create` and checks that the returned handler keys equal the declared control names. A missing handler is already a compile error; an extra one, such as `emitt` next to `emit`, fails here with `UNKNOWN_CONTROL`, details `{ fake, control, suggestions }`. That is a programming error, so it surfaces as a boot failure with that code on headless and as a red box on device.

**Running a control.** `control(name, payload)` first checks that the control exists, failing with `UNKNOWN_CONTROL`, details `{ fake, control, suggestions }`. It then parses the payload with the registry and awaits the handler. Errors name the control as `'<fake>.<control>'`: an invalid payload fails with `INVALID_PAYLOAD`, details `{ name, issues }`, and a handler that throws or rejects fails with `DISPATCH_FAILED`, details `{ name, message }`, the same code a throwing command uses. An `IronbirdError` from a handler passes through unchanged.

**Call log (R16).** The instance's `port` is a proxy whose target is a fresh object that forwards reads to the object `create` returned (D3). Reading a function-valued property returns a wrapper, created once per property and cached, that records a `FakeCall` and invokes the original with `this` bound to the returned object. The cache matters beyond speed: `tracker.wrap` identifies methods by identity, so a fresh wrapper on every read would allocate a fresh tracked wrapper on every call. Non-function properties and symbol keys pass through untouched, except that the proxy answers the `FAKE_PORT_MARK` lookup with `true`. The proxy forwards property reads and `in`. A port is a bag of methods, so enumeration, spread, and `instanceof` are not forwarded.

Each call gets a sequence number per fake starting at 1, the clock time, the method name, and the arguments serialized with core's `serializeState`, so a listener argument becomes a placeholder rather than failing. The outcome is `returned` or `threw` for a synchronous call. A call that returns a promise is recorded as `pending` and updated to `resolved` or `rejected` when it settles; `threw` and `rejected` also carry the error's message. `calls()` returns copies, so a caller never sees an entry change after reading it, and a caller that wants the final outcome of a pending call reads again. Calls are kept in a buffer of 10,000 per fake that drops the oldest, and `truncated` reports when `since` points into the dropped range. Recording is always on: fakes exist only in headless and development builds.

**Tracker interplay.** `tracker.wrap(fake.port, …)` sees the mark and treats the port as fake-backed for quiescence, exactly as `markFakePort` does today. Nothing in `defineFake` freezes anything.

**Fresh state per boot.** A fake's state lives in the `create` closure. The headless target's `reset` runs the headless definition again, which creates new fakes, so counters, pending timers, and call logs all start over. This is what makes 100 headless runs identical.

## 5. Fake operations and the `fake` command

**Headless target.** Gains `fakeControl` and `fakeCalls`. `fakeControl` is a queued mutating operation, as `MUTATING_OPS` and `QUEUED_OPS` already list it, and returns a `StepResult` settled in quiescent mode, exactly like `dispatch`; the daemon already sizes its request bound from `settle.timeoutMs`. `fakeCalls` is read-only. An unknown fake fails with `UNKNOWN_FAKE`. The `fakes` capability is declared when the app wires at least one fake, as `describe` already does.

**Remote target.** The bridge implemented both operations in M1 and the remote target routes them under the `fakes` capability. Two changes: `fakeCalls` returns the D13 result, and `UNKNOWN_FAKE` details become `{ fake, available, suggestions }` on both targets. The bridge sends `{ name, suggestions }` today, which disagrees with the protocol's error table.

**Protocol.** `fakeCalls` drops its P1 marker and takes `fake`, `since?`, and `limit?`, returning `{ calls, nextSeq, truncated }`. `FakeCall.outcome` gains `threw`, and `FakeCall` gains an optional `error` message. The protocol has had no `fakeCalls` consumer outside this repository, so `PROTOCOL_VERSION` does not change.

**CLI.**

```text
ironbird fake <fake> <control> [payload] [--path <path>] [--no-settle] [--settle-timeout <duration>]
ironbird fake <fake> --calls [--since <seq>]
```

Both forms are one command whose `control` argument is optional: the command requires either a control or `--calls` and rejects both together as a usage error, exit 2. The first form sends `fakeControl` and prints the `StepResult` with the same exit codes as `send`: 0, or 3 when applied but not settled. The second sends `fakeCalls` and prints `{ target, fake, calls, nextSeq, truncated }`. Payloads parse the same way as `send`'s.

## 6. Scenario runner

A module in `packages/cli/src/scenario/` with three files: `parse.ts` turns a file into a validated `Scenario`, `run.ts` exports `runScenario(client, scenario, options): Promise<ScenarioResult>`, and `artifacts.ts` writes the run directory.

**Parsing.** YAML is parsed with line information, then validated with Zod. The top level has `name` (required), `description`, `target`, and a non-empty `steps` list. Each step is exactly one kind, identified by its discriminating key (`send`, `fake`, `clock`, `wait`, `expect`, `screenshot`, `reset`), plus the shared `optional` flag. Unknown keys are rejected, so a typo such as `payloads` fails before anything runs. Durations are a number of milliseconds or a string with an `ms`, `s`, or `m` suffix, parsed by the CLI's existing duration parser. Conditions are exactly one of `equals`, `notEquals`, `exists`, and `matches`, parsed by core's `parseCondition`. An invalid file fails with a new error code, `INVALID_SCENARIO`, details `{ file, issues: [{ path, message, line? }] }`, exit code 2. Payloads are not checked at parse time, because their schemas live in the app; an invalid payload fails its step at run time with `INVALID_PAYLOAD`.

cli.md's step table gains one field: `fake` and `clock` steps accept `settle`, like `send` steps, so D6's opt-out works for all three.

**Target.** The runner's first operation is `describe`, sent to the scenario's `target`, overridden by `--target`, or with no target so the daemon picks its default. The target id in that call's response envelope becomes the run's target: it fills `ScenarioResult.target` and is passed explicitly on every later operation, including `screenshot`. Pinning matters because the daemon resolves an omitted target differently for `screenshot` (the only connected remote app) than for everything else (the configured default). From the same `describe` the runner reads the platform, the capabilities, and the wired fakes.

**Running.** Each step maps to one operation:

| Step | Operation | Supported when |
|---|---|---|
| `send` | `dispatch` with `name`, `payload`, and `settle` | Always |
| `fake` | `fakeControl` with `fake`, `control`, `payload`, and `settle` | The named fake appears in `describe` |
| `clock` | `clockAdvance` with `ms` and `settle` | The target declares `clock` |
| `wait` | `waitFor` with `path`, the condition, and `timeoutMs` (default 5 s) | Always |
| `expect` | `getState` at `path`, then the condition checked locally with core's `conditionHolds` | Always |
| `screenshot` | `screenshot` with an absolute `out` path in the run directory | The platform is not `headless` |
| `reset` | `reset` | The target declares `reset` |

A step whose condition is not met is skipped when it is `optional`, and its index is added to `skipped`. Otherwise it fails before any operation is sent: with `UNKNOWN_FAKE`, details `{ fake, available, suggestions }` built from `describe`, for a `fake` step, so a typo such as `apii` still gets suggestions; and with `UNSUPPORTED` for the other kinds. `repeat` on `send` and `fake` steps runs the operation that many times; a failure reports which repetition failed.

**Failing a step.** The runner stops at the first failing step and reports it.

| Cause | `failedStep` carries |
|---|---|
| A `send`, `fake`, or `clock` step ends with `settle` neither idle nor quiescent (D6) | `actual: { settle }` |
| `wait` times out | `expected`: the condition; `actual`: the value from `WAIT_TIMEOUT`'s details |
| `expect` condition not met | `expected`: the condition; `actual`: the value read |
| Any other `IronbirdError` from the step's operation, including `INVALID_PAYLOAD`, `DISPATCH_FAILED`, `TARGET_DISCONNECTED`, and `NO_TARGET` | `error`: the error shape |

A failure of the initial `describe` ends the command with that error and its own exit code instead of a scenario result: 5 for an unreachable daemon or `NO_TARGET`, 2 for `UNAUTHORIZED`, 1 for `TARGET_DISCONNECTED`. The same errors from a later step fail that step like any other.

**Result.** The core type in `protocol.ts` and protocol.md, extended by what R11 asks for:

```ts
interface ScenarioResult {
  scenario: string;       // the scenario's name
  file: string;
  target: string;
  passed: boolean;
  durationMs: number;
  stepsRun: number;
  failedStep?: { index: number; step: unknown; repetition?: number; expected?: unknown; actual?: unknown; error?: ErrorShape };
  skipped: number[];
  artifacts: string | null;   // null when the caller turned artifacts off
  artifactErrors?: string[];  // artifact files that could not be written, for example after a disconnect
}
```

**Artifacts.** Client commands do not load the config, so the artifacts directory comes from daemon discovery: `resolveDaemon` returns the `.ironbird` directory where it found `daemon.json`, which `serve` writes into its artifacts path, and falls back to `<cwd>/.ironbird`. Every run, passed or failed, writes `<artifacts>/runs/<UTC stamp with milliseconds>-<scenario slug>/`: `result.json`, a copy of the scenario file, `events.jsonl` with the events recorded during the run, `state.json` with the final root state, `calls/<fake>.json` with each fake's calls during the run, and the screenshots from `screenshot` steps. "During the run" means after the cursors captured at its start, `events` and `fakeCalls` with `limit: 0`, or after the last `reset` step, which restarts both. Collection is best effort: a file that cannot be gathered, such as the state after a `TARGET_DISCONNECTED`, is left out and named in `artifactErrors`. `runScenario` accepts `artifacts: false` so the determinism test can skip writing.

**Command.**

```text
ironbird scenario run <path...> [--bail] [--target <id>]
```

A directory expands to its `*.yaml` and `*.yml` files in name order. Every file is parsed before any runs, so an authoring error costs nothing. Output is one `ScenarioResult` per file, as JSON lines when stdout is not a TTY or `--json` is passed, and otherwise as a one-line summary per scenario plus the failed step. The exit code is 2 if any file is invalid, the initial `describe`'s own code if it fails as above, 4 if any scenario failed, and 0 otherwise. `--bail` stops after the first failed scenario.

## 7. Example app

**Fakes.** Both fakes in `src/ironbird/fakes/` are rewritten with `defineFake`, with only the controls the scenarios use. Timings stay as today, the reader's 1,200 ms collection and the api's 300 ms submission and 500 ms echo, and each fake records the same events it records today, so existing tests and the M1 harness numbers are unaffected.

| Fake | Controls |
|---|---|
| `reader` | `emit { event: connected \| disconnected \| cardPresented \| declined }` |
| `api` | `emit { event: order.confirmed \| payment.succeeded \| payment.failed, paymentId?, orderId?, totalCents?, reason? }`; `setEcho { mode: auto \| manual }` (default `auto`) |

In `auto` mode the api fake behaves as it does today: 500 ms after a submission resolves, it emits `order.confirmed` and then `payment.succeeded`. In `manual` mode it emits nothing on its own. `emit` fills omitted ids and the total from the most recent submitted payment. With no submitted payment and those fields omitted, it fails with `DISPATCH_FAILED`, and the message names the payload fields that would have avoided the default.

**Wiring.** `headless.ts` returns `fakes: [reader, api]`. `instance.ts` creates the same two fakes on the real clock, exports them, and passes `plantRace: process.env.EXPO_PUBLIC_PLANT_RACE === '1'` to `createAppCore` (D12). `device.ts` passes the fakes to `startBridge` as `fakes`. Each port still goes through `tracker.wrap` as today.

**Scenarios** in `examples/checkout/ironbird/scenarios/`, the config's default directory. Together they cover three of the testing strategy's standard misbehaving-server cases: missing, duplicated, and reordered events. Delayed events are the missing case with a shorter clock step, and malformed events cannot pass a validated control, so neither gets its own scenario.

| File | What it checks | Targets |
|---|---|---|
| `checkout-saved-card.yaml` | The happy path with the saved card | Both |
| `race-success-before-confirmation.yaml` | The planted race; the gate scenario | Both |
| `duplicate-success.yaml` | A second `payment.succeeded` after completion changes nothing | Both |
| `missing-echo-times-out.yaml` | With the echo held, 30 s of clock fails the payment with a timeout | `target: headless`, since it needs 30 s of clock |
| `reader-disconnect.yaml` | A reader disconnect while collecting fails the payment | `target: headless`, since a remote settle would finish the collection first |

The gate scenario:

```yaml
name: Payment success arrives before order confirmation
description: The server reports the payment succeeded before it confirms the order and its total. The receipt must still show the total.
steps:
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

Without the planted bug, `payment.succeeded` only marks the payment succeeded, and `order.confirmed` then completes the order with its total of 4500. With the bug planted, `payment.succeeded` completes the order at once with a total of 0, the later `order.confirmed` is ignored, and the last `expect` fails with `actual: 0`. Every step settles on both targets: manual-clock timers never count as pending work on headless, and on iOS the 30 s server timeout is beyond the tracker's one-second threshold for real-clock timers.

## 8. Testing

Per [testing-strategy.md](../../testing-strategy.md):

- **Core unit:** control validation and suggestions; the create-time handler-key check; handler errors and pass-through; every call outcome, including a pending call updated in place while earlier reads keep their copies; the buffer bound, `since`, `limit`, `nextSeq`, and `truncated`; function arguments serialized as placeholders; the fake mark visible through the proxy; `tracker.wrap` over the proxy, including over a frozen port and a class instance; wrapper identity stable across reads.
- **CLI unit:** headless `fakeControl` and `fakeCalls` with a small test fake, and `UNKNOWN_FAKE` details. Scenario parsing for every step kind, rejected unknown keys, conditions, durations, and `INVALID_SCENARIO` with line numbers. The runner against a scripted client: target pinning from the `describe` envelope, the support table, optional skips, `UNKNOWN_FAKE` suggestions for a missing fake, the unsettled rule on all three step kinds, `repeat`, every failure shape, cursors restarting after a `reset` step, and best-effort artifacts. The `fake` command's two forms and their usage errors, and `scenario run` with its exit codes, `--json`, and directory expansion.
- **Bridge unit:** the `fakeCalls` result and `UNKNOWN_FAKE` details; `handlers.test.ts` asserts the old details today and changes with them.
- **Serial (gate criteria 1 and 3):** both tests start one daemon in process and call `runScenario` with a daemon client, because invoking the CLI binary per step would take minutes. The race test boots the daemon with `PLANT_RACE=1` and expects the race scenario to fail at its last step with `actual: 0`, then boots it without the flag and expects a pass. The determinism test runs every example scenario 100 times against one daemon, with `reset` before each run, and requires each run's pass or fail result, final state, and recorded event log to equal the first run's. The serial project sets no test timeout, so these tests pass their own. `IRONBIRD_SOAK_RUNS` raises the count for local soaks.
- **Device (gate criterion 2):** `examples/checkout/test/scenarios.device.test.ts` reloads the iOS app through Metro, runs the race scenario on `ios`, resets the headless target and runs it there too, and requires the two final root states to be equal. It reuses the M1 device test's reload helper and clears `PLANT_RACE` from the daemon's environment, which the M1 device test does not. It runs with `pnpm test:device`, not in CI.

## 9. Errors and types

- New: `INVALID_SCENARIO`, details `{ file, issues }`. It joins `ERROR_CODES` in core and the usage set in the CLI's exit codes, so it exits 2.
- `UNKNOWN_FAKE` details become `{ fake, available, suggestions }` on both targets.
- `UNKNOWN_CONTROL` details stay `{ fake, control, suggestions }`, now raised by the fake itself.
- A fake's `INVALID_PAYLOAD` and `DISPATCH_FAILED` name the control as `'<fake>.<control>'`.
- `FakeCall.outcome` gains `threw`, and `FakeCall` gains `error?`.
- `FakeInstance.calls` returns `{ calls, nextSeq, truncated }` (D13).
- `ScenarioResult` gains `file`, `stepsRun`, `repetition?`, `expected?`, and `artifactErrors?`, and `artifacts` becomes nullable.

No other codes change.

## 10. Docs, versioning, and the gate

- `api.md`: `defineFake` rewritten to the final shape in §4, with the reader example returning its handlers.
- `cli.md`: `fake` loses its M2 marker and gains `--calls` as P0; `scenario run` documents paths, directory expansion, output, exit codes, and the artifact layout; the step table gains `settle` on `fake` and `clock`; the example scenario is replaced by the gate scenario from §7, because the current one asserts `order.total`, which does not exist, and pays by card, so its server events arrive while the payment is still collecting and are ignored; the failure example gains `expected`.
- `protocol.md`: `fakeCalls` as P0 with the D13 shape; the `FakeCall`, `ScenarioResult`, and error-table changes; and removal of the `scenarioRun` daemon operation, which D5 replaces with the CLI-side runner.
- New CLI dependency: `yaml`, justified in the pull request as D8.
- Changesets: `@ironbird/core` for `defineFake`, `FakeInstance.calls`, `FakeCall`, `ScenarioResult`, and `INVALID_SCENARIO`; `@ironbird/cli` for the fake operations, `fake`, `scenario run`, and the `yaml` dependency; `@ironbird/react-native` for the `fakeCalls` result and the `UNKNOWN_FAKE` details.
- At the gate: `docs/evals/m2-fakes-and-scenarios.md` records the three criteria with their evidence, including the iOS run with the race planted; the roadmap's M2 criteria and the spec's R6, R11, and R16 are ticked.

## 11. Deferred items folded in

- M0: "`defineFake` must not freeze ports, or `wrap` must copy." Covered by D3, which also survives a port the app froze itself.
- M0: "report `idle: true` with `nextTimerInMs` when only a manual-clock timer is scheduled." Already done in M1; `SettleResult` carries `nextTimerInMs`.
- M0: the tracker's quiescent branch busy-spins under churn, and the losing `sleep` timer is not cancelled. The determinism test drives this path through 500 scenario runs, five scenarios 100 times each, on every CI run. Plan 3 measures it on its first day; if the test is slower than 60 seconds on either Node version or shows timers accumulating, the tracker fix comes before any reduction in run count.
- M1: `fakeControl` was unavailable on remote targets because the example's fakes had no controls. Resolved by wiring the `defineFake` fakes into the device build.
- Found in review: `UNKNOWN_FAKE` details disagree between the bridge and the protocol; the example scenario in cli.md can never pass; protocol.md still lists a daemon-side `scenarioRun`; and the device build cannot plant the race. All four are fixed by this milestone.

## 12. Risks

| Risk | Mitigation |
|---|---|
| One scenario file hides a real difference between targets, because headless settles in quiescent mode and remote settles to idle | The device test compares the whole final state, not only the scenario's own `expect`s; scenarios say in a comment why a step is optional |
| Fakes encode wrong assumptions about the real server (architecture.md §6.3) | The example scenarios cover missing, duplicated, and reordered events; the testing strategy's guidance on keeping fakes honest is unchanged |
| The determinism test is too slow for CI across two Node versions | Estimated at 30 to 45 seconds on CI from the M0 per-operation costs, inside a 60-second budget with little headroom; measured on the first day of plan 3, with the tracker fix in §11 before any reduction in run count |
| `emit`'s defaults depend on hidden state, the most recent submitted payment | Documented on the control; explicit ids override it; `emit` fails loudly, naming the fields to pass, when there is nothing to default from |
| The Metro reload in the cross-target device test is flaky | Reuses the M1 reload helper, including its `simctl` relaunch fallback |
