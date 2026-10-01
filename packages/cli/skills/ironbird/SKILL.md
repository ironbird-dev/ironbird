---
name: ironbird
description: Use when reproducing, fixing, or verifying behavior in a React Native app that has ironbird set up (an ironbird.config.ts in the project, or ironbird_* MCP tools available). Drives the app's declared commands and fakes headlessly and on a device, pins the bug down as a scenario file, and reports only what was checked, with evidence.
---

# ironbird

ironbird drives a React Native app through the commands the app declares. A daemon, `ironbird serve`, hosts the targets:

- `headless` runs the app's logic in Node, with a manual clock and fakes standing in for the outside world. It is fast and deterministic, and it is where most of the work happens.
- A connected app, such as `ios` or `android`, is the real app on a simulator or device, with a real clock. It needs Metro and the app running.

Use the `ironbird_*` MCP tools when you have them, and the CLI (`npx ironbird <command>`) otherwise. Every step below names both, and both return the same JSON. MCP durations are milliseconds; the CLI also takes `ms`, `s`, and `m` suffixes.

You act only through declared commands and fake controls. There is no way to run arbitrary code in the app; don't look for one.

## The loop

Work through the six steps in order. Each one ends with something you can show.

### 1. Orient

| Do | MCP | CLI |
|---|---|---|
| Check the daemon and list targets | `ironbird_status` | `npx ironbird status` |
| Read commands, fakes, capabilities | `ironbird_describe` | `npx ironbird commands`, `npx ironbird fakes` |

Read every command's payload schema and every fake's controls before sending anything. Capabilities say what a target supports: `clock`, `reset`, `reload`, `fakes`.

If no daemon answers (`NO_TARGET`, "Daemon unreachable"), start one in the background from the project root with `npx ironbird serve`, leave it running, and retry. For device checks the app must also appear in `ironbird_status`; if it doesn't, say so rather than guessing.

### 2. Reproduce headlessly

Drive the `headless` target until state shows the reported bug.

| Do | MCP | CLI |
|---|---|---|
| Start from a fresh app | `ironbird_reset` | `npx ironbird reset` |
| Send a command | `ironbird_send` | `npx ironbird send <command> '<json>'` |
| Act as the outside world | `ironbird_fake` | `npx ironbird fake <fake> <control> '<json>'` |
| Move time forward | `ironbird_clock_advance` | `npx ironbird clock advance <duration>` |
| Read state | `ironbird_state` | `npx ironbird state [path]` |
| Wait for a condition | `ironbird_wait` | `npx ironbird wait <path> --equals <value>` |
| See what happened | `ironbird_events`, `ironbird_fake_calls` | `npx ironbird events`, `npx ironbird fake <fake> --calls` |
| Check pending work | `ironbird_settle`, `ironbird_clock_now` | `npx ironbird settle`, `npx ironbird clock now` |

Bugs that happen "sometimes" usually depend on when and in what order the outside world answers. Use fake controls and clock advances to try the orderings a real network, server, or device can produce: answers that arrive late, twice, out of order, or never. Change one thing at a time and read state after each step.

A step result's `settle` says whether work is still pending. On headless, `idle: false` with `quiescent: true` means the app is waiting on the clock or a fake: advance the clock or run a control. Events and fake calls show what the app asked for, and in which order.

### 3. Pin it down as a scenario

Write a YAML scenario under `ironbird/scenarios/` that replays the steps that showed the bug and ends in an `expect` of the correct behavior. The format is in [references/scenarios.md](references/scenarios.md).

Run it before changing any app code: `ironbird_run_scenario` with `path` set to the file, or `npx ironbird scenario run <file>`. It must fail at the `expect` you wrote, with the wrong value in `failedStep.actual`. A scenario that passes before the fix does not reproduce the bug: go back to step 2.

Write it so the same file runs on a device too: mark `clock` steps `optional: true`, because devices have no clock control, and `screenshot` steps `optional: true`, because headless has no screen.

### 4. Fix

Change the app code. Then reload before checking anything: `ironbird_reload`, or `npx ironbird reload`. Reload loads your current code from a fresh start. `reset` re-runs the code the daemon loaded earlier, so a check after only a `reset` runs the old code.

If reload fails with `HEADLESS_LOAD_FAILED`, the target stays unusable until a reload succeeds: fix the load error and reload again.

Run the scenario until it passes. Then run the whole folder (`path` set to `ironbird/scenarios`, or `npx ironbird scenario run ironbird/scenarios`) and the project's own tests, to catch regressions.

### 5. Check on a device

Reload the device target so it runs the fixed code from a fresh start: `ironbird_reload` with `target` set to it, such as `ios`, or `npx ironbird reload --target ios`. It returns `{ target, rev }`: use that `target` id from then on.

Run the same scenario with `target` set to that id. A device app has no `reset`, so the run starts from the state the reload left. Then capture the end state with `ironbird_screenshot`, or `npx ironbird screenshot --target <id>`, and look at it. `ironbird_step` (`npx ironbird step <command> '<json>'`) sends one command on a device and returns a screenshot with the result.

If `ironbird_step` fails with `SCREENSHOT_FAILED` and a second text block says the command was already applied, the command ran and only the capture failed. Don't retry the step: read the result with `ironbird_state`, and take the screenshot separately.

### 6. Report with evidence

- Never write "verified", "fixed", or "passes" without quoting the run that shows it: `passed: true`, its `target`, and its `artifacts` path.
- A run counts only if it used the final scenario file, came after your last code edit, and came after a reload of that target.
- Name every target you checked. If a check could not run, for example because no device was connected, report it as not done and say why. Never report it as passed.
- Name the scenario file and the assertion it makes, what the bug was, and what you changed.

## Results and errors

`ironbird_run_scenario` returns `{ results }`, one per file. The CLI prints one result per line. Each has `scenario`, `file`, `target`, `passed`, `stepsRun`, `skipped` (optional steps the target could not run), `failedStep` (`index`, `step`, then `expected` and `actual`, or `error`), and `artifacts`, the run folder. That folder holds `result.json`, a copy of the scenario file, `events.jsonl`, `state.json`, each fake's calls, and any screenshots.

Errors are `{ "error": { "code", "message", "details" } }`; MCP tools also set `isError`. The common ones:

| Code | What to do |
|---|---|
| `NO_TARGET` | Start `npx ironbird serve`, or connect the app, then check `ironbird_status` |
| `UNKNOWN_COMMAND`, `UNKNOWN_FAKE`, `UNKNOWN_CONTROL` | Use a name from `ironbird_describe`; `details.suggestions` lists near misses |
| `INVALID_PAYLOAD` | Fix the fields in `details.issues` against the payload schema |
| `UNSUPPORTED` | The target lacks that capability: clock and reset are headless only, screenshots device only |
| `WAIT_TIMEOUT` | `details.value` is the last value read; advance the clock or run a fake control first |
| `INVALID_SCENARIO` | Fix the file at the lines in `details.issues`; nothing ran |
| `TARGET_DISCONNECTED` | A reset or reload abandoned the call, or the app went away; check `ironbird_status` |
| `HEADLESS_LOAD_FAILED` | The app code does not load; fix it and reload |
| `SCREENSHOT_FAILED` | The capture failed. From `ironbird_step`, if a second text block says the command was already applied, don't retry it |
