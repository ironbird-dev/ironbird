# ironbird: CLI Reference (draft)

| | |
|---|---|
| Status | Draft |
| Related | [protocol.md](protocol.md) · [api.md](api.md) |

The `ironbird` binary ships in `@ironbird/cli` and requires Node 22 or newer. The unscoped `ironbird` package exposes the same binary, so `npx ironbird <command>` works without a local install. Every command except `serve`, `doctor`, `verify-bundle`, and `mcp` talks to a running daemon.

## Global options

| Option | Default | Meaning |
|---|---|---|
| `--target <id>` | `defaultTarget` from config | `headless`, or a remote target id such as `ios` or `android-2` |
| `--json` | On when stdout isn't a TTY | Force JSON output |
| `--config <file>` | Nearest `ironbird.config.ts` walking up from the working directory | Config file |
| `--daemon <url>` | `http://127.0.0.1:4567` | Daemon address |
| `--token <token>` | `IRONBIRD_TOKEN` environment variable | Token for a daemon bound beyond localhost |

## Parsing values and durations

Payloads are JSON, and an omitted payload means `{}`. Condition values for `--equals` and `--not-equals` are parsed as JSON when valid and treated as strings otherwise, so `--equals awaitingServerEcho` and `--equals 0` both work; pass `'"0"'` for the string "0". Durations accept `ms`, `s`, and `m` suffixes, and a bare number means milliseconds.

## Exit codes

| Code | Meaning | Typical causes |
|---|---|---|
| 0 | Success, including headless steps that end quiescent | |
| 1 | Operation failed | `INVALID_PAYLOAD`, `UNKNOWN_COMMAND`, `UNKNOWN_FAKE`, `UNKNOWN_CONTROL`, `DISPATCH_FAILED`, `UNSUPPORTED`, `SCREENSHOT_FAILED`, `TARGET_DISCONNECTED`, `CLOCK_RUNAWAY`, `INTERNAL` |
| 2 | Usage or configuration error | Bad arguments, `AMBIGUOUS_TARGET`, `AMBIGUOUS_DEVICE`, `HEADLESS_LOAD_FAILED`, `UNAUTHORIZED`, `PROTOCOL_MISMATCH` |
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

## Commands

### serve

```text
ironbird serve [--port 4567] [--bridge-port 4568] [--host 127.0.0.1] [--no-headless] [--token <token>]
```

Runs the daemon in the foreground. Loads the headless entry unless `--no-headless` is passed, accepts bridge connections, and runs `adb reverse` for connected Android devices when `adb` is available. Binding a non-loopback `--host` requires a token; if none is given, one is generated and printed.

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

Validates and dispatches a command, settles unless `--no-settle` is passed, and prints a step result. On a remote target, `--screenshot` behaves like `step`.

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

Waits until the condition holds (default timeout 5 s). In headless mode `wait` doesn't advance the clock, so advance time first when the condition depends on it. A timeout exits 4 and prints the last value and pending effects.

```sh
ironbird wait payment.status --equals awaitingServerEcho --timeout 2s
```

### settle

```text
ironbird settle [--timeout <duration>]
```

Prints a settle result without dispatching anything.

### events

```text
ironbird events [--since <seq>] [--limit <n>] [--follow]
```

Prints `{ events, nextSeq, truncated }`. With `--follow`, streams events as JSON lines until interrupted.

### fake

```text
ironbird fake <fake> <control> [payload] [--path <path>] [--no-settle]
ironbird fake <fake> --calls [--since <seq>]          (P1)
```

Runs a fake control and prints a step result. With `--calls`, prints recorded port calls.

```sh
ironbird fake api emit '{"event":"payment.succeeded"}'
```

### clock

```text
ironbird clock advance <duration> [--path <path>]
ironbird clock now
```

Headless only; remote targets return `UNSUPPORTED`. `advance` prints a step result with `now` added.

### reset

```text
ironbird reset
```

Headless only. Disposes the headless app, recreates it with a fresh context, and prints `{ target, rev, path, value }`.

### screenshot

```text
ironbird screenshot [--device <udid|serial>] [--out <file>]
```

Captures the iOS Simulator with `xcrun simctl io <device> screenshot` or an Android device with `adb exec-out screencap -p`. The default output is `.ironbird/screenshots/<timestamp>-<target>.png`. Prints `{ path, device, capturedAt }`.

### step

```text
ironbird step <command> [payload] [--device <udid|serial>] [--path <path>] [--settle-timeout <duration>]
```

Remote targets only. Sends, settles, and captures a screenshot, then prints a step result plus `screenshot` and `settledBeforeCapture`. The screenshot is captured even when settling times out, so the agent can see what went wrong, and the CLI still exits 3.

### scenario run

```text
ironbird scenario run <file...> [--bail]
```

Runs scenario files in order and prints one scenario result per file. Exits 4 if any scenario fails.

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

Scans files, including Hermes bytecode, for the bridge marker. Runs without a daemon. Exits 0 when the marker is absent and 1 when it is found, listing the files.

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

### mcp (P1)

```text
ironbird mcp [--daemon <url>]
```

Starts an MCP server over stdio that proxies to the daemon. Tools are listed [below](#mcp-tools-p1).

## Scenario files

Scenarios live in `ironbird/scenarios/*.yaml` by default.

```yaml
name: Confirmation arrives before payment success
description: The server confirms the order before the payment succeeds, then the success event arrives twice.
target: headless            # optional; --target overrides
steps:
  - send: cart.addItem
    payload: { sku: cut-45, qty: 1 }
  - send: payment.start
    payload: { method: card }
  - fake: api
    control: emit
    payload: { event: order.confirmed }
  - fake: api
    control: emit
    payload: { event: payment.succeeded }
    repeat: 2
  - clock: 30s
    optional: true          # skipped on remote targets
  - wait: payment.status
    equals: awaitingServerEcho
    timeout: 2s
  - expect: order.total
    notEquals: 0
  - screenshot: after-duplicate-success
    optional: true          # skipped on headless targets
```

| Step | Fields | Supported on |
|---|---|---|
| `send` | `send` (command), `payload?`, `repeat?`, `settle?` (default `true`) | All targets |
| `fake` | `fake`, `control`, `payload?`, `repeat?` | Targets with that fake wired in |
| `clock` | Duration | Headless |
| `wait` | `wait` (path), one condition, `timeout?` (default 5 s) | All targets |
| `expect` | `expect` (path), one condition | All targets |
| `screenshot` | Name used in the artifact filename | Remote |
| `reset` | `reset: true` | Headless |
| `snapshot` (P1) | `snapshot: { save: <file> }` or `snapshot: { load: <file> }` | Targets that persist or restore |

Conditions are `equals`, `notEquals`, `exists` (`true` or `false`), and `matches` (a regular expression string). Any step can set `optional: true`, which skips it with a notice when the target doesn't support it; unsupported steps without that flag fail with `UNSUPPORTED`.

A failing run against the headless target prints:

```json
{
  "scenario": "Confirmation arrives before payment success",
  "target": "headless",
  "passed": false,
  "durationMs": 41,
  "failedStep": { "index": 6, "step": { "expect": "order.total", "notEquals": 0 }, "actual": 0 },
  "skipped": [7],
  "artifacts": ".ironbird/runs/2026-09-10T18-04-12Z/"
}
```

## MCP tools (P1)

| Tool | Input | Returns |
|---|---|---|
| `ironbird_status` | none | Daemon and target status |
| `ironbird_describe` | `target?` | Commands and fakes with JSON Schemas |
| `ironbird_send` | `command`, `payload?`, `target?`, `path?`, `settle?` | Step result |
| `ironbird_step` | `command`, `payload?`, `target?`, `path?` | Step result, plus the screenshot as image content |
| `ironbird_state` | `path?`, `target?` | Value at the path |
| `ironbird_wait` | `path`, one condition, `timeoutMs?`, `target?` | Value, or a `WAIT_TIMEOUT` error |
| `ironbird_fake` | `fake`, `control`, `payload?`, `target?` | Step result |
| `ironbird_events` | `since?`, `limit?`, `target?` | Events |
| `ironbird_clock_advance` | `duration` | Step result |
| `ironbird_screenshot` | `target?`, `device?` | Image content |
| `ironbird_run_scenario` | `file`, `target?` | Scenario result |
| `ironbird_reset` | none | State |

Operation failures come back as tool results with `isError: true` and the same error JSON the CLI prints.
