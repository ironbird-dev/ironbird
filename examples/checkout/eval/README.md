# The M3 agent eval

This folder measures the two M3 exit criteria in [docs/roadmap.md](../../../docs/roadmap.md): whether a coding agent given the ironbird skill and the report "orders sometimes complete with a zero total" reproduces the bug with a scenario, fixes it, and verifies the fix headlessly and on iOS with evidence, and how often its "verified" claims are false. The design is §7 of [the M3 design](../../../docs/superpowers/specs/2026-09-29-m3-agent-interface-design.md); results go in [docs/evals/m3-agent-interface.md](../../../docs/evals/m3-agent-interface.md).

It runs by hand on macOS and never in CI. Each session is one `claude -p` run on Sonnet against a copy of this example with the race always on, outside the repository, graded by a script on four checks.

The model is passed as the alias `sonnet` (`MODEL` in `lib/paths.mjs`). Claude Code 2.1.283 rejects the full id `claude-sonnet-5-5` as an unrecognized model, so the alias is the only way to pin the family. The id it resolves to is recorded as `resolvedModel` in each `session.json`, and the isolation check requires it to match `^claude-sonnet-` (`MODEL_PATTERN`).

## Before you start

- macOS with Xcode's command line tools, and the iPhone 17 simulator booted with Expo Go installed. Export its udid: `export IRONBIRD_SIM_UDID=<udid>`. The harness opens the app by udid (`xcrun simctl openurl`) and never uses `expo start --ios`, which picks its own simulator. It never boots, shuts down, or erases a simulator, and never touches any other one.
- Node 22 or later, pnpm, npm, and git.
- Claude Code installed and signed in. Sessions use your normal configuration with `--setting-sources project`; a fresh `CLAUDE_CONFIG_DIR` would be signed out.
- Ports 4567, 4568, and 8081 free: no `ironbird serve` and no Metro running, including the repository's own.
- No `AGENTS.md` or `CLAUDE.md` in `~/.ironbird-eval` or any folder above it. Claude Code's built-in agents-md plugin would load it into every session. `prepare.mjs` checks this.

The example's device bridge passes Expo's `reloadAppAsync` as its `reload`, because React Native's `DevSettings.reload` leaves Expo Go without its native modules and the app never reconnects. That is what makes `ironbird reload` work on the device, for the agent and for the grader.

Metro runs with `EXPO_NO_TYPESCRIPT_SETUP=1`. Otherwise Expo would add `extends: expo/tsconfig.base` to the copy's standalone `tsconfig.json` on start, and every session would begin with a change the agent did not make.

## Commands

All of them run from the repository root.

| Command | What it does |
|---|---|
| `node examples/checkout/eval/prepare.mjs` | Builds the packages, copies this example to `~/.ironbird-eval/template/` without `node_modules`, `dist`, `.expo`, `.ironbird`, `eval/`, and `scripts/`, applies the fixture transform (`lib/fixture.mjs`), vendors `pnpm pack` tarballs of core, react-native, and cli, rewrites the manifest and tsconfig to stand alone, runs `npm install` and `npx ironbird agent setup`, and commits it all as one git commit. Then it checks the template (a leak audit of every surface a session can see: the fixture with its installed skill, `node_modules/@ironbird`, and the extracted vendor tarballs, where every hit of a hint term needs an explicit allow entry with a reason; `npm test`, `ironbird serve` and `status`, the three remaining scenarios pass, the held-back race scenario fails with a zero total, `expo export` bundles) and records a baseline from one `claude` start in an empty folder, run under the sandbox and stopped at its init event. `--skip-build` reuses the current `dist/`; `--skip-baseline` skips the `claude` start |
| `node examples/checkout/eval/run-session.mjs <id> [--label gate\|pilot\|smoke]` | Sets one 45-minute deadline for the whole session, clones the template into `~/.ironbird-eval/sessions/<id>/project/`, stops Expo Go and proves it stopped, starts `ironbird serve` and Metro there (Metro proved to be its own process running in that folder), opens the app, waits for a fresh `ios` target in its initial state, runs `claude -p` inside a `sandbox-exec` profile with the fixed prompt (`prompt.md`), checks the session's isolation from its init event, stops claude at the deadline (less a 2-minute teardown reserve) or at $10, copies `.ironbird/runs/` to `agent-runs/`, reaps every process group it started, waits for its ports, audits the transcript, and writes `session.json`. `--print-args` prints the command line, settings, and profile and starts nothing. `--prompt <file>`, `--max-budget-usd <n>`, and `--probe-sandbox` exist for the smoke check (`smoke-prompt.md`); gate sessions use the defaults |
| `node examples/checkout/eval/grade.mjs <id>` | Grades a session on copies under `~/.ironbird-eval/grades/<id>/` and writes `grade.json`, `final-report.md`, and `claims.md`. It exits non-zero when it could not stop everything it started. `--skip-ios` leaves the iOS check not run, for self-tests without a simulator |
| `node examples/checkout/eval/make-selftest-session.mjs <id> --fix\|--no-fix` | Builds a synthetic session (the template, the race scenario added, and with `--fix` the known fix) for checking the grader without running `claude`. It has an empty transcript and no agent runs, so the agent-evidence check always fails on it |
| `node examples/checkout/eval/summarize.mjs <prefix>` | Prints a markdown table row per session whose id starts with `<prefix>`, for the evals record |

Session ids are lowercase words and digits with dashes: `smoke-1`, `pilot-1`, `g1-1` to `g1-5` for the first gate batch. Every session needs a new id.

The harness's own unit tests are the `eval/lib/*.test.mjs` files, part of the root `unit` project and so of `pnpm test`. They use only `os.tmpdir()`: nothing in `pnpm test` starts `claude`, touches a simulator, or writes under `~/.ironbird-eval/`.

## Layout

```text
~/.ironbird-eval/      (override with IRONBIRD_EVAL_HOME)
  template/            the fixture, installed and committed; sessions clone it
  prepare.json         when and from which commit the template was built, tarball hashes, check results
  baseline.json        Claude Code's version and the skills and plugins of one empty-folder start
  sessions/<id>/
    project/           the agent's working folder
    transcript.jsonl   the full stream-json output
    claude-stderr.log  claude's stderr
    agent-runs/        the agent's scenario runs, copied from project/.ironbird/runs/
    settings.json      the rendered deny rules
    session.json       validity and its reasons, isolation, device check, resolved model, cost, denied calls, out-of-folder paths, what teardown reaped
    logs/              serve.log, metro.log
  grades/<id>/
    session/, template/   the grader's copies, with the grader's own runs under .ironbird/
    logs/              the grader's daemon and Metro logs
    grade.json         each check's result and evidence, and what the grader's teardown left behind
    final-report.md    the agent's final report
    claims.md          the claims worksheet for the false-claim review
```

## Valid, failed, and succeeded

A session is **invalid**, and not counted, for any of these, and every cause found is listed in `invalidReasons`:

- The setup failed: the clone, the daemon, Metro, or opening the app did not finish (`startup:` and `device:` reasons), the app never reached a fresh `ios` target in its initial state, or startup used up the deadline.
- Its init event fails the isolation check (see below).
- Its transcript names any path outside `project/`, or shows a Bash call that writes files outside the edit tools (redirection, `tee`, `--output`).
- Copying `agent-runs/` failed, or teardown found a port held by a process the harness did not start or could not free its own ports.
- A process group the harness started (claude, Metro, the daemon) is still alive after the bounded reap.
- The 45-minute absolute deadline, which covers startup, claude, copying, and teardown, passed before teardown finished.
- The operator interrupted it.

Everything else is **valid**, including sessions stopped by the time or budget limit. A valid session **succeeds** only if all four checks in `grade.json` pass:

| Check | Passes when |
|---|---|
| `reproduced` | A scenario file the agent added under `ironbird/scenarios/` fails headless against the template at an `expect` or `wait` on a path under `order` (a condition, not an error), with a completed order whose total is 0 as the final state, and is a clean pass against the session's code without it. That file is the reproducing scenario. A clean pass is exit 0, `passed`, a readable `state.json`, and no artifact errors |
| `fixed` | The held-back race and duplicate-success scenarios (in this repository, never in a session) are clean passes against the session's code with exactly their expected final values (a completed order totalling 4500), the template's three scenarios are clean passes against it, and `npm test` passes |
| `iosByGrader` | On a fresh app on the session's code, the grader's own `ironbird reload` returns a target, a fresh connection of that target (the id the reload returned, not an assumed `ios`) follows the reload in the initial state, and the reproducing scenario is a clean pass on that target without the zero total |
| `verifiedByAgent` | `agent-runs/` holds a passing `headless` run and a passing `ios` run of the reproducing scenario, each with a scenario copy byte-identical to the final file and each reported by a scenario-run result in the transcript whose `artifacts` is exactly that folder, whose `file` is the final scenario, whose `target` matches, and whose `passed` is true, started after the agent's last edit anywhere in `project/` returned; and the `ios` run has a screenshot in its folder or a successful `ironbird_screenshot` or `ironbird_step` on `ios` after it |

A failure while setting up or tearing down the grader's iOS check (the simulator not booted, a port busy, Metro not starting, a missing `IRONBIRD_SIM_UDID`) fails `iosByGrader` with an `error`, not the whole grade. Whatever the grader could not stop is recorded under `teardown` in `grade.json` (`stopped`, `errors`, `aliveGroups`), and any such entry makes `grade.mjs` exit non-zero.

## Isolation

- `claude -p` runs under `sandbox-exec` with a generated profile: it allows everything, then denies reading and writing the repository and `~/.ironbird-eval`, then allows the session's `project/` again (the last matching rule wins). The MCP server and every Bash child inherit it; the daemon and Metro, started by the harness, do not. Permission rules only govern Claude Code's own tools, so the sandbox is the boundary and the permission rules are defence in depth. The profile is recorded in `session.json`, and `--print-args` shows it.
- Sessions run under `~/.ironbird-eval/`, outside the repository, so no `AGENTS.md` or `CLAUDE.md` is an ancestor.
- The agent's tools are `--tools Bash,Read,Edit,Write,Skill,Glob,Grep`, plus the ironbird MCP tools. Bash is limited to the allow-listed commands (`ALLOWED_BASH` in `lib/claude-args.mjs`). Read, Glob, and Grep are allowed only inside `project/`, and so are Edit and Write. `--permission-mode acceptEdits` is not used, because it would also approve file-changing shell commands that the transcript's edit timeline cannot see.
- `--setting-sources project` loads no user settings, skills, or plugins; `--strict-mcp-config --mcp-config .mcp.json` loads only the ironbird server; `--no-session-persistence` keeps sessions out of Claude Code's history. The settings go inline as JSON, because the sandbox denies the eval home, where a file would live.
- The session's environment drops the nested-session markers, every `npm_*` variable, and anything that names the eval, the repository, or the race, and turns Claude Code's auto-update off so the version matches the baseline.
- The init event is the first line of the stream, and it is judged on what it reports rather than against a fixed list, because Claude Code's bundled skill set varies between runs. It must show the ironbird MCP server connected and no other; the ironbird skill and no skill that is plugin-namespaced (`plugin:skill`) or that shares a name with a folder in `~/.claude/skills`; only plugins whose source ends in `@builtin`; an empty auto-memory folder; and a model matching `^claude-sonnet-`. A session that fails this is stopped at once and marked invalid. `baseline.json` records one empty-folder start as a record and a check of the setup (no MCP server, built-in plugins only, a Sonnet model); sessions are not compared with its skill list.
- `settings.json` denies reading and editing the repository, the template, the other sessions, the grades, the template check, and the baseline folder. `--permission-prompts none` denies anything else that would prompt, which includes reads outside the session folder.
- After the session, every path a tool call named outside `project/` is recorded in `session.json` and `grade.json`, and any such path makes the session invalid.

## Changing the harness

The prompt, model, budget, and time limit are fixed by the design. During the pilots (at most two, labeled `pilot`), and after a failed gate batch (skill only), the allowlist (`ALLOWED_BASH` in `lib/claude-args.mjs`), harness bugs, and the skill's wording may change; the skill must keep naming nothing about this app (design D7). After any change, run the unit tests, commit, and run `prepare.mjs` again so the template carries the change. Gate sessions refuse to start while `examples/checkout/eval/` or `packages/cli/skills/` has uncommitted changes. `--probe-sandbox` is only for `--label smoke`: it drops the deny rules and allows Bash `head` and Read on the repository and the eval home, so the smoke prompt's probes meet only the sandbox.

## Troubleshooting

- **`prepare` fails with "anchor not found"**: the example changed under a fixture edit. Update `FIXTURE_EDITS` in `lib/fixture.mjs` and its test.
- **`run-session` says the claude version differs from the baseline**: Claude Code updated. Run `prepare.mjs` again before any more sessions, and record the new version.
- **A session is invalid with a `device:` reason**: read `sessions/<id>/logs/metro.log` and `serve.log`. Check that the simulator is booted and Expo Go is installed on it.
- **A session is invalid with an `isolation:` reason**: the reason names what the init event showed, for example a plugin that is not built in or a user skill of the same name. Fix the setup and run again with a new id.
- **A port is busy**: `lsof -nP -iTCP:4567 -sTCP:LISTEN` (and 4568, 8081) shows the process; stop it by hand. The harness only ever stops process groups it started; it refuses to start, or marks the session invalid at teardown, when anything else holds its ports.
- **`prepare` fails the leak audit**: each line names a surface, a file, a term, and the text around it. Fix the fixture transform, or change the skill, or, if the text gives nothing away, add an entry to `HINT_ALLOWED` in `lib/fixture.mjs` with a reason and a test.
