# The M5 integration proxy

This folder measures a **proxy** for the first M5 exit criterion in [docs/roadmap.md](../../../docs/roadmap.md): "a developer other than the author wires ironbird into a copy of `examples/bare-redux` that doesn't include it yet, using only the docs, in ≤ 1 day". That criterion needs a human and is the maintainer's go/no-go for releasing 0.1.0; the proxy never ticks it. The design is D11 and §1 of [the M5 design](../../../docs/superpowers/specs/2026-10-04-m5-adapters-and-0.1-design.md); results go in [docs/evals/m5-adapters-and-0.1.md](../../../docs/evals/m5-adapters-and-0.1.md).

The proxy is one `claude -p` session on Sonnet that gets the same task sheet as the human, `integration-exercise/TASK.md`, and only the published docs, outside the repository and inside the M3 eval's sandbox. A grader scores the result on the five checks of `integration-exercise/CHECKLIST.md`, the same checks a human scorer runs. It runs by hand on macOS and never in CI; its unit tests (`lib/*.test.mjs`) run in `pnpm test` and never start `claude`.

## Before you start

- macOS, Node 22 or later, pnpm, npm, git, and Claude Code installed and signed in.
- Ports 4567, 4568, and 8081 free: no `ironbird serve` and no Metro running.
- No `AGENTS.md` or `CLAUDE.md` in `~/.ironbird-eval` or any folder above it. `prepare.mjs` checks this.

## Commands

All of them run from the repository root.

| Command | What it does |
|---|---|
| `node examples/bare-redux/eval/prepare.mjs` | Builds the packages; copies `integration-exercise/` to `~/.ironbird-eval/proxy/template/` without dependencies or build output, checking that it stands alone and names ironbird only in its four material files; packs core, react-native, redux, and cli and repacks them at 0.1.0 into `vendor/`; installs the app's own dependencies; commits it all as one git commit; copies the published docs (the README, package READMEs, and `docs/` without `docs/superpowers/` and `docs/evals/`) to `proxy/docs/`; checks, on a clone, that TASK.md's install commands install each tarball once from `vendor/` and that the grader fails the untouched app on every check but the fifth; and records a baseline from one `claude` start in an empty folder. `--skip-build` reuses `dist/`; `--skip-baseline` skips the `claude` start |
| `node examples/bare-redux/eval/run-session.mjs <id> [--label proxy\|smoke]` | Clones the template into `proxy/sessions/<id>/project/` and the docs into `proxy/sessions/<id>/docs/` (read-only: the sandbox lets the session read them and never write them), runs `claude -p` with `prompt.md` in the sandbox, stops it at 90 minutes less a 2-minute reserve or at $20, stops every process left working in the project and anything on the three ports, and writes `session.json`, whose `result` and `deniedToolCalls` cover every turn of the transcript: a background task that outlives the report wakes the agent again, and each wake-up ends in its own `result` event (`durationMs` and `numTurns` are summed, `costUsd` is the cumulative figure from the last, `firstReport` holds the figures at the first report). It refuses a stale template, one whose sources were committed or edited (tracked or untracked) since `prepare.mjs` ran, and for `--label proxy` also one prepared from uncommitted sources or with uncommitted sources now. `--max-budget-usd` can lower the $20 cap, never raise it. `--prompt smoke-prompt.md --max-budget-usd 1 --label smoke` checks the limits; `--print-args` prints the command line and starts nothing |
| `node examples/bare-redux/eval/grade.mjs <id>` | Copies the session's project to `proxy/grades/<id>/session/` and grades it: `grade.json`, with each check's result and reason, the files the agent changed, and the docs it read, plus `final-report.md`, which holds every `result` event's text in order, the first headed as the report |
| `node examples/bare-redux/eval/grade.mjs --selftest` | Grades the wired `examples/bare-redux` in place; it must score 5/5, or the grader or the example is wrong |
| `node examples/bare-redux/eval/grade.mjs --project <dir>` | Grades any folder in place, for the human trial |
| `node examples/bare-redux/eval/render-task.mjs [--check]` | Writes, or checks, the contract block of `exercise/TASK.md` from `exercise/acceptance.yaml`; run `pnpm --filter @ironbird-examples/bare-redux make:exercise` afterwards to update the copies in `integration-exercise/` |

Session ids are lowercase words and digits with dashes, new every time: `smoke-1`, `proxy-1`.

## Valid and graded

A session is invalid, and not graded as a result, when the setup failed, its init event fails the isolation check (any MCP server, the ironbird skill, a plugin that isn't built in, a user or plugin-namespaced skill, non-empty auto-memory, or a model not matching `^claude-sonnet-`), a tool call named a path outside its project and docs other than a temporary folder, a port was held by a process it didn't start, a process group outlived the bounded reap, the 90-minute deadline passed before teardown finished, or the operator interrupted it. Its time or budget running out does not make it invalid.

The grader runs the five checks on a copy of the project, with the repository's `acceptance.yaml` rather than the session's: `serve`, `commands`, `acceptance`, `bridgeDevOnly`, `releaseBundleClean`, as CHECKLIST.md describes. It starts its own daemon on ports the OS picks and bundles with the project's own `react-native` CLI. The session succeeds when all five pass.

## The human trial

1. `node examples/bare-redux/eval/prepare.mjs --skip-baseline`, then copy `~/.ironbird-eval/proxy/template/` to the participant's machine (or give them the folder), without `node_modules` if it must travel (`npm install` restores it). The docs are the repository's on GitHub, or `~/.ironbird-eval/proxy/docs/` when the participant must work offline.
2. The participant follows TASK.md and fills in RESULTS.md.
3. Score their folder: `node examples/bare-redux/eval/grade.mjs --project <their folder>`, and run CHECKLIST.md by hand alongside it.
4. Record the result, the elapsed time, and the documentation gaps in docs/evals/m5-adapters-and-0.1.md, and tick roadmap M5's first criterion only if every check passed within one day.

## Changing the harness

Change the exercise material in `examples/bare-redux/exercise/`, its single source, never in `integration-exercise/`, and regenerate the copy with `pnpm --filter @ironbird-examples/bare-redux make:exercise`. After any change to this folder, the exercise, the packages, or the docs, commit and run `prepare.mjs` again: a proxy session refuses a template built before its sources last changed. To delete a session folder, first `chmod -R u+w` its `docs/`.

## Troubleshooting

- **`prepare` says the exercise doesn't stand alone or names ironbird**: plan 4's generator left a monorepo-only range, an outside `extends`, a `.gitignore` without `node_modules`, or an ironbird line. Fix the generator, regenerate, commit.
- **`prepare` says the grader judged the un-integrated app wrongly**: read the printed checks; a pass among the first four is a grader bug.
- **`run-session` says the template can't be used**: run `prepare.mjs` again.
- **A port is busy**: `lsof -nP -iTCP:4567 -sTCP:LISTEN` (and 4568, 8081) names the process; stop it by hand.
- **A session is invalid with an `isolation:` reason**: the reason names what the init event showed; fix the setup and run again with a new id.
