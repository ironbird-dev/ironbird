# Scenario files

A scenario is a YAML file that replays a sequence of steps against one target and checks the result. Keep them under `ironbird/scenarios/`. Run one file or a folder with `ironbird_run_scenario` (`path`, `target?`, `bail?`) or `npx ironbird scenario run <path...> [--target <id>] [--bail]`.

```yaml
name: Refresh shows mail that arrives while offline
description: Optional; say what the scenario proves.
steps:
  - fake: mail
    control: goOffline
  - send: inbox.refresh
  - clock: 2s
    optional: true      # headless only; a device skips it
  - fake: mail
    control: deliver
    payload: { count: 2 }
  - wait: inbox.status
    equals: loaded
  - expect: inbox.unread
    equals: 2
  - screenshot: inbox
    optional: true      # devices only; headless skips it
```

The names above are made up. Take real command, fake, and control names and payload shapes from `ironbird_describe`.

## Top level

`name` (required), `description`, `target` (the tool's `target` or `--target` overrides it), and a non-empty `steps` list. Unknown keys are errors, so a typo fails before anything runs.

## Steps

Each step is exactly one kind, named by its key, plus an optional `optional: true`.

| Step | Fields | Does | Runs on |
|---|---|---|---|
| `send` | command name, `payload?` (default `{}`), `repeat?`, `settle?` (default `true`) | Dispatches the command and settles | Every target |
| `fake` | `fake`, `control`, `payload?`, `repeat?`, `settle?` | Runs a fake control and settles | Targets with `fakes` that wire that fake |
| `clock` | duration, `settle?` | Advances the manual clock | Targets with `clock` (headless) |
| `wait` | state path, one condition, `timeout?` (default 5 s) | Waits for the condition | Every target |
| `expect` | state path, one condition | Reads state once and checks it | Every target |
| `screenshot` | a name for the file | Captures the screen into the run folder | Devices |
| `reset` | `reset: true` | Restarts the app fresh | Targets with `reset` (headless) |

- **Durations:** a number of milliseconds, or a string with `ms`, `s`, or `m`, such as `300ms` or `2s`.
- **Conditions:** exactly one of `equals: <value>`, `notEquals: <value>`, `exists: true|false`, or `matches: <regular expression>`. Values compare as JSON, deeply.
- **`optional: true`:** skip the step, instead of failing, when the target can't run it. Its index goes in `skipped`. Use it on `clock` and `screenshot` steps so one file runs on both headless and a device.
- **`repeat: n`:** runs a `send` or `fake` step n times; a failure names the `repetition`.
- **`settle`:** a `send`, `fake`, or `clock` step that ends neither idle nor quiescent fails the scenario. `settle: false` skips waiting for effects.
- YAML 1.2 rules apply: `on` and `yes` are strings. Quote a string that looks like a number.

Whether a step can run is decided from `describe` before it runs. Each file starts from a fresh app on headless; a device runs against its current state, so reload it first.

## Failures

The run stops at the first failing step, and the result's `failedStep` says why:

| Failure | `failedStep` carries |
|---|---|
| An `expect` did not hold, or a `wait` timed out | `expected` (the condition) and `actual` (the value read) |
| A step did not settle | `actual: { settle }` with what is still pending |
| The target can't run a non-optional step | `error` with `UNSUPPORTED`, or `UNKNOWN_FAKE` for a fake it doesn't wire |
| Anything else | `error`, such as `INVALID_PAYLOAD`, `DISPATCH_FAILED`, or `TARGET_DISCONNECTED` |

An invalid file is reported as `INVALID_SCENARIO` with every problem and its line in `details.issues`, and no file runs.
