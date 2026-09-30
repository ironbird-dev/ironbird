# M3: Agent interface, design

| | |
|---|---|
| Status | Approved section by section 2026-09-29; revised after a codex review (reload lifecycle, remote replacement, eval isolation and grading) |
| Milestone | M3 in [roadmap.md](../../roadmap.md) |
| Builds on | [architecture.md](../../architecture.md) §2, §12 · [protocol.md](../../protocol.md) operation tables, capabilities, versioning rules · [cli.md](../../cli.md) `mcp`, "MCP tools", `reset`, `screenshot`, `step`, `scenario run` · [M2 design](2026-09-25-m2-fakes-and-scenarios-design.md) D5, D14 · [ADR-0001](../../adr/0001-commands-only-agent-surface.md), [ADR-0005](../../adr/0005-pure-javascript-no-native-code.md) |

This spec records only what the existing docs leave open for M3. Where this spec and an older doc disagree, this spec wins, and the older doc is updated in the same pull request as the code.

## 1. Scope

M3 delivers R13 (the MCP server) and R14 (the agent skill), the agent setup documentation, and the eval that measures the exit criteria. It also adds one operation, `reload`, found necessary while designing the eval (D4). R17 (`watch`) moves to M5 (D3). Q3 is resolved by D2.

The exit criteria and how each is measured:

| Criterion (roadmap) | Measured by |
|---|---|
| In 5 fresh sessions, an agent given the skill and the report "orders sometimes complete with a zero total" reproduces the bug with a scenario, fixes it, and verifies the fix headlessly and on iOS with evidence, succeeding in at least 4 sessions without human steering | Five scripted `claude -p` sessions on Sonnet 5.5 against a fixture copy of the example with the race always on, each graded automatically on four checks (§7) |
| Every "verified" claim from those sessions is spot-checked, and the false-claim rate is recorded as a baseline | Every verification claim in each session's final report is checked against the grading results and the artifacts on disk; the rate is recorded in `docs/evals/m3-agent-interface.md` (§7.5) |

Out of scope: `watch` (M5), per-command MCP tools (P2), a `reload` scenario step, reloading remote targets inside `scenario run`, MCP over HTTP, Android in the eval, and image resizing for screenshots.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `ironbird mcp` is a stdio MCP server inside `@ironbird/cli` and a thin client of the daemon: each tool is one `DaemonClient` call, except `ironbird_run_scenario`, which calls M2's `runScenario` in process | Maintainer decision. Matches architecture.md §2: the daemon is the only long-lived process and every other surface is a thin client. The server starts once per agent session, so tools avoid the CLI's Node start-up cost |
| D2 | The server uses `@modelcontextprotocol/server` 2.x with Zod 4 input schemas; app command schemas reach the agent as JSON Schema inside `ironbird_describe` results, never as tool input schemas | Resolves Q3. The v2 server package depends only on `zod ^4.2.0` and its own core, takes Zod 4 objects as `inputSchema` directly, and its stdio transport is `serveStdio` from `@modelcontextprotocol/server/stdio`. The generic `ironbird_send` (architecture.md §12) means no app schema ever becomes a tool schema |
| D3 | R17 `watch` moves from M3 to M5 | Maintainer decision. It does not move the M3 exit criteria, and MCP tools cannot stream |
| D4 | A new `reload` operation means "load the app's current code from a fresh start" on both target kinds: headless re-bundles its entry, remote calls `DevSettings.reload()` | Maintainer decision. The daemon bundles the headless entry once at start and `reset` re-runs that bundle, so without `reload` an agent's headless check after a fix silently runs the old code. On device, only the test helpers can reload the app today |
| D5 | A failed headless `reload` leaves the target unusable, reporting the load error, until a `reload` succeeds; it never falls back to the previous code | An agent must never verify a fix against code it has already replaced. Follows the existing failed-`reset` pattern (`bootError`) |
| D6 | The skill ships inside `@ironbird/cli` and `ironbird agent setup` installs it and registers the MCP server | Maintainer decision. The skill's version always matches the installed CLI, and the eval installs through the same command users run |
| D7 | The skill is app-agnostic; it never names the example app, its commands, or the race | The eval would measure the skill leaking the answer, not the agent using the loop |
| D8 | The eval runs as scripted `claude -p` sessions, one at a time, with the model pinned to Sonnet 5.5 | Maintainer decisions. Scripted runs are repeatable and unsteered by construction; Sonnet tests whether the skill and tools carry an everyday model |
| D9 | Each eval session runs outside the repository with project-only settings, and proves its isolation from the init event of its own stream: only Claude Code's bundled skills and plugins, the ironbird skill, and the ironbird MCP server may be loaded, and its auto memory must be empty. File access outside the session is denied and audited | The maintainer's machine has user-level plugins, skills, and memory, and the repository holds the answer. A fresh config directory is not an option: it signs the session out |
| D10 | A session passes only if four automatic checks pass. "Verified" means a passing run of the reproducing scenario for that target, backed by the transcript, matching the final scenario file, and finished after the agent's last edit; the grader also re-runs the reproducing scenario itself on both targets | The criterion's "with evidence" and the false-claim baseline both need a definition that a script can check, and that an easy unrelated pass or a stale run cannot satisfy |

## 3. Work breakdown

Three implementation plans, in dependency order. Plan 2 needs plan 1 only for `ironbird_reload`, and plan 3 needs both.

1. **Reload:** the protocol operation and capability, the headless implementation, the bridge handler, the daemon's remote reload wait, `ironbird reload`, and the protocol and CLI docs.
2. **Agent interface:** `ironbird mcp` and its tools, the skill, `ironbird agent setup`, `docs/agents.md`, and the cli.md rewrite of the MCP sections.
3. **Eval and gate:** the fixture patch, `prepare`, `run-session`, `grade`, the pilot sessions, the five gate sessions, the false-claim review, and the M3 evals record.

## 4. The `reload` operation

An additive protocol change under protocol.md's versioning rules: a new operation, a new capability, and a new optional parameter. `PROTOCOL_VERSION` stays 1 and no ADR is needed. `reload` reloads the app's own code; it runs nothing the caller supplies, so ADR-0001 holds.

| Op | Params | Result |
|---|---|---|
| `reload` | `target?`, `timeoutMs?` (remote only, default 60,000) | `{ target, rev }` |

A target that does not declare the `reload` capability fails with `UNSUPPORTED`, details `{ op: 'reload', target }`.

### 4.1 Headless

The headless target always declares `reload`, so its capabilities become `settle`, `events`, `clock`, `reset`, and `reload`, plus `fakes`, `persist`, and `restore` as before. `createHeadlessTarget` gains an option `loadDefinition?: () => Promise<HeadlessDefinition>`; `serve` passes one that calls `loadTypeScriptModule` on the headless entry with a fresh label each time (`headless-<n>`), which already evaluates a new module instance per call. A target created without `loadDefinition`, as in tests that build a definition inline, does not declare `reload`.

**One lifecycle transition.** `reset` and `reload` are both lifecycle transitions and share one serialized path:

1. The transition starts by abandoning the queue (`queue.abandon('reset')` or `queue.abandon('reload')`, a new abandonment cause), clearing `session`, and disposing the old session, all before its first await. Everything in flight or waiting fails with `TARGET_DISCONNECTED`, details `{ target: 'headless', op }`, as a reset does today.
2. `reload` then calls `loadDefinition()`; `reset` reuses the current definition.
3. It boots a session from the definition and installs it.

Transitions never overlap: a transition requested while another is running waits for it, then runs. Two concurrent `reset`s still coalesce into one, as today. A `reload` never coalesces, because the source may have changed since the running transition read it. A `reset` requested while a `reload` is running waits for the reload and then resets the freshly loaded code.

**D5, failure.** The old session is disposed before anything is loaded, so a failure never leaves the previous code running. If `loadDefinition()` or the boot fails, the error (`HEADLESS_LOAD_FAILED` with its usual details, including the `react-native` import chain) is kept as the target's boot error and the current definition is cleared. Every later operation fails with that error, and so does `reset`, because resetting would run code that no longer matches the source. Only a `reload` that succeeds clears it.

- The event log and the fake call logs restart, as after `reset`.
- Only the headless entry is reloaded. `ironbird.config.ts` is read once at daemon start; cli.md says a config change needs a daemon restart.
- Node keeps every evaluated module for the life of the process, so a daemon reloaded hundreds of times grows accordingly. That is acceptable for a dev tool, and cli.md notes it.

### 4.2 Remote

- The bridge declares `reload` when `DevSettings.reload` from `react-native` is a function. That is a JavaScript API that works only in dev builds, and the bridge is dev-only already, so ADR-0005 holds.
- On `reload`, the bridge replies `ok` and then calls `DevSettings.reload()` on the next tick, so the reply leaves before the JavaScript context goes away.

The daemon handles `reload` for a remote target itself, around the bridge operation:

1. **Ambiguity check.** If another connected remote target has the same `appId` and platform, for example the same app on two simulators, the daemon cannot tell which new connection is the reloaded one. It fails before sending anything, with `AMBIGUOUS_TARGET`, details `{ available }` listing those targets.
2. **Observers first.** Before sending the bridge operation, the daemon installs a target-lifecycle observer and marks the old target as *being replaced*.
3. **Same id.** When a new connection completes its `hello` with that `appId` and platform while a replacement is pending, the bridge server first closes and unregisters the old connection if its socket has not closed yet, releasing its id, and only then claims an id. The new connection therefore lands on the same id even when it arrives before the old socket's close event.
4. **Completion.** The reload completes when the replacement target registers, after its `describe`. The daemon then calls `getState` on it and returns `{ target, rev }` from that read; a fresh connection's `rev` is otherwise 0 until its first state notification.
5. **Timeout.** `timeoutMs` defaults to 60,000 and is applied before the daemon computes its request bound, so the default 30-second request timeout never cuts a reload short. If no replacement registers in time, the operation fails with `TARGET_DISCONNECTED`, details `{ target, op: 'reload', timeoutMs }`, and the pending replacement is cleared.

Operations in flight on the old connection fail with `TARGET_DISCONNECTED`, as on any disconnect today. The skill tells agents to use the `target` that `reload` returns from then on.

### 4.3 CLI

```text
ironbird reload [--target <id>] [--timeout <duration>]
```

Prints `{ target, rev }`. Exit codes follow the existing table: 2 for `HEADLESS_LOAD_FAILED` and `AMBIGUOUS_TARGET`, 1 for `TARGET_DISCONNECTED` and for `UNSUPPORTED` on a target without the capability, and 5 for `NO_TARGET` or no daemon.

## 5. The MCP server

```text
ironbird mcp [--daemon <url>]
```

Runs over stdio until stdin closes. The server finds the daemon lazily on each tool call, the way CLI commands do (`--daemon`, then the nearest `.ironbird/daemon.json`, then the default URL, with `IRONBIRD_TOKEN` for the token), so the server can start before the daemon, and a daemon restart needs no MCP restart. When no daemon answers, the tool error's message says to start `ironbird serve`. The server's name is `ironbird` and its version is the package version. Nothing is written to stdout except MCP messages; diagnostics go to stderr.

### 5.1 Tools

This table replaces cli.md's "MCP tools" table.

| Tool | Input | Returns | Daemon operation |
|---|---|---|---|
| `ironbird_status` | none | `{ version, protocol, uptimeMs, targets }` | `status` |
| `ironbird_describe` | `target?` | `Description`: app, commands and fakes with JSON Schemas, capabilities | `describe` |
| `ironbird_send` | `command`, `payload?`, `target?`, `path?`, `settle?` | `StepResult` | `dispatch` |
| `ironbird_step` | `command`, `payload?`, `target?`, `path?`, `settle?`, `device?` | `StepResult` plus `screenshot` and `settledBeforeCapture`, and the screenshot as image content | `step` |
| `ironbird_state` | `path?`, `target?` | `{ rev, path, value }` | `getState` |
| `ironbird_wait` | `path`, exactly one of `equals`, `notEquals`, `exists`, `matches`, `timeoutMs?`, `target?` | `{ rev, path, value, waitedMs }`, or a `WAIT_TIMEOUT` error | `waitFor` |
| `ironbird_settle` | `timeoutMs?`, `target?` | `SettleResult` | `settle` |
| `ironbird_fake` | `fake`, `control`, `payload?`, `target?`, `path?`, `settle?` | `StepResult` | `fakeControl` |
| `ironbird_fake_calls` | `fake`, `since?`, `limit?`, `target?` | `{ calls, nextSeq, truncated }` | `fakeCalls` |
| `ironbird_events` | `since?`, `limit?`, `target?` | `{ events, nextSeq, truncated }` | `events` |
| `ironbird_clock_advance` | `ms`, `path?`, `settle?`, `target?` | `StepResult` plus `now` | `clockAdvance` |
| `ironbird_clock_now` | `target?` | `{ now }` | `clockNow` |
| `ironbird_screenshot` | `target?`, `device?` | `Screenshot` and the image as image content | `screenshot` |
| `ironbird_run_scenario` | `path` (a file or a folder), `target?`, `bail?` | `{ results: ScenarioResult[] }`, one per file | `runScenario` in process |
| `ironbird_reset` | `target?` | `{ target, rev, path, value }` | `reset` |
| `ironbird_reload` | `target?`, `timeoutMs?` | `{ target, rev }` | `reload` |

Rules:

- Each input schema is a Zod 4 object. `settle` is `boolean | { timeoutMs: number }` as in the protocol. Durations are milliseconds; only the CLI accepts suffixes.
- A successful result is one text block holding the result as JSON. `ironbird_step` and `ironbird_screenshot` add one `image` block: the MCP server reads the PNG at the path the daemon returns and sends it base64-encoded as `image/png`. Both processes run on the same machine, as the CLI already assumes for screenshot paths.
- A failure is a result with `isError: true` and one text block holding the same `{ code, message, details }` JSON the CLI prints. Input that fails the tool's own schema is rejected by the SDK before any daemon call.
- `ironbird_run_scenario` resolves `path` against the MCP server's working directory, which is the project root when started from `.mcp.json`. It behaves as `scenario run` does, including validating every file before running any, D14's reset before each file on a headless target, and `bail`, and returns the same results, including each artifacts path. A file that fails validation is an `isError` result with `INVALID_SCENARIO`; a scenario that runs and fails is a normal result with `passed: false`, because the failure is information the agent asked for.
- Tool descriptions are written for agents and name the next useful call. For example, `ironbird_send` says to call `ironbird_describe` first for command names and payload schemas; `ironbird_run_scenario` says a remote app runs against its current state and suggests `ironbird_reload` first.

### 5.2 Dependency

`@ironbird/cli` gains `@modelcontextprotocol/server` (2.x) as a dependency and `@modelcontextprotocol/client` (the matching 2.x) as a dev dependency for the integration test. Pull-request justification: the official MCP server SDK, which ironbird needs to speak MCP, and whose v2 server package adds only its own core and the `zod` the CLI already uses.

## 6. The skill and `ironbird agent setup`

### 6.1 The skill

The skill ships in `@ironbird/cli` at `skills/ironbird/`, in Agent Skills format, and `skills` joins the package's `files`:

- `SKILL.md`: front matter `name: ironbird` and a `description` that says when to use it (reproducing, fixing, or verifying app behavior in a React Native app that has ironbird set up), then the loop.
- `references/scenarios.md`: a condensed form of cli.md's "Scenario files": step kinds, conditions, `optional`, `repeat`, `settle`, and the failure table.

`SKILL.md` teaches this loop, each step with its MCP tool and its CLI equivalent:

1. **Orient.** `ironbird_status`, then `ironbird_describe`. Read the commands, fakes, and capabilities before acting. If no daemon answers, start `ironbird serve` in the background.
2. **Reproduce headlessly.** Drive commands on the headless target. Use fake controls and clock advances to try the orderings the outside world can produce: delayed, duplicated, reordered, and missing events. Read state, events, and fake calls to see what happened.
3. **Pin it down as a scenario.** Write a YAML file under `ironbird/scenarios/` that ends in an `expect` of the correct behavior, and confirm with `ironbird_run_scenario` that it fails before changing app code. A scenario that passes before the fix does not reproduce the bug.
4. **Fix.** Change the app code, `ironbird_reload` the headless target, and run the scenario until it passes. Then run the whole scenarios folder and the project's tests to catch regressions.
5. **Check on a device.** `ironbird_reload` the device target so it runs the fixed code from a fresh start, then run the same scenario with `target` set to it. Clock steps must be `optional: true`, because device targets have no clock control. Take a screenshot of the end state.
6. **Report with evidence.** Never say "verified" without quoting the passing result: `passed`, the target, and the artifacts path. Say which targets were checked. Report a check that could not be run as not done, not as passed.

The skill never names the example app, its commands, or the race (D7). It stays under 200 lines; detail lives in the reference file.

### 6.2 `ironbird agent setup`

```text
ironbird agent setup [--skills-dir <dir>]
```

Runs without a daemon, in the project root (the working directory).

- Copies the packaged skill into `<skills-dir>/ironbird/`, default `.claude/skills`, replacing the files it owns and leaving other files in that folder alone. Codex and other Agent Skills readers are pointed at their own folder with `--skills-dir`.
- Adds or replaces only the `mcpServers.ironbird` entry in `.mcp.json`, creating the file if absent: `{ "command": "npx", "args": ["ironbird", "mcp"] }`. Other servers and keys are kept, and the file is written with two-space indentation and a trailing newline.
- Running it again brings the skill up to date with the installed CLI version.
- Prints `{ skill: { dir, files }, mcp: { file, updated } }`, where `updated` is false when the entry was already identical.
- If `.mcp.json` exists but is not a JSON object, fails with `INVALID_CONFIG`, details `{ file, issues }`, exit 2, and writes nothing, including the skill.

### 6.3 Docs

- New `docs/agents.md`, the roadmap's agent setup documentation: running `agent setup`; what the MCP server needs (a running daemon, and Metro plus the app for device checks); the loop in brief, pointing at the skill; and using the skill with agents other than Claude Code.
- `cli.md`: `mcp` and "MCP tools" lose their P1 markers and are rewritten per §5; new `reload` and `agent setup` sections; `reset` points at `reload` for code changes; `serve` notes that a config change needs a restart.
- `protocol.md`: the `reload` operation, the capability, and its errors.
- `spec.md`: R13 and R14 ticked at the gate; Q3 marked resolved with D2; R17's milestone note moved to M5.
- `roadmap.md`: M3 scope drops R17, M5 gains it; M3 criteria ticked at the gate.
- `architecture.md` §12: a row for D4.
- Changesets: `@ironbird/cli` for `mcp`, `reload`, `agent setup`, the skill, and the dependency; `@ironbird/react-native` for the `reload` capability; `@ironbird/core` for the `reload` capability type and operation name.

## 7. The eval harness and the gate

The harness lives in `examples/checkout/eval/` as Node scripts. It runs by hand on macOS, never in CI, and uses the iPhone 17 simulator through `IRONBIRD_SIM_UDID`. Everything a session must not see (the fixture patch, the held-back scenarios, the grader) stays in the repository; sessions run under `~/.ironbird-eval/`, outside it, so no `AGENTS.md` or `CLAUDE.md` is an ancestor of a session folder.

### 7.1 Fixture

`prepare` builds a session template at `~/.ironbird-eval/template/`:

1. Copies `examples/checkout` without `node_modules`, `dist`, `.expo`, `.ironbird`, `eval/`, and `scripts/`.
2. Applies `fixture.patch`, which makes the race unconditional and removes what would give it away: the `plantRace` option and its threading, the "Planted bug" comments, the race and duplicate-success scenarios, tests that name the race, and README text about it.
3. Rewrites `package.json` into a standalone manifest: `@ironbird/core`, `@ironbird/react-native`, and `@ironbird/cli` point at `pnpm pack` tarballs of the current build copied into `vendor/`; `vitest` joins `devDependencies` at the monorepo's version; `test` becomes `vitest run`; the measurement script and its `pngjs` dependencies go. `tsconfig.json` stops extending the monorepo's base config and inlines its compiler options. A `vitest.config.ts` includes `src/**/*.test.ts` and excludes device tests.
4. Runs `npm install`, which writes a lockfile, then `npx ironbird agent setup`.
5. Runs `git init` and makes one commit, so the session has no history to read the answer from.

`prepare` then checks the template before any session: `npm test` passes; `ironbird serve` starts and `ironbird status` lists the headless target; every remaining scenario passes; the held-back race scenario fails headless; and Expo bundles the app (`npx expo export --platform ios` into a temporary folder). Each session gets an APFS clone (`cp -c -R`) of the template, `node_modules` included.

### 7.2 One session

`run-session <n>` runs one session end to end:

1. Clones the template into `~/.ironbird-eval/sessions/<n>/`.
2. **Fresh device.** Terminates Expo Go on the iPhone 17 (`xcrun simctl terminate <udid> host.exp.Exponent`), starts `ironbird serve` and `npx expo start --clear` in the session folder, and opens `exp://127.0.0.1:8081` with `xcrun simctl openurl <udid>`. It waits for a `connected` target event for `ios` that arrives after the daemon started, then checks the app's initial state (an empty cart and no order). A session whose device never gets there is invalid, not failed.
3. Runs `claude -p` in the session folder with:
   - `--model claude-sonnet-5-5`
   - `--setting-sources project`, `--strict-mcp-config --mcp-config .mcp.json`
   - `--tools Bash,Read,Edit,Write,Skill`
   - `--permission-prompts none`, `--allowedTools` for `mcp__ironbird__*` and for `Bash` limited to `npx ironbird *`, `npm test*`, `npx vitest *`, `git status*`, `git diff*`, and `git log*`, and `--settings` with deny rules for reading or editing the repository and `~/.ironbird-eval/template/`
   - `--max-budget-usd 10`, a 45-minute wall-clock limit, and `--output-format stream-json --verbose`, with the full stream saved as `transcript.jsonl`
4. **Isolation check (D9).** Before the agent's first tool call counts, the harness reads the stream's init event. The session is invalid if it lists an MCP server other than `ironbird`, a skill other than `ironbird` and Claude Code's bundled skills (recorded once, by `prepare`, from a session with no project skill), or a plugin that is not built in; or if the auto-memory folder it reports is not empty. After the session, the harness also scans the transcript for any tool call that touched a path outside the session folder and records each one.
5. Copies `.ironbird/runs/` to `agent-runs/` before anything else runs, then stops Metro and the daemon. The session folder is kept for grading.

The prompt is fixed in `prompt.md`:

> Users report that orders sometimes complete with a zero total. Find the cause, fix it, and verify the fix. The ironbird daemon is running, and the app is running on the iOS simulator as target `ios`.

### 7.3 Grading

`grade <n>` works on a copy of the session and writes its own runs to a separate artifacts folder, never to `agent-runs/`. A session succeeds only if all four checks pass. "The bug state" below means a final state with `order.status` equal to `completed` and `order.totalCents` equal to 0.

| Check | How |
|---|---|
| Reproduced with a scenario | Among the scenario files the agent added under `ironbird/scenarios/`, at least one, *the reproducing scenario*, fails headless against the template with the bug state in its final `state.json`, and passes headless against the session's code without the bug state |
| Fixed | The held-back race and duplicate-success scenarios pass headless against the session's code, and the fixture's remaining scenarios and `npm test` still pass |
| Verified on iOS by the grader | The grader reloads the iOS app against the session's Metro, runs the reproducing scenario on `ios`, and requires a pass without the bug state |
| Verified by the agent, with evidence (D10) | `agent-runs/` holds a passing run of the reproducing scenario for target `headless` and one for target `ios`. Each run's copied scenario matches the final file byte for byte; each run is named in an `ironbird_run_scenario` or `ironbird scenario run` result in the transcript; each finished after the agent's last edit to any file it changed, taken from the transcript's edit tool calls; and the `ios` run's folder holds a screenshot or the transcript shows an `ironbird_screenshot` or `ironbird_step` after it |

"Unsteered" holds by construction under `-p`. `grade` reports the number of denied tool calls and of out-of-folder paths, and writes `grade.json` with each check's result and its evidence.

### 7.4 Gate procedure

- Up to two pilot sessions may run first to debug the harness; they are labeled pilots and do not count.
- The gate is five fresh, valid sessions with the skill and harness frozen. It passes with at least four successes.
- If it fails and the skill changes, all five sessions run again. Every batch is recorded, failures included.

### 7.5 False-claim baseline

For each gate session, every sentence of the final report that claims something was verified, fixed, reproduced, or passes is a claim. Each claim is checked against `grade.json` and the files on disk: a claim holds only if the evidence it names exists and says what the claim says. A codex review does a first pass, and every claim is then checked by hand. The false-claim rate is the number of claims that don't hold divided by all claims, across the five sessions. The rate and the claims themselves go in `docs/evals/m3-agent-interface.md`, with each session's grade, cost, duration, and transcript location.

## 8. Testing

Per [testing-strategy.md](../../testing-strategy.md):

- **Core unit:** `reload` in the operation and capability types.
- **CLI unit:** headless `reload` picks up an edited entry; a broken edit leaves `HEADLESS_LOAD_FAILED` on every later operation, including `reset`, until a good reload; logs restart; a `reload` during an in-flight dispatch abandons it with `TARGET_DISCONNECTED`; concurrent `reload` and `reset`, and two concurrent `reload`s, run one after another and leave the last-requested code installed. The daemon's remote reload against fake bridges: the replacement arriving after the old close and before it (both land on the same id), a replacement that arrives after 30 seconds but within `timeoutMs`, the timeout, `AMBIGUOUS_TARGET` with two matching apps, `rev` read from the replacement, and `UNSUPPORTED` without the capability. `ironbird reload` output and exit codes. `agent setup` on a fresh project, with an existing `.mcp.json` holding other servers, run twice, and with invalid JSON.
- **CLI integration (serial project):** the MCP server driven by the SDK's client over an in-memory transport, against a daemon hosting the example headless app: every tool's happy path, an `isError` result with the CLI's error JSON, `ironbird_run_scenario` on a file and a folder, and image content from `ironbird_screenshot` with a stub screenshot provider.
- **Bridge unit:** the `reload` capability appears only when `DevSettings.reload` exists, and the handler replies before calling it.
- **Packaging:** a test that `skills/ironbird/SKILL.md` is in the packed `@ironbird/cli` tarball and that its front matter parses.
- **Device:** `examples/checkout/test/reload.device.test.ts` reloads the example on the iPhone 17 through `ironbird reload`, checks that the target comes back on the same id with fresh state, and that a following `send` works.

## 9. Errors and types

- New operation name `reload` and capability `reload` in core's protocol types.
- No new error codes. `reload` uses `UNSUPPORTED`, `HEADLESS_LOAD_FAILED`, `TARGET_DISCONNECTED` with details `{ target, op: 'reload', timeoutMs }`, `NO_TARGET`, and `AMBIGUOUS_TARGET` as described in §4.
- MCP tool failures carry the existing `ErrorShape` unchanged.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `claude -p` sessions still pick up user-level configuration or read the answer from the repository | Project-only settings, sessions outside the repository, deny rules, the init-event check, and the transcript path audit; a session that fails any of them is invalid, not counted |
| The skill is too specific and leaks the answer, or too generic to help | D7, checked in review; the pilots show whether Sonnet follows the loop, and the gate records every batch if the skill has to change |
| A session reuses the previous session's app | Expo Go is terminated and relaunched against the session's own Metro, and the harness checks a new connection and the initial state before the agent starts |
| Metro or Expo Go flakes during a 45-minute session | `run-session` waits for the `ios` target before starting the agent, and a session whose device never connects is invalid, not failed |
| `DevSettings.reload()` behaves differently in Expo Go and bare apps | The bridge only declares the capability when the function exists; the device test covers Expo Go, which is what the eval uses |
| A headless reload that keeps old modules alive leaks memory over a long session | Acceptable for a dev tool; noted in cli.md; a restart clears it |
| Large PNGs in image content cost many tokens per step | Out of scope for M3; the eval records per-session cost, which will show whether resizing is worth adding |
| The allowlist blocks a command the agent reasonably needs | Denied calls are counted per session; pilots tune the allowlist before the gate, and it is frozen with the skill |
