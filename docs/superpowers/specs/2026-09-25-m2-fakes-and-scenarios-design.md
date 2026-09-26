# M2: Fakes and scenarios, design

| | |
|---|---|
| Status | Draft, in review (2026-09-25) |
| Milestone | M2 in [roadmap.md](../../roadmap.md) |
| Builds on | [architecture.md](../../architecture.md) §6.3, §6.5 · [protocol.md](../../protocol.md) operation table, `Description`, error table · [api.md](../../api.md) `defineFake` · [cli.md](../../cli.md) `fakes`, `fake`, `scenario run`, "Scenario files" · [testing-strategy.md](../../testing-strategy.md) headless determinism |

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
| A scenario reproduces the planted race: it fails with `PLANT_RACE=1` and passes without it | A serial-project test that boots the daemon twice, once per setting, and runs the race scenario (§8) |
| The same scenario, with clock steps marked optional, reaches the same final state on the headless and iOS targets | A device test that runs the race scenario on a freshly reloaded iOS app and on a freshly reset headless target, then compares the whole final state (§8) |
| 100 consecutive headless runs of every example scenario show 0 divergences | A serial-project test in CI, 100 runs per scenario with `reset` between runs (§8) |

Out of scope: `snapshot` steps (P1), the MCP server (M3), a daemon-side scenario operation, a per-step policy for unsettled steps, fake controls on Android beyond what the shared device build gives for free (not measured in M2), and property-based generation (M4).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `defineFake` lives in `@ironbird/core` and validates controls with `defineCommands` | One validation path: `UNKNOWN_CONTROL` with suggestions, `INVALID_PAYLOAD` with issues, and JSON Schema for `describe` come for free |
| D2 | A fake's control handlers are returned from `create` next to the port, typed as a complete map over the declared controls, instead of registered with `on()` as the api.md sketch has it | TypeScript rejects a missing or misspelled handler at compile time, and there is no runtime registration state to get wrong |
| D3 | Every fake port is served through a call-recording proxy that is never frozen and reports the fake mark | R16 needs the calls; `tracker.wrap` proxies the port again and throws on a frozen one (M0 note); quiescence needs the mark |
| D4 | R16 ships in M2: the `fakeCalls` operation and `ironbird fake <fake> --calls` | Maintainer decision; small on top of D3, and agents can confirm what the app asked the outside world for |
| D5 | The scenario runner is a CLI-side module that runs each step as one existing operation through the daemon client | Maintainer decision; no protocol change, works against any target the daemon hosts, and M3's MCP server can call the same exported function in process |
| D6 | A `send` or `fake` step that ends unsettled fails the scenario. A headless step that ends quiescent counts as settled. `settle: false` on the step opts out | Maintainer decision; later `expect`s on an unsettled app are unreliable, and the rule matches the CLI, where a quiescent step exits 0 |
| D7 | Whether an `optional: true` step is skipped is decided from the target's `describe` before the step runs, never by catching `UNSUPPORTED` | A skipped step must not half-run, and a real `UNSUPPORTED` from inside a supported step must still fail the scenario |
| D8 | Scenario files are parsed with the `yaml` package | YAML 1.2 by default, so `on` and `yes` stay strings; no dependencies of its own; reports line numbers for errors; already in the lockfile transitively at 2.9.0 |
| D9 | The race scenario controls the order of server events through an api fake control that turns off the automatic echo | The current fake always sends `order.confirmed` before `payment.succeeded`, so the planted race can never fire without control over ordering |
| D10 | Cross-target equality is a whole-state comparison after a fresh start on each target: `reset` on headless, a Metro reload on iOS | Remote targets have no `reset`. A reload recreates the JS runtime, the fakes, and their id counters, so even `pay_1` and `ord_1` match |
| D11 | The 100-run determinism check is a serial-project test that runs in CI, with an environment variable for longer local soaks | Maintainer decision; determinism stays proven on every commit |

## 3. Work breakdown

Three implementation plans, in dependency order. Plan 2 needs plan 1 only for `fake` steps and can start against the M0 operations.

1. **Fakes:** `defineFake` and the call log in core; `fakeControl` and `fakeCalls` on the headless target; the `fake` command; the protocol and API docs.
2. **Scenarios:** parsing and validation, the runner, artifacts, and `scenario run`.
3. **Example and gate:** the rewritten fakes, headless and device wiring, the example scenarios, the race and determinism tests, the cross-target device test, and the M2 exit-criteria record.

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

`FakeInstance` keeps the shape core already exports: `name`, `description`, `port`, `controls` (the registry), `control(name, payload)`, and `calls(since)`.

**Running a control.** `control(name, payload)` parses with the registry, which fails with `UNKNOWN_CONTROL` (with suggestions) or `INVALID_PAYLOAD` (with issues), then awaits the handler. A handler that throws or rejects fails with `DISPATCH_FAILED`, details `{ name: '<fake>.<control>', message }`, the same code a throwing command uses. An `IronbirdError` from a handler passes through unchanged.

**Call log (R16).** The instance's `port` is a proxy over the object `create` returned. Reading a function-valued property returns a wrapper that records a `FakeCall`; other properties pass through untouched. Each call gets a sequence number per fake starting at 1, the clock time, the method name, and the arguments serialized with core's `serializeState`, so a listener argument becomes a placeholder rather than failing. The outcome is `returned` or `threw` for a synchronous call. A call that returns a promise is recorded as `pending` and updated in place to `resolved` or `rejected` when it settles. `threw` and `rejected` also carry the error's message. Calls are kept in a buffer of 10,000 per fake that drops the oldest, and `calls(since = 0)` returns those with a sequence number above `since`. Recording is always on: fakes exist only in headless and development builds.

**Fake mark and freezing.** The proxy answers the `FAKE_PORT_MARK` lookup with `true`, so `tracker.wrap(fake.port, …)` treats the port as fake-backed for quiescence exactly as `markFakePort` does today. Nothing in `defineFake` freezes the port or the proxy.

**Fresh state per boot.** A fake's state lives in the `create` closure. The headless target's `reset` runs the headless definition again, which creates new fakes, so counters, pending timers, and call logs all start over. This is what makes 100 headless runs identical.

## 5. Fake operations and the `fake` command

**Headless target.** Gains `fakeControl` and `fakeCalls`. `fakeControl` is a queued mutating operation, as `MUTATING_OPS` already lists it, and returns a `StepResult` settled in quiescent mode, exactly like `dispatch`. `fakeCalls` is read-only and returns `{ calls }`. An unknown fake fails with `UNKNOWN_FAKE`. The `fakes` capability is declared when the app wires at least one fake, as `describe` already does.

**Remote target.** The bridge implemented both operations in M1 and the remote target routes them under the `fakes` capability. The only change is to align `UNKNOWN_FAKE`'s details on both targets as `{ fake, available, suggestions }`; the bridge sends `{ name, suggestions }` today, which disagrees with the protocol's error table.

**Protocol.** `fakeCalls` drops its P1 marker. `FakeCall.outcome` gains `threw`, and `FakeCall` gains an optional `error` message. Both are additive, so `PROTOCOL_VERSION` does not change.

**CLI.**

```text
ironbird fake <fake> <control> [payload] [--path <path>] [--no-settle] [--settle-timeout <duration>]
ironbird fake <fake> --calls [--since <seq>]
```

The first form sends `fakeControl` and prints the `StepResult` with the same exit codes as `send`: 0, or 3 when applied but not settled. The second sends `fakeCalls` and prints `{ target, fake, calls }`. Payloads parse the same way as `send`'s.

## 6. Scenario runner

A module in `packages/cli/src/scenario/` with three files: `parse.ts` turns a file into a validated `Scenario`, `run.ts` exports `runScenario(client, scenario, options): Promise<ScenarioResult>`, and `artifacts.ts` writes the run directory.

**Parsing.** YAML is parsed with line information, then validated with Zod. The top level has `name` (required), `description`, `target`, and a non-empty `steps` list. Each step is exactly one kind, identified by its discriminating key (`send`, `fake`, `clock`, `wait`, `expect`, `screenshot`, `reset`), plus the shared `optional` flag. Unknown keys are rejected, so a typo such as `payloads` fails before anything runs. Durations are a number of milliseconds or a string with an `ms`, `s`, or `m` suffix, parsed by the CLI's existing duration parser. Conditions are exactly one of `equals`, `notEquals`, `exists`, and `matches`, parsed by core's `parseCondition`. An invalid file fails with a new error code, `INVALID_SCENARIO`, details `{ file, issues: [{ path, message, line? }] }`, exit code 2. Payloads are not checked at parse time, because their schemas live in the app; an invalid payload fails its step at run time with `INVALID_PAYLOAD`.

cli.md's step table gains one field: `fake` steps accept `settle`, like `send` steps, so D6's opt-out works for both.

**Running.** The target is the scenario's `target`, overridden by `--target`, and otherwise the daemon's default. The runner calls `describe` once at the start and reads the platform, the capabilities, and the wired fakes from it. Each step maps to one operation:

| Step | Operation | Supported when |
|---|---|---|
| `send` | `dispatch` with `name`, `payload`, and `settle` | Always |
| `fake` | `fakeControl` with `fake`, `control`, `payload`, and `settle` | The named fake appears in `describe` |
| `clock` | `clockAdvance` with `ms` | The target declares `clock` |
| `wait` | `waitFor` with `path`, the condition, and `timeoutMs` (default 5 s) | Always |
| `expect` | `getState` at `path`, then the condition checked locally with core's `conditionHolds` | Always |
| `screenshot` | `screenshot` with `out` set to a file in the run directory | The platform is not `headless` |
| `reset` | `reset` | The target declares `reset` |

A step whose condition is not met is skipped when it is `optional`, and its index is added to `skipped`. Otherwise it fails with `UNSUPPORTED` before any operation is sent. `repeat` on `send` and `fake` steps runs the operation that many times; a failure reports which repetition failed.

**Failing a step.** The runner stops at the first failing step and reports it.

| Cause | `failedStep` carries |
|---|---|
| `send` or `fake` ends with `settle` neither idle nor quiescent (D6) | `actual: { settle }` |
| `wait` times out | `expected`: the condition; `actual`: the value from `WAIT_TIMEOUT`'s details |
| `expect` condition not met | `expected`: the condition; `actual`: the value read |
| Any other `IronbirdError` from the step's operation | `error`: the error shape |

A daemon that cannot be reached, or `NO_TARGET`, ends the whole command with its own error and exit code 5 rather than producing a scenario result.

**Result.** The shape in cli.md, extended by what R11 asks for:

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
  artifacts: string | null;
}
```

**Artifacts.** Every run, passed or failed, writes `<artifactsPath>/runs/<UTC stamp>-<scenario slug>/`: `result.json`, a copy of the scenario file, `events.jsonl` with the events recorded during the run, `state.json` with the final state at the root path, `calls/<fake>.json` with each fake's calls during the run, and the screenshots from `screenshot` steps. "During the run" means since the sequence numbers captured at its start, or since the last `reset` step, which restarts them. `runScenario` accepts `artifactsDir: false` so the determinism test can skip writing.

**Command.**

```text
ironbird scenario run <path...> [--bail] [--target <id>]
```

A directory expands to its `*.yaml` and `*.yml` files in name order. Every file is parsed before any runs, so an authoring error costs nothing. Output is one `ScenarioResult` per file: JSON lines when stdout is not a TTY, and a one-line summary per scenario, plus the failed step, when it is. The exit code is 2 if any file is invalid, 5 if the daemon cannot be reached, 4 if any scenario failed, and 0 otherwise. `--bail` stops after the first failed scenario.

## 7. Example app

**Fakes.** Both fakes in `src/ironbird/fakes/` are rewritten with `defineFake`. Defaults stay as today, and each records the same events it records today, so existing tests and the M1 harness numbers are unaffected.

| Fake | Controls |
|---|---|
| `reader` | `emit { event: connected \| disconnected \| cardPresented \| declined }`; `failNextPayment { reason }`; `setLatency { ms }` (default 1200) |
| `api` | `emit { event: order.confirmed \| payment.succeeded \| payment.failed, paymentId?, orderId?, totalCents?, reason? }`; `setEcho { mode: auto \| manual }` (default `auto`); `failNextPayment { reason }`; `setLatency { submitMs?, echoMs? }` (defaults 300 and 500) |

In `auto` mode the api fake behaves as it does today: `echoMs` after a submission resolves, it emits `order.confirmed` and then `payment.succeeded`. In `manual` mode it emits nothing on its own. `emit` fills omitted ids and the total from the most recent submitted payment, and fails with `DISPATCH_FAILED` when there is none and they are omitted.

**Wiring.** `headless.ts` returns `fakes: [reader, api]`. `instance.ts` creates the same two fakes on the real clock and exports them, and `device.ts` passes them to `startBridge` as `fakes`. Each port still goes through `tracker.wrap` as today.

**Scenarios** in `examples/checkout/ironbird/scenarios/`, the config's default directory:

| File | What it checks | Targets |
|---|---|---|
| `checkout-saved-card.yaml` | The happy path with the saved card | Both |
| `race-success-before-confirmation.yaml` | The planted race; the gate scenario | Both |
| `duplicate-success.yaml` | A second `payment.succeeded` after completion changes nothing | Both |
| `missing-echo-times-out.yaml` | With the echo held, 30 s of clock fails the payment with a timeout | `target: headless` |
| `reader-disconnect.yaml` | A reader disconnect while collecting fails the payment | `target: headless` |

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

Without the planted bug, `payment.succeeded` only marks the payment succeeded, and `order.confirmed` then completes the order with its total of 4500. With `PLANT_RACE=1`, `payment.succeeded` completes the order at once with a total of 0, the later `order.confirmed` is ignored, and the last `expect` fails with `actual: 0`. Every step settles on both targets: manual-clock timers never count as pending work on headless, and on iOS the 30 s server timeout is beyond the tracker's one-second threshold for real-clock timers.

## 8. Testing

Per [testing-strategy.md](../../testing-strategy.md):

- **Core unit:** control validation and suggestions; handler errors and pass-through; every call outcome, including a pending call updated in place; the buffer bound; `since`; function arguments serialized as placeholders; the fake mark visible through the proxy; `tracker.wrap` over the proxy.
- **CLI unit:** headless `fakeControl` and `fakeCalls` with a small test fake, and `UNKNOWN_FAKE` details. Scenario parsing for every step kind, rejected unknown keys, conditions, durations, and `INVALID_SCENARIO` with line numbers. The runner against a scripted client: the support table, optional skips, the unsettled rule, `repeat`, every failure shape, and capture restarting after a `reset` step. The `fake` and `scenario run` commands, including exit codes and directory expansion.
- **Serial (gate criteria 1 and 3):** the race test boots the daemon against the example with `PLANT_RACE=1` and expects the race scenario to fail at its last step with `actual: 0`, then boots it without the flag and expects a pass. The determinism test runs every example scenario 100 times against one daemon, with `reset` before each run, and requires each run's pass or fail result, final state, and recorded event log to equal the first run's. `IRONBIRD_SOAK_RUNS` raises the count for local soaks.
- **Device (gate criterion 2):** `examples/checkout/test/scenarios.device.test.ts` reloads the iOS app through Metro, runs the race scenario on `ios`, resets the headless target and runs it there too, and requires the two final root states to be equal. It reuses the M1 device test's reload helper. It runs with `pnpm test:device`, not in CI.

## 9. Errors

- New: `INVALID_SCENARIO`, exit code 2, details `{ file, issues }`.
- `FakeCall.outcome` gains `threw`, and `FakeCall` gains `error?`.
- `UNKNOWN_FAKE` details become `{ fake, available, suggestions }` on both targets.
- A throwing control handler fails with `DISPATCH_FAILED`, details `{ name: '<fake>.<control>', message }`.

No other codes change.

## 10. Docs, versioning, and the gate

- `api.md`: `defineFake` rewritten to the final shape in §4, with the reader example updated to return its handlers.
- `cli.md`: `fake` loses its M2 marker and gains `--calls` as P0; `scenario run` documents paths, directory expansion, output, exit codes, and the artifact layout; the step table gains `settle` on `fake`; the failure example gains `expected`.
- `protocol.md`: `fakeCalls` as P0, the `FakeCall` changes, `INVALID_SCENARIO`, and `UNKNOWN_FAKE`'s details.
- New CLI dependency: `yaml`, justified in the pull request as D8.
- Changesets: `@ironbird/core` for `defineFake`; `@ironbird/cli` for the fake operations, `fake`, and `scenario run`; `@ironbird/react-native` for the `UNKNOWN_FAKE` details.
- At the gate: `docs/evals/m2-fakes-and-scenarios.md` records the three criteria with their evidence; the roadmap's M2 criteria and the spec's R6, R11, and R16 are ticked.

## 11. Deferred items folded in

- M0: "`defineFake` must not freeze ports, or `wrap` must copy." Covered by D3.
- M0: "report `idle: true` with `nextTimerInMs` when only a manual-clock timer is scheduled." Already done in M1; `SettleResult` carries `nextTimerInMs`.
- M0: the tracker's quiescent branch busy-spins under churn, and the losing `sleep` timer is not cancelled. The determinism test drives it through 500 scenario runs, five scenarios 100 times each, on every CI run. Plan 1 fixes it only if that test is slower than 60 seconds on either Node version or shows timers accumulating; otherwise it stays on the follow-up list.
- M1: `fakeControl` was unavailable on remote targets because the example's fakes had no controls. Resolved by wiring the `defineFake` fakes into the device build.
- Found while writing this spec: `UNKNOWN_FAKE` details disagree between the bridge and the protocol. Aligned in §5.

## 12. Risks

| Risk | Mitigation |
|---|---|
| One scenario file hides a real difference between targets, because headless settles in quiescent mode and remote settles to idle | The device test compares the whole final state, not only the scenario's own `expect`s; scenarios say in a comment why a step is optional |
| Fakes encode wrong assumptions about the real server (architecture.md §6.3) | The example scenarios follow the testing strategy's standard set of misbehaving-server cases; the guidance there is unchanged |
| The determinism test is too slow for CI across two Node versions | Budget of 60 seconds per Node version, measured in plan 3; over budget triggers the tracker fix in §11 before any reduction in run count |
| `emit`'s defaults depend on hidden state, the most recent submitted payment | Documented on the control; explicit ids override it; `emit` fails loudly when there is nothing to default from |
| The Metro reload in the cross-target device test is flaky | Reuses the M1 reload helper, including its `simctl` relaunch fallback |
