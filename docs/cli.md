# ironbird: CLI Reference (draft)

| | |
|---|---|
| Status | Draft |
| Last updated | 2026-09-29 |
| Related | [protocol.md](protocol.md) · [api.md](api.md) |

The `ironbird` binary ships in `@ironbird/cli` and requires Node 22 or newer. The unscoped `ironbird` package exposes the same binary, so `npx ironbird <command>` works without a local install. Every command except `serve`, `doctor`, `verify-bundle`, `mcp`, and `agent setup` talks to a running daemon. `mcp` starts without one and finds it on each tool call.

## Global options

| Option | Default | Meaning |
|---|---|---|
| `--target <id>` | `defaultTarget` from config | `headless`, or a remote target id such as `ios` or `android-2` |
| `--json` | On when stdout isn't a TTY | Force JSON output |
| `--config <file>` | Nearest `ironbird.config.ts` walking up from the working directory | Config file |
| `--daemon <url>` | `.ironbird/daemon.json` written by `serve`, else `http://127.0.0.1:4567` | Daemon address |
| `--token <token>` | `IRONBIRD_TOKEN` environment variable | Token for a daemon bound beyond localhost |

## Parsing values and durations

Payloads are JSON, and an omitted payload means `{}`. Condition values for `--equals` and `--not-equals` are parsed as JSON when valid and treated as strings otherwise, so `--equals awaitingServerEcho` and `--equals 0` both work; pass `'"0"'` for the string "0". Durations accept `ms`, `s`, and `m` suffixes, and a bare number means milliseconds.

## Exit codes

| Code | Meaning | Typical causes |
|---|---|---|
| 0 | Success, including headless steps that end quiescent | |
| 1 | Operation failed | `INVALID_PAYLOAD`, `UNKNOWN_COMMAND`, `UNKNOWN_FAKE`, `UNKNOWN_CONTROL`, `DISPATCH_FAILED`, `UNSUPPORTED`, `SCREENSHOT_FAILED`, `TARGET_DISCONNECTED`, `CLOCK_RUNAWAY`, `INTERNAL` |
| 2 | Usage or configuration error | Bad arguments, `AMBIGUOUS_TARGET`, `AMBIGUOUS_DEVICE`, `HEADLESS_LOAD_FAILED`, `INVALID_CONFIG`, `INVALID_SCENARIO`, `UNAUTHORIZED`, `PROTOCOL_MISMATCH`, `APP_MISMATCH` |
| 3 | Applied, but not settled within the timeout | See `settle` in the result |
| 4 | Condition or assertion not met | `WAIT_TIMEOUT`, a failed scenario step |
| 5 | Nothing to talk to | Daemon unreachable, `NO_TARGET` |

## Output shapes

Commands that change state (`send`, `fake`, `clock advance`, `step`) print a step result. With `--path payment`:

```json
{
  "target": "headless",
  "rev": 7,
  "path": "payment",
  "state": { "status": "collecting", "method": "card" },
  "events": [
    { "seq": 12, "t": 1767225600000, "source": "analytics", "name": "payment_started", "data": { "method": "card" } }
  ],
  "settle": {
    "idle": false,
    "quiescent": true,
    "waitedMs": 3,
    "pending": [{ "kind": "effect", "label": "reader.collectPayment", "ageMs": 3, "fake": true }],
    "nextTimerInMs": 1200
  }
}
```

`step` adds `screenshot` and `settledBeforeCapture` to this shape.

Errors print to stdout as JSON too, so agents parse one stream:

```json
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "message": "Invalid payload for cart.addItem",
    "details": { "name": "cart.addItem", "issues": [{ "path": ["qty"], "message": "Too small: expected number to be >0" }] }
  }
}
```

In a TTY, the same data is printed in a readable form.

The CLI prints the daemon's `result` object, adding `target` to results that don't already carry it, such as `state`, `reset`, and `reload`. Errors are the daemon's `error` object under an `error` key, without the `ok` envelope described in [protocol.md](protocol.md#21-rpc).

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

## Commands

### serve

```text
ironbird serve [--port 4567] [--bridge-port 4568] [--host 127.0.0.1] [--no-headless] [--token <token>]
```

Runs the daemon in the foreground. Loads the headless entry unless `--no-headless` is passed, accepts bridge connections, and runs `adb reverse tcp:<bridgePort> tcp:<bridgePort>` for each connected Android device when `adb` is on the path, logging and continuing when it is not. Binding a non-loopback `--host` requires a token; if none is given, one is generated and printed. On start it prints one line, `{ url, bridgeUrl, targets, defaultTarget, bridgePort }`, and writes `.ironbird/daemon.json` so later invocations find the daemon without loading the config; the file is removed on shutdown (only by the invocation that wrote it, so a `serve` that fails to bind leaves a running daemon's file alone). `daemon.json` records `bridgeUrl` and `artifactsPath`, the daemon's resolved artifacts directory, alongside `url`; client commands that write files, such as `scenario run`, use `artifactsPath`, so a non-default `artifactsDir` in the config works without the client loading it. With `--daemon <url>`, or with no `daemon.json`, they write under `.ironbird` in the working directory. `--port` and `--bridge-port` must differ (a fixed value for both is rejected as `INVALID_CONFIG` before either socket binds); pass `0` for either to let the OS pick, since two zeros never collide. Requests that carry an `Origin` header, or a `Host` that is neither loopback nor the daemon's bind address, are refused with 403, so a page in a local browser can't drive the daemon. `ironbird.config.ts` is read once, at start: restart `serve` after changing it. `reload` loads the headless entry again, never the config.

### status

```text
ironbird status
```

Prints the daemon version, protocol version, uptime, and each target with its platform, app id, connection time, and revision.

### commands

```text
ironbird commands [--name <command>]
```

Lists the target's commands with descriptions and payload JSON Schemas.

### fakes

```text
ironbird fakes
```

Lists fakes wired into the target, with descriptions and control schemas.

### send

```text
ironbird send <command> [payload] [--path <path>] [--no-settle] [--settle-timeout <duration>] [--screenshot]
```

Validates and dispatches a command, settles unless `--no-settle` is passed, and prints a step result. On a remote target, `--screenshot` (M1) behaves like `step`.

```sh
ironbird send cart.addItem '{"sku":"cut-45","qty":1}' --path cart
```

### state

```text
ironbird state [path]
```

Prints `{ target, rev, path, value }`.

### wait

```text
ironbird wait <path> (--equals <value> | --not-equals <value> | --exists | --matches <regex>) [--timeout <duration>]
```

Waits until the condition holds (default timeout 5 s). In headless mode `wait` doesn't advance the clock, so advance time first when the condition depends on it. A pending `wait` doesn't block other clients, so a `clock advance` or `send` from another shell can satisfy it. A timeout exits 4 and prints the last value and pending effects.

```sh
ironbird wait payment.status --equals awaitingServerEcho --timeout 2s
```

### settle

```text
ironbird settle [--timeout <duration>]
```

Prints a settle result without dispatching anything. Exits 3 when the target is neither idle nor quiescent, like a step.

### events

```text
ironbird events [--since <seq>] [--limit <n>] [--follow]
```

Prints `{ events, nextSeq, truncated }`. With `--follow`, the backlog and every later event print as JSON lines regardless of TTY, until interrupted.

### fake

```text
ironbird fake <fake> <control> [payload] [--path <path>] [--no-settle] [--settle-timeout <duration>]
ironbird fake <fake> --calls [--since <seq>]
```

One command with two forms. With a control, it runs that control on the named fake, settles unless `--no-settle` is passed, and prints a step result with the same exit codes as `send`: 0, or 3 when the control was applied but the target didn't settle in time. Payloads parse like `send`'s. With `--calls`, it prints the calls the app has made on the fake's port as `{ target, fake, calls, nextSeq, truncated }`, paging like `events`: `--since` returns only calls newer than that sequence number, `nextSeq` is the cursor for the next call, and `truncated` means `--since` points into calls the fake has already dropped, since each fake keeps 10,000. A call that returned a promise shows `pending` until it settles; run the command again for its final outcome. The command needs a control or `--calls` and rejects both together, and `--since` applies only with `--calls`; each is a usage error, exit 2. An unknown fake fails with `UNKNOWN_FAKE` listing the wired fakes and near misses, an unknown control with `UNKNOWN_CONTROL`, and a target without fakes with `UNSUPPORTED`, all exit 1.

```sh
ironbird fake api setEcho '{"mode":"manual"}'
ironbird fake api emit '{"event":"payment.succeeded"}' --path order
ironbird fake api --calls --since 12
```

```json
{
  "target": "headless",
  "fake": "api",
  "calls": [
    { "seq": 13, "t": 1767225600300, "fake": "api", "method": "submitPayment", "args": [{ "amountCents": 4500, "token": "fake_4500" }], "outcome": "resolved" }
  ],
  "nextSeq": 13,
  "truncated": false
}
```

### clock

```text
ironbird clock advance <duration> [--path <path>]
ironbird clock now
```

Headless only; remote targets return `UNSUPPORTED`. `advance` prints a step result with `now` added. `now` prints `{ target, now }`.

### reset

```text
ironbird reset
```

Headless only. Disposes the headless app, recreates it with a fresh context, and prints `{ target, rev, path, value }`. Event sequence numbers restart at 1 after a reset, so call `events` without `--since` once before paging again. A reset re-runs the code the daemon already loaded; after editing app code, use `reload`. After a failed `reload`, `reset` fails with the same `HEADLESS_LOAD_FAILED` until a `reload` succeeds.

### reload

```text
ironbird reload [--timeout <duration>]
```

Loads the app's current code from a fresh start and prints `{ target, rev }`. Commands in flight on the target fail with `TARGET_DISCONNECTED`, and event sequence numbers restart, as after `reset`.

On the headless target, it re-bundles the headless entry and boots it with a fresh clock, event log, and fakes; `ironbird.config.ts` is not read again. A bundling, import, or boot error fails with `HEADLESS_LOAD_FAILED`, exit 2, and the old code does not come back: every later command on the headless target, `reset` included, fails with that error until a `reload` succeeds. Node keeps every module it evaluates for the daemon's life, so a daemon reloaded hundreds of times grows accordingly; restarting `serve` clears it.

On a connected app, it asks the bridge to reload, which calls the app's `reload` option or else `DevSettings.reload()`, waits for the app to reconnect, and prints the reconnected target, which keeps the same id. `--timeout` bounds that wait (default `60s`); when it runs out, the command fails with `TARGET_DISCONNECTED`, exit 1. With another build of the same app connected on the same platform, the daemon can't tell which reconnection is the reloaded one, so it fails with `AMBIGUOUS_TARGET`, exit 2, before reloading anything. A target that doesn't declare the `reload` capability fails with `UNSUPPORTED`, exit 1, and no daemon or no such target exits 5.

```sh
ironbird reload
ironbird reload --target ios --timeout 90s
```

```json
{ "target": "ios", "rev": 3 }
```

### screenshot

```text
ironbird screenshot [--device <udid|serial>] [--out <file>]
```

Captures the connected app: `xcrun simctl io <device> screenshot` for a simulator, `adb -s <device> exec-out screencap -p` for Android. With no `--target` it picks the only connected app; with several it fails with `AMBIGUOUS_TARGET`, and it refuses the headless target with `UNSUPPORTED`. The device is `--device`, else `devices.<platform>` from config, else the single booted simulator or connected device, else `AMBIGUOUS_DEVICE` listing the candidates. The default output is `.ironbird/screenshots/<yyyymmdd>-<hhmmss>-<ms>-<target>.png`; `--out` is resolved against the working directory. Prints `{ target, path, device, capturedAt }`.

### step

```text
ironbird step <command> [payload] [--device <udid|serial>] [--path <path>] [--no-settle] [--settle-timeout <duration>]
```

Remote targets only. Sends, settles, and captures a screenshot, then prints a step result plus `screenshot` and `settledBeforeCapture`. The screenshot is captured even when settling times out, so the agent can see what went wrong, and the CLI still exits 3. With `--no-settle` the capture happens right after the dispatch. The printed result is the step result with two extra fields: `screenshot: { path, device, capturedAt }` and `settledBeforeCapture`, true only when settling reached idle before the capture.

### scenario run

```text
ironbird scenario run <path...> [--bail] [--target <id>]
```

Runs scenario files against one target and prints one scenario result per file. Each `path` is a file or a directory; a directory expands to its `*.yaml` and `*.yml` files in name order, without recursing. Every file is parsed before any scenario runs, so an authoring error costs nothing: an invalid file, or a path that does not exist, fails with `INVALID_SCENARIO` and exit code 2 before the daemon is contacted. `--target` is the global option; it overrides the scenario's own `target`, and with neither the daemon picks its default.

The first operation of every run is `describe`, and the target id in its reply pins the target for every later operation, including `screenshot`, whose default target selection differs from everything else's. A `describe` that fails ends the command with that error and its own exit code: 5 when the daemon is unreachable or has no such target, 2 for `UNAUTHORIZED`, 1 for `TARGET_DISCONNECTED`. The same errors from a later step fail that step like any other.

Output is one `ScenarioResult` per file (see [Output shapes](#output-shapes)), as JSON lines when stdout is not a TTY or `--json` is passed, and otherwise as a `PASS` or `FAIL` line per scenario followed by the failed step with its `expected` and `actual` values or its error, and any artifacts that could not be written. The exit code is 2 if any file is invalid, the `describe` error's own code as above, 4 if any scenario failed, and 0 otherwise. `--bail` stops after the first failed scenario.

Each file starts from a fresh app: right after `describe`, on a target that declares the `reset` capability (headless), the runner resets it before the first step, so files don't share state and a directory run does not depend on file order. On a remote app, which has no `reset`, the scenario runs against the app's current state; run `ironbird reload --target <id>` first for a fresh start.

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
| `<index>-<name>.png` | One per `screenshot` step, named by the step's index and its value made filesystem-safe |

"During the run" means after the run's first `describe`, or after the last `reset` step, which restarts the event and call logs. Collection is best effort: a file that cannot be gathered, such as the state after a `TARGET_DISCONNECTED`, is left out and named in `artifactErrors`.

### snapshot (P1)

```text
ironbird snapshot save <file>
ironbird snapshot load <file>
```

### watch (P1)

```text
ironbird watch [--path <path>]
```

Streams `{ rev, patch }` JSON lines, where `patch` is a JSON Patch (RFC 6902) against the previous state, until interrupted.

### doctor (P1)

```text
ironbird doctor
```

Checks the Node version, config validity, headless entry load (printing the import chain on failure), daemon port availability, `xcrun simctl` and `adb` availability, booted devices, and whether `.ironbird/` is gitignored.

### verify-bundle

```text
ironbird verify-bundle <path...>
```

Scans files, including Hermes bytecode, for the bridge marker. Runs without a daemon. Prints `{ scanned, found: [{ file, offset }] }` with paths relative to the working directory, and exits 0 when the marker is absent, 1 when it is found, and 2 when a path does not exist. The marker is assembled at runtime inside the CLI so the literal exists only in `@ironbird/react-native`.

```sh
# Expo: production export, the same kind of output OTA updates ship
npx expo export --platform all --output-dir dist
npx ironbird verify-bundle dist
```

```sh
# Bare React Native: release bundle
npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output build/main.jsbundle
npx ironbird verify-bundle build/main.jsbundle
```

### mcp

```text
ironbird mcp [--daemon <url>] [--token <token>]
```

Runs an MCP server for coding agents over stdio until stdin closes. `ironbird agent setup` registers it in `.mcp.json` as `{ "command": "npx", "args": ["ironbird", "mcp"] }`, so it runs in the project root. The server is named `ironbird` and reports the package version. Its tools are listed [below](#mcp-tools); [agents.md](agents.md) covers setup.

The server needs no daemon to start. Each tool call finds the daemon the way other commands do: `--daemon`, then the nearest `.ironbird/daemon.json` walking up from the working directory, then `http://127.0.0.1:4567`, with `--token` or `IRONBIRD_TOKEN` for the token. So the server can start before `ironbird serve`, and a daemon restart needs no MCP restart. While no daemon answers, every tool fails with `NO_TARGET`, whose message says to run `ironbird serve`. Nothing but MCP messages is written to stdout; diagnostics go to stderr.

## Scenario files

`ironbird/scenarios/` is the conventional location for scenario files, the config's `scenarios` key; `scenario run` does not read it implicitly, so you pass it (or an individual file) as the command's path argument. The example app's gate scenario, which reproduces the planted race:

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

## MCP tools

Each tool is one daemon operation, except `ironbird_run_scenario`, which runs the scenario runner inside the MCP server, as `scenario run` does in the CLI. App command schemas reach the agent as JSON Schemas in `ironbird_describe` results, never as tool input schemas, so the tool list is the same for every app.

| Tool | Input | Returns | Daemon operation |
|---|---|---|---|
| `ironbird_status` | none | `{ version, protocol, uptimeMs, targets }` | `status` |
| `ironbird_describe` | `target?` | The `Description` plus `target`: app, commands and fakes with JSON Schemas, capabilities | `describe` |
| `ironbird_send` | `command`, `payload?`, `target?`, `path?`, `settle?` | Step result | `dispatch` |
| `ironbird_step` | `command`, `payload?`, `target?`, `path?`, `settle?`, `device?` | Step result plus `screenshot` and `settledBeforeCapture`, and the screenshot as image content | `step` |
| `ironbird_state` | `path?`, `target?` | `{ target, rev, path, value }` | `getState` |
| `ironbird_wait` | `path`, exactly one of `equals`, `notEquals`, `exists`, `matches`, `timeoutMs?` (default 5000), `target?` | `{ target, rev, path, value, waitedMs }`, or a `WAIT_TIMEOUT` error | `waitFor` |
| `ironbird_settle` | `timeoutMs?`, `target?` | Settle result plus `target` | `settle` |
| `ironbird_fake` | `fake`, `control`, `payload?`, `target?`, `path?`, `settle?` | Step result | `fakeControl` |
| `ironbird_fake_calls` | `fake`, `since?`, `limit?`, `target?` | `{ target, fake, calls, nextSeq, truncated }` | `fakeCalls` |
| `ironbird_events` | `since?`, `limit?`, `target?` | `{ target, events, nextSeq, truncated }` | `events` |
| `ironbird_clock_advance` | `ms`, `path?`, `settle?`, `target?` | Step result plus `now` | `clockAdvance` |
| `ironbird_clock_now` | `target?` | `{ target, now }` | `clockNow` |
| `ironbird_screenshot` | `target?`, `device?` | `{ target, path, device, capturedAt }`, and the image as image content | `screenshot` |
| `ironbird_run_scenario` | `path` (a file or a folder), `target?`, `bail?` | `{ results: ScenarioResult[] }`, one per file | the scenario runner, in process |
| `ironbird_reset` | `target?` | `{ target, rev, path, value }` | `reset` |
| `ironbird_reload` | `target?`, `timeoutMs?` | `{ target, rev }` | `reload` |

- Inputs are Zod 4 objects, published to the agent as JSON Schemas. `settle` is `true` (the default), `false`, or `{ timeoutMs }`, as in the protocol. Durations are milliseconds. Defaults match the CLI: `payload` is `{}`, `path` is the whole state, and `ironbird_wait` gives up after 5000 ms. `ironbird_reload`'s `timeoutMs` is a positive integer of at most 2147483647 and applies to connected apps only. `ironbird_clock_advance` and `ironbird_clock_now` work only on a target that declares `clock` (headless); pass `target: 'headless'` when the daemon's default target is a device.
- A successful result is one text block holding the JSON the CLI prints for the same operation: the daemon's result with `target` added when it lacks one, and `fake` added for `ironbird_fake_calls`. A step that did not settle is still a success; its `settle` says so, where the CLI would exit 3. `ironbird_step` and `ironbird_screenshot` add one image block, the PNG at the returned path, base64-encoded as `image/png`; the MCP server reads it from disk, so it must run on the daemon's machine. If `ironbird_step` can't read the file, a second text block says why instead, and the result stays a success because the step was already applied. If `ironbird_screenshot` can't read it, the call fails with `SCREENSHOT_FAILED` and `details: { tool: 'readImage', stderr }`, since the image was all it had to offer.
- A failure is a result with `isError: true` and one text block holding the same `{ "error": { "code", "message", "details" } }` JSON the CLI prints. When the daemon fails `ironbird_step` with `SCREENSHOT_FAILED` and `details.applied: true`, the command was already applied and only the capture failed; a second text block says not to retry the step and to read the result with `ironbird_state`. Without `applied`, nothing was applied.
- Input that fails a tool's schema, such as `ironbird_wait` with no condition or two, is rejected by the MCP SDK itself, before the daemon is contacted, as an `isError` result whose text begins `Input validation error`. It is the SDK's message, not the `{ "error": ... }` JSON, and carries no ironbird error code.
- `ironbird_run_scenario` resolves `path` against the MCP server's working directory, the project root when started from `.mcp.json`, and behaves as `scenario run`: every file is validated before any runs, a headless target is reset before each file, `bail` stops after the first failed scenario, and each result names its artifacts folder. An invalid file, a missing path, or a folder with no scenario files is an `isError` result with `INVALID_SCENARIO`, returned before the daemon is contacted. A scenario that runs and fails is a normal result with `passed: false`. A connected app runs against its current state, so reload it first. When the first `describe` of a file fails, the call returns that error, and the runs before it are only on disk.
- Tool descriptions are written for agents and name the next useful call.

