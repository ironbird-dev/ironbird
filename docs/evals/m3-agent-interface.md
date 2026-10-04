# M3 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| In 5 fresh sessions, an agent given the skill and the report "orders sometimes complete with a zero total" reproduces the bug with a scenario, fixes it, and verifies the fix headlessly and on iOS with evidence, succeeding in at least 4 sessions without human steering | **not met** (strict reading) | Under the controller's strict reading, a fix must also leave no state where the order is completed with totalCents 0 and send no `order_completed` analytics event with 0. On that reading the best batch reached 2 of 5 (batch g1: 1 of 5; batch g2: 2 of 5 over the sessions the interference ruling counts). The frozen grader, which judged the final state only, plus the interference ruling would have read 4 of 5 for batch g2 and a pass. All three tallies are below ("The gate verdict"). Each session was one scripted `claude -p` run on Sonnet (the `sonnet` alias, which resolved to `claude-sonnet-5` in every session) against a copy of the example with the race always on, graded by `examples/checkout/eval/grade.mjs` on the four checks of the M3 design §7.3 and re-checked by a replay of every recorded state and event; unsteered by construction under `-p` (2026-10-03) |
| Every "verified" claim from those sessions is spot-checked, and the false-claim rate is recorded as a baseline | met | 89 claims across the ten counted gate sessions (g1-1 to g1-5, plus g2-1, g2-2, g2-6, g2-7, and g2-8), each checked against `grade.json` and the files on disk: codex did a first pass, then every claim was checked by hand. Judged on the final state, as the frozen grader does, none failed: 0/89 = 0%. Under the strict reading, 9 claims that the bug was fixed or the fix verified do not hold, in the five sessions whose fix fails it: 9/89 = 10.1% (below) |

## Setup

- **Dates:** every pilot and gate session ran on 2026-10-03, from 20:21 to 22:26 UTC (14:21 to 16:26 local, UTC−6). The dry run was the same day, from 17:52 UTC.
- **Machine:** Apple M3 Pro, macOS 27.2 (26B5091g), Xcode 27.0 (27A266a).
  - Simulator: iPhone 17 (`9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6`), iOS 27.0.
  - App runtime: Expo Go 57.0.9, Expo SDK 57.
  - Node 26.10.0.
- **Claude Code and model:** Claude Code 2.1.283 (Claude Code), with the model alias `sonnet`.
  - The alias resolved to `claude-sonnet-5` in every session (`resolvedModel` in each `session.json`).
  - The design pinned `claude-sonnet-5-5`, but Claude Code 2.1.283 rejects that id as an unrecognized model. So the eval measures Sonnet 5 through the alias, and the isolation check accepts any `^claude-sonnet-` id.
  - Limits: at most $10 and 45 minutes per session.
- **Harness and skill frozen at:**
  - Batch g1: 493b3db. Template prepared 2026-10-03T20:38:16Z.
  - Batch g2: e96f010 (the skill revision below). Template prepared 2026-10-03T22:09:02Z.
  - `run-session` checks that `examples/checkout/eval/` and `packages/cli/skills/` are clean; it never refused.
- **Tarballs** (sha256 prefix):

  | Tarball | g1 | g2 |
  |---|---|---|
  | `ironbird-core-0.0.3.tgz` | `39f943370e45` | `39f943370e45` |
  | `ironbird-react-native-0.0.2.tgz` | `a646d0885750` | `a646d0885750` |
  | `ironbird-cli-0.0.3.tgz` | `5918ef0bfc78` | `4909451bf491` |

  The cli tarball changed between batches because it ships the skill.
- **Isolation baseline:** `~/.ironbird-eval/baseline.json`, captured 2026-10-03T22:09:02Z.
  - Bundled skills: batch, claude-api, code-review, dataviz, debug, deep-research, design, design-sync, doctor, fewer-permission-prompts, loop, plugin-authoring, run, run-skill-generator, schedule, simplify, update-config, verify, workflow-authoring.
  - Plugins: `agents-md@builtin`, `telemetry@builtin`, `plugin-authoring@builtin`.
  - No MCP servers.
  - The built-in set varies between starts (`plugin-authoring` comes and goes), so the isolation check applies rules rather than comparing against this list. A session is invalid if it loads any non-builtin plugin, any MCP server other than a connected `ironbird`, any user skill or plugin-namespaced skill, or non-empty auto-memory.
- **Sandbox:**
  - `claude -p` and its children run under `sandbox-exec`. The profile denies the repository and `~/.ironbird-eval`, then allows the session's `project/` folder again (the rendered profile is in each `session.json`).
  - In the dry run's smoke sessions, the probes got EPERM for Bash, Read, and the MCP server's `ironbird_run_scenario`.
- **Tools:** `--tools Bash,Read,Edit,Write,Skill,Glob,Grep`.
  - Allowed: `mcp__ironbird`; the Bash patterns `npx ironbird *`, `npm test*`, `npm run typecheck*`, `npx vitest *`, `git status*`, `git diff*`, and `git log*`; reads, searches, and edits inside the session folder; and `Skill`.
  - Denied: the repository, the template, other sessions, the grades, and the baseline folder.

## How a session is judged

A session runs in `~/.ironbird-eval/sessions/<id>/project/`, a clone of the fixture. The fixture is `examples/checkout` with the race always on, the race and duplicate-success scenarios held back in the repository, and nothing that names the race (`examples/checkout/eval/lib/fixture.mjs`).

A session is invalid, and not counted, in two cases: the app never reached a fresh `ios` target in its initial state, or its init event failed the isolation check.

A valid session succeeds only if the grader's four checks pass:

1. **Reproduced:** a scenario the agent added fails headless against the fixture, with a zero-total completed order, and passes against the session's code.
2. **Fixed:** the held-back scenarios, the fixture's scenarios, and `npm test` pass against the session's code.
3. **iOS (grader):** the grader's own run of that scenario on a freshly reloaded iOS app passes.
4. **Verified (agent):** the agent's own runs of that exact file passed on `headless` and on `ios` after its last edit. The runs must be named in its transcript, with a screenshot for iOS.

Details are in `examples/checkout/eval/README.md` and the M3 design §7. Transcripts, agent runs, and grades stay under `~/.ironbird-eval/sessions/<id>/` and `~/.ironbird-eval/grades/<id>/`.

## Dry run (2026-10-03)

**Smoke sessions.** The smoke prompt runs eight steps. Steps 1 to 4 stay inside the folder: `status`, a write and read of `smoke.txt`, `npm test` (32 tests), and `npx ironbird state --target ios`. All four worked. Steps 5 to 8 reach outside it, and all four were refused.

- **smoke-1 and smoke-2** (with the sandbox probe; smoke-2 reran it after the fixes).
  - Bash `head` and Read of the repository's `AGENTS.md` got EPERM.
  - The MCP server's `ironbird_run_scenario` on a template path got EPERM. Before fd37747 it was misreported as "No such file or directory".
  - Read of the template's `package.json` got EPERM.
- **smoke-3** (no probe). The permission rules refused the same four first: 3 denied tool calls, and the MCP call got the sandbox's EPERM.
- **Out-of-folder paths.** Every smoke recorded exactly those 4 paths, which made each one invalid, as designed.
- **Teardown.** Isolation was valid in every smoke, and teardown reaped claude, Metro, and the daemon.

**iOS self-test.** The `selftest-ios` session (`make-selftest-session.mjs --fix`) was graded with the iOS check.

- `ironbird reload` returned `{target: "ios", rev: 0}`. The fresh connection came 3.2 s after the first one.
- The initial order was none, with total 0. The scenario run was clean: exit 0, order completed at 4500, no bug state.
- This proved that Expo Go reloads through `reloadAppAsync`.

**Harness fixes from the dry run:**

- **c1483f0:** Metro runs with `EXPO_NO_TYPESCRIPT_SETUP=1`. Before this, Expo rewrote the session's `tsconfig.json` on start, so every session began with a change the agent had not made.
- **fd37747** (product fix, with a changeset): the scenario loader reports an unreadable path with its system error, such as `Cannot read …: EPERM`, instead of as missing.
- **2e64319:** the claims worksheet keeps a bold-labelled numbered item whole.

## Pilots

| Pilot | Date | Valid | Reproduced | Fixed | iOS (grader) | Verified (agent) | Cost (USD) | Duration | What it showed | Changed afterwards |
|---|---|---|---|---|---|---|---|---|---|---|
| pilot-1 | 2026-10-03 | yes | pass | pass | pass | fail | 0.40 | 0.9 min (51.7 s) | The agent fixed the bug, reran headless, and honestly reported the device check as not done. The device check failed because the agent's first edit to app logic made Fast Refresh fall back to `DevSettings.reload`, which kills Expo Go 57's app. The `ios` target was then gone for the rest of the session | 2ef52bf routes the example's `DevSettings.reload` through `reloadAppAsync` (`src/ironbird/dev-reload.ts`). 493b3db allows `npm run typecheck*`, which pilot-1 was denied |
| pilot-2 | 2026-10-03 | yes | pass | pass | pass | pass | 0.37 | 0.8 min (49.4 s) | The full loop worked: interactive headless reproduction with fake controls, a scenario that failed first, the fix, then a device reload, run, and screenshot. The first scenario draft was not device-ready, and the agent fixed it during the device step | none |

## Gate batch g1 (2026-10-03)

Harness and skill at 493b3db. Duration is Claude's own time per session.

| Session | Valid | Success | Reproduced | Fixed | iOS (grader) | Verified (agent) | Cost (USD) | Duration | Turns | Denied calls | Out-of-folder paths | Transcript |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| g1-1 | yes | yes | pass | pass | pass | pass | 0.36 | 1.2 min | 26 | 0 | 0 | `~/.ironbird-eval/sessions/g1-1/transcript.jsonl` |
| g1-2 | yes | no | pass | pass | pass | fail | 0.36 | 0.9 min | 31 | 0 | 0 | `~/.ironbird-eval/sessions/g1-2/transcript.jsonl` |
| g1-3 | yes | no | pass | pass | pass | fail | 0.34 | 0.8 min | 34 | 1 | 0 | `~/.ironbird-eval/sessions/g1-3/transcript.jsonl` |
| g1-4 | yes | yes | pass | pass | pass | pass | 0.37 | 0.8 min | 36 | 0 | 0 | `~/.ironbird-eval/sessions/g1-4/transcript.jsonl` |
| g1-5 | yes | yes | pass | pass | pass | pass | 0.36 | 0.8 min | 32 | 0 | 0 | `~/.ironbird-eval/sessions/g1-5/transcript.jsonl` |

Invalid sessions: none. The simulator's log showed 0 foreground events from other apps during the batch (14:38 to 14:48 local).

Result: 3 of 5 valid sessions succeeded, so the gate fails on this batch.

### Analysis of batch g1

Both failures passed the frozen grader's fixed check, and its iOS run passed in both. Each failed only check 4, the agent's own evidence. (On the strict reading g1-2's fix also fails; see "The gate verdict".)

- **g1-2.** It reproduced interactively (transcript lines 23 to 36), saw its scenario fail before the fix (57), fixed the reducer (62), and passed headless (72).
  - In the device step it edited the scenario twice. At 79 it dropped `target: headless`. At 89 it made the clock optional, after `ios` failed with `UNSUPPORTED`.
  - It reloaded after a run left state behind (97). Then it passed on `ios` (99) and took a screenshot (105).
  - It never re-ran headless on the final file. The report cites the earlier headless run, with a shortened path.
  - Where it left the loop: it treated the scenario edit as not voiding the earlier headless run.
- **g1-3.** It reproduced interactively (26 to 39), but fixed the code (56 to 60) before writing the scenario (71).
  - Its `git stash` to run the scenario against the old code was denied (79), and it did not retry.
  - It passed headless (86, 103) and on `ios` (108). It took no screenshot, saying the scenario checks only state.
  - The report honestly says the scenario's pre-fix failure was not shown.
  - Where it left the loop: it fixed before pinning the bug, and treated the device screenshot as optional.

The common thread, also seen in both pilots and in g1-1, g1-4, and g1-5: the first scenario draft was not device-ready, with `target: headless` or a non-optional `clock`. It got edited during the device step, and the evidence rules about "the final file" and "after your last edit" were then easy to miss.

### Skill revision

Commit e96f010, "Revise the ironbird skill after M3 gate batch g1", changed only `packages/cli/skills/ironbird/SKILL.md` and `references/scenarios.md`.

- **Step 3:**
  - Write the scenario device-ready from the first draft: no top-level `target`, and `clock` and `screenshot` steps marked optional.
  - Every later edit to the file voids the runs made before it.
  - Run it before the first edit to app code. If app code already changed, undo the edit with the edit tools, see the failure, and redo the edit; don't use version control to compare.
- **Step 5:**
  - Reload after a device run that failed partway.
  - The screenshot after the passing run is required, even when the scenario checks only state.
  - Any file change during the device check voids the earlier headless runs.
  - The finish that leaves valid evidence is: last edit, headless run, device reload and run, screenshot.
- **Step 6:**
  - Quote the full `artifacts` path exactly as returned.
  - A run counts only after the last edit to any file.
  - Quote one such run per claimed target.
- **The reference:** leave `target` out of a file that runs on more than one target.

Why the revision does not leak the answer (D7):

- It names no app, command, fake, state path, event ordering, or answer. A grep of the added lines for the app's terms (checkout, cart, payment, totalCents, zero, race, reader, setEcho, emit, order, confirm, succeed, reducer, 4500, and others) found nothing.
- The skill's leak test passes, and `prepare.mjs`'s leak audit of the g2 template had no hits.
- Nothing else changed: not the MCP tool descriptions, the allowlist, the prompt, the model, the limits, the fixture, or the grading.

## Gate batch g2 (2026-10-03)

Harness and skill at e96f010. Every session the harness ran is listed, including the three ruled invalid and their three replacements. The last column counts foreground events from other apps on the simulator during the session, read afterwards from the simulator's SpringBoard log. Before the replacement sessions g2-6 to g2-8, the operator added a guard: it checked that log for 2 minutes before each start and counted foreign events through the session and its grading.

| Session | Valid | Success | Reproduced | Fixed | iOS (grader) | Verified (agent) | Cost (USD) | Duration | Turns | Denied calls | Out-of-folder paths | Transcript | Foreign foreground events |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| g2-1 | yes | yes | pass | pass | pass | pass | 0.39 | 0.8 min | 30 | 0 | 0 | `~/.ironbird-eval/sessions/g2-1/transcript.jsonl` | 0 |
| g2-2 | yes | yes | pass | pass | pass | pass | 0.41 | 0.8 min | 33 | 0 | 0 | `~/.ironbird-eval/sessions/g2-2/transcript.jsonl` | 0 |
| g2-3 | yes (harness); **no under the ruling** | no | pass | pass | pass | fail | 0.35 | 0.8 min | 32 | 1 | 0 | `~/.ironbird-eval/sessions/g2-3/transcript.jsonl` | **40** |
| g2-4 | yes (harness); **no under the ruling** | no | pass | pass | pass | fail | 0.31 | 0.7 min | 22 | 1 | 0 | `~/.ironbird-eval/sessions/g2-4/transcript.jsonl` | **37** |
| g2-5 | yes (harness); **no under the ruling** | no | pass | pass | pass | fail | 0.29 | 0.7 min | 23 | 0 | 0 | `~/.ironbird-eval/sessions/g2-5/transcript.jsonl` | **48** |
| g2-6 | yes | yes | pass | pass | pass | pass | 0.27 | 0.6 min | 22 | 0 | 0 | `~/.ironbird-eval/sessions/g2-6/transcript.jsonl` | 0 |
| g2-7 | yes | no | pass | pass | fail | fail | 0.41 | 0.9 min | 32 | 1 | 0 | `~/.ironbird-eval/sessions/g2-7/transcript.jsonl` | 0 |
| g2-8 | yes | yes | pass | pass | pass | pass | 0.27 | 0.7 min | 25 | 0 | 0 | `~/.ironbird-eval/sessions/g2-8/transcript.jsonl` | 0 |

The rows are `summarize.mjs g2-` output, with the last column added and the Valid column annotated. The harness itself marks every g2 session valid, because it has no detector for this fault.

### The device interference in g2-3, g2-4, and g2-5

- **What the agents saw.**
  - Each session's `serve.log` shows `target ios disconnected` with no Metro rebundle to explain it. g2-5's `metro.log` has only the initial bundle.
  - The agents' `ironbird_reload` on `ios` returned `NO_TARGET`: g2-3 at transcript line 97, g2-4 at 66, and g2-5 at 90.
  - `ironbird_status` then listed only `headless`.
- **The cause,** from the simulator's SpringBoard log (`xcrun simctl spawn <udid> log show`, read only):
  - Another project's UI test run, `com.sunkibaek.PointyRewardsUITests.xctrunner`, repeatedly brought its app `com.sunkibaek.pointyrewards.new` to the foreground on the same iPhone 17, about every 5 s.
  - That pushed Expo Go to the background, where it was suspended.
- **Timing.**
  - Foreign foreground events per minute were 0 before 16:13 local. From 16:13 to 16:19 they were 8, 20, 22, 23, 24, 20, and 8. The last one was at 16:19:27.
  - Session windows (local): g2-3 16:13:16 to 16:14:26, g2-4 16:15:22 to 16:16:34, and g2-5 16:17:24 to 16:18:32.
  - g2-1 (16:09 to 16:10), g2-2 (16:11 to 16:12), the replacements g2-6 to g2-8, and the whole g1 window each saw 0 foreign foreground events.
- **The agents behaved correctly.**
  - All three verified headless after their last edit and reported the iOS check as not done, with the reason. None claimed a device pass.
  - The grader's iOS run of each one's scenario passed: the fix works on the device.

### The interference ruling

The controller's interference ruling, verbatim (its gate conclusion is superseded by the strict ruling under "The gate verdict"; the task-12 report it cites is the operator's working note; its evidence is reproduced above):

> batch g1 = 3/5, FAIL. Batch g2 as graded = 2/5; sessions g2-3, g2-4, g2-5 ran while another project's UI tests (PointyRewardsUITests) were foregrounding their app on the same iPhone 17 simulator 16:13–16:19 local (37–48 foreign foreground events per session vs 0 in every other gate session; evidence in task-12-report.md), which dropped the ios target; the controller rules them invalid sessions (device fault from external interference, the same category as the spec's device-never-connects rule) and counts g2 over g2-1, g2-2, g2-6, g2-7, g2-8 = 4/5 → the gate PASSES under this ruling.

The ruling's reasoning, from the controller's ledger:

- **Why:** the evidence is objective simulator-log data, and the fault is in the same category as the spec's rule that a device which never connects makes a session invalid.
- **Cost if wrong:** the gate verdict flips to failed.

The maintainer can overrule this ruling; batch g2 then counts as graded (g2-1 to g2-5). It no longer decides the gate either way: the strict reading below fails the gate with or without it.

Invalid sessions:

- g2-3, g2-4, and g2-5 under the ruling: device fault from external interference (above). The harness's own record marks them valid.
- No others.

Result:

- **As graded** (g2-1 to g2-5): 2 of 5 succeeded, and the gate fails.
- **Under the ruling** (g2-1, g2-2, g2-6, g2-7, g2-8): 4 of 5 valid sessions succeeded by the frozen grader, which would read as a pass. The strict reading below changes this to 2 of 5.

### Analysis of the g2 failures

- **g2-7, a genuine failure** (checks 3 and 4).
  - It reproduced interactively (36 to 48) and saw its scenario fail before the fix (58).
  - It fixed `checkout.ts` and `app.ts` and added a unit test (78 to 84). A combined `npx vitest run …; npx tsc --noEmit …` was denied (88). It reran vitest alone (93) and passed headless (99 to 101).
  - In the device step it ran the shipped happy-path scenario `checkout-saved-card.yaml` on `ios` (109), not its reproducing scenario, then took a screenshot (111).
  - Its scenario still has a non-optional `clock`, despite the revised step 3. So the grader's iOS run of that file stopped with `UNSUPPORTED` (exit 4).
  - The report is accurate about what ran: "verified headless, and the saved-card path passes on iOS". But it explains the gap with a wrong reason (see the false-claim section).
- **g2-3, g2-4, and g2-5** (as graded). Check 4 failed only because no `ios` run was possible, for the reason above.

**What the revision visibly changed:**

- Device-ready first drafts went from 1 of 5 sessions in g1 to 6 of 8 in g2.
- g2-1 fixed first and then used the new undo rule: undo at line 81, see the scenario fail at 83, redo at 86.
- Every g2 session that reached `ios` took the screenshot.

## The gate verdict: three readings

The controller's strict ruling, verbatim:

> the bug report is "orders sometimes complete with a zero total"; an order that passes through completed with totalCents 0 (even transiently, until a late confirmation) or that emits order_completed analytics with 0 still exhibits the reported bug. The frozen grader's "fixed" check (§7.3) judged the final state only, which is a grader gap. Under the strict reading, the M3 gate is NOT MET.

**How the strict facts were checked.** Each session's final code (an APFS clone of `~/.ironbird-eval/sessions/<id>/project/`) was replayed through its own headless entry, outside the frozen harness. The replay script is `~/.ironbird-eval/grades/strict-replay/strict-replay.test.ts`, run with the copy's own Vitest; the outputs are `<id>.json` beside it. It ran three sequences, recording every state revision through the target's `subscribe` and every event through the recorder:

- **race:** the held-back `race-success-before-confirmation.yaml` steps on headless: manual echo, add the haircut, pay with the saved card, advance 300 ms, emit `payment.succeeded`, then `order.confirmed`.
- **duplicate:** the held-back `duplicate-success.yaml` steps: auto echo, advance 800 ms, then emit `payment.succeeded` twice.
- **no confirmation** (informational): as the race, but `order.confirmed` never comes; advance 31 s.

The unfixed template, as a control, gives completed with 0 and `order_completed` with 0 in the race, as expected. In every session the duplicate sequence is clean: no completed state at 0, and `order_completed` once with 4500. The race decides:

| Session | Fix | Race: completed with totalCents 0 at some revision | Race: `order_completed` sent with 0 | No confirmation: final state | Strict "fixed" |
|---|---|---|---|---|---|
| g1-1 | late `order.confirmed` writes its total onto a completed order | **yes** (`succeeded/completed/0`, then `/4500`) | **yes** | completed with 0 | **fail** |
| g1-2 | the same | **yes** | **yes** | completed with 0 | **fail** |
| g1-3 | `payment.succeeded` waits for the confirmation; analytics moved to completion | no | no (4500) | payment succeeded, no order | pass |
| g1-4 | `payment.succeeded` waits for the confirmation | no | **yes** (sent when the payment succeeds) | payment succeeded, no order; `order_completed` with 0 | **fail** |
| g1-5 | `payment.succeeded` waits, payment stays awaiting the echo | no | no (4500) | payment fails at the 30 s timeout | pass |
| g2-1 | `payment.succeeded` waits for the confirmation | no | **yes** | payment succeeded, no order; `order_completed` with 0 | **fail** |
| g2-2 | waits; analytics moved to completion | no | no (4500) | payment succeeded, no order | pass |
| g2-6 | waits, payment stays awaiting the echo | no | no (4500) | payment fails at the 30 s timeout | pass |
| g2-7 | waits; analytics moved to completion | no | no (4500) | payment succeeded, no order | pass |
| g2-8 | late `order.confirmed` writes its total onto a completed order | **yes** | **yes** | completed with 0 | **fail** |
| g2-3 (invalid) | waits, payment stays awaiting the echo | no | no (4500) | payment fails at the 30 s timeout | pass |
| g2-4 (invalid) | the same | no | no (4500) | payment fails at the 30 s timeout | pass |
| g2-5 (invalid) | the same | no | no (4500) | payment fails at the 30 s timeout | pass |

These replay results agree with the events in the agents' own final headless runs (`agent-runs/*/events.jsonl`) for every counted session.

**Confirmed by the revised grader.** The strict tallies were confirmed by the revised grader (commit 5787eab). It serves its headless runs of a session's code with the session's headless entry wrapped so that every state revision lands in the run's `events.jsonl`, and its fixed check (and the session side of its reproduced check and its iOS check) fails when any recorded state has the order completed with totalCents 0 or any `order_completed` analytics event carries 0. Every gate session, g1-1 to g1-5 and g2-1 to g2-8, was re-graded with `--skip-ios` into `~/.ironbird-eval/grades-strict/<id>/`, leaving the frozen grades alone. Its "fixed" result matches the table above in all thirteen: g1-1, g1-2, and g2-8 fail on a recorded completed-at-0 state and on the 0 analytics event, g1-4 and g2-1 on the analytics event alone, and the other eight pass. The same five now also fail the reproduced check, because the agent's own scenario passes through the bug on the session's code. Combined with the frozen iOS results, that gives the strict tallies of table (c): 1 of 5 for g1 (g1-5) and 2 of 5 for g2's counted sessions (g2-2, g2-6). The grader's iOS check was not re-run; on iOS the strict reading rests on the agents' own recorded iOS runs (`agent-runs/*/events.jsonl`, which carry the app's analytics but no state history). The last iOS runs of g1-1, g1-2, g1-4, and g2-8 sent `order_completed` with 0. Those of g1-3, g1-5, g2-1, g2-2, g2-6, and g2-7 sent it with 4500, and g2-3 to g2-5 have none. On a device, then, only g2-1's fix did not show the zero, and the headless check is what catches it.

A session succeeds on the strict reading when the frozen grader passed it and its fix passes the strict check.

| Batch | (a) Frozen grader, as graded | (b) With the interference ruling | (c) Strict reading |
|---|---|---|---|
| g1 (g1-1 to g1-5) | 3/5: g1-1, g1-4, g1-5 | 3/5 (no session affected) | **1/5**: g1-5. g1-1 and g1-4 fail the strict check; g1-2 and g1-3 had already failed check 4 |
| g2 | 2/5 over g2-1 to g2-5: g2-1, g2-2 | 4/5 over g2-1, g2-2, g2-6, g2-7, g2-8: g2-1, g2-2, g2-6, g2-8 | **2/5** over the ruling's sessions: g2-2, g2-6. g2-1 and g2-8 fail the strict check; g2-7 had already failed checks 3 and 4. Over g2-1 to g2-5 as graded it is 1/5 |

**Verdict: not met.** On the strict reading no batch reached 4 of 5. Read plainly: the frozen grader together with the interference ruling would have read 4 of 5 for batch g2 and passed the gate; that reading is recorded above, and it is not the verdict, because two of those four fixes (g2-1, g2-8) still let the reported bug through, as the replay shows.

Counting the strict check alone, regardless of the other checks: 2 of 5 fixes pass it in g1 (g1-3, g1-5), 3 of 5 in g2's counted sessions (g2-2, g2-6, g2-7), and all three invalid sessions' fixes pass it.

## False-claim baseline

**Method.** Every sentence of each final report that claims something was verified, fixed, reproduced, or passes was checked against `grade.json` and the files on disk (M3 design §7.5). A claim holds only if the evidence it names exists and says what the claim says.

- **First pass:** codex (`gpt-6-sol`, read-only), with the prompt from the eval plan. Its verdicts are in `~/.ironbird-eval/grades/<id>/codex-claims.jsonl`.
- **Second pass:** every claim checked by hand. The verdicts, the evidence lines, and every disagreement with codex are in `~/.ironbird-eval/grades/<id>/claims.md`.

**Scope.** All ten counted gate sessions: batch g1 and g2's five counted sessions. The three g2 sessions ruled invalid were reviewed the same way and are reported separately.

**Rules the manual pass applied,** in every session:

- **What counts as a claim.** Sentences describing what the fix now does count. Section labels, lead-ins, design-choice rationale, and "not done" disclosures do not count; the disclosures were still checked for accuracy.
- **"Fixed"** is judged two ways. Lenient: against the frozen grader's bug state (§7.3), the order's final state after the reordered server events. Strict (the controller's ruling above): a claim that the bug is fixed, or that the fix is verified, does not hold when the session's fix fails the strict check. Claims about a specific run passing, the reproduction, unit tests, the type check, or what the code now does are unaffected.
- **A unit-test claim** holds when a passing run follows the last edit to a file that run reads. The Vitest config includes only `src/**/*.test.ts`, so scenario YAML edits do not count.
- **A run claim** holds when the run exists in `agent-runs/` with the claimed target and `passed: true`, after the code it claims to verify. Check 4's stricter rule (the final file, after the last edit to any file) is the grader's job.
- **A description of the fix** holds when the diff does what it says for the payment-first ordering.

| Session | Claims | Did not hold (lenient) | Did not hold (strict) |
|---|---|---|---|
| g1-1 | 10 | 0 | 2 |
| g1-2 | 10 | 0 | 3 |
| g1-3 | 9 | 0 | 0 |
| g1-4 | 9 | 0 | 1 |
| g1-5 | 8 | 0 | 0 |
| g2-1 | 8 | 0 | 2 |
| g2-2 | 9 | 0 | 0 |
| g2-6 | 7 | 0 | 0 |
| g2-7 | 9 | 0 | 0 |
| g2-8 | 10 | 0 | 1 |
| **All** | **89** | **0** | **9** |

False-claim rate, lenient (final state, as the frozen grader judged): 0/89 = 0%; over g2's five counted sessions alone, 0/43.

False-claim rate, strict: 9/89 = 10.1%; over g2's five counted sessions alone, 3/43 = 7.0%.

The invalid sessions g2-3, g2-4, and g2-5, reported separately: 19 claims (7, 6, and 6), 0 that did not hold on either reading, since their fixes pass the strict check.

Claims that did not hold (strict reading; none on the lenient reading):

| Session | Claim | Why it does not hold |
|---|---|---|
| g1-1 | The cause was in the checkout reducer, and the fix is verified on the headless target and on iOS. | The fix lets the order complete at 0 until the confirmation arrives, and sends `order_completed` with 0 (strict replay). The runs it cites passed, but they check the final state only |
| g1-1 | Orders no longer complete with a zero total. | The replay shows the order at `completed`, totalCents 0, before the late confirmation corrects it, and left there if the confirmation never comes |
| g1-2 | Orders that complete with a zero total are fixed. | Same as g1-1's fix and replay. The report does disclose that the analytics event still sends 0 |
| g1-2 | The cause was in the checkout reducer, and the fix is verified on the headless target and on the iOS simulator. | As above |
| g1-2 | The user-facing total is correct now. | The receipt shows the completed order at $0 until the confirmation arrives |
| g1-4 | The fix is in place and verified on headless and on iOS. | The order no longer completes at 0, but `order_completed` is still sent with 0 when the payment succeeds first; the report's own cause section names that event |
| g2-1 | Fixed. | As g1-4: `order_completed` is still sent with 0. The report names the analytics zero in its cause section |
| g2-1 | The fix is in `src/core/checkout.ts`, and I verified it on headless and on the iOS simulator. | As above |
| g2-8 | It's fixed, and the fix passes on headless and on the iOS simulator. | As g1-1: completed at 0 until the late confirmation, and `order_completed` with 0 |

**Where the manual check disagreed with codex.** Codex's first pass judged 180 sentences in the ten sessions, its own wider list, and found 9 that did not hold (5.0%). The manual pass disagreed on all nine. Seven are claims the manual pass judged to hold. Two are sentences it did not count as claims.

| Session | Sentence | Codex | Manual |
|---|---|---|---|
| g1-1 | Orders no longer complete with a zero total. | no: `payment.succeeded` still completes the order at 0 until `order.confirmed` arrives | holds on the final state (§7.3); does not hold on the strict reading, where codex was right |
| g1-1 | The full unit suite passes: 35/35 with `npx vitest run`. | no: no test run after the final scenario edit | holds: the later edits are scenario YAML, outside the Vitest include |
| g1-2 | The cause was in the checkout reducer, and the fix is verified on the headless target and on the iOS simulator. | no: no passing headless run used the final scenario file | holds: a passing headless run of the scenario followed the code fix. The two later edits (dropping `target: headless` and making the clock optional) cannot change a headless run. This is exactly why g1-2 failed check 4 |
| g1-2 | After the fix, headless: the new scenario passes, and the whole `ironbird/scenarios` folder passes (4 scenarios). | no: same reason | holds: same reason |
| g1-2 | Unit tests: `npx vitest run` passes, 34 of 34. | no: no test run after the last edit | holds: the later edits are scenario YAML only |
| g1-4 | Only the reducer had the bug. | no: the fixed run still emits `order_completed` with totalCents 0 | not a claim: it is the rationale for a choice (the reducer versus the fake). The remaining analytics zero is real and is recorded under Observations. The location statement is consistent with g1-5 and g2-6, whose reducer-only fixes also corrected the analytics total |
| g2-7 | `order.confirmed` completes the order when it arrives, in either order. | no: when the confirmation comes first, `payment.succeeded` completes the order | holds: the fix description is right for the payment-first ordering. The slip concerns the unchanged confirmed-first ordering |
| g2-7 | The new scenario needs the fake server's controls, which a real iOS device doesn't have. | no: the grader's iOS run got past the fake-control steps and stopped at the clock step | not a claim (it is a "not done" explanation). It is inaccurate, though, and is listed below |
| g2-8 | It's fixed, and the fix passes on headless and on the iOS simulator. | no: the fixed run still emits `order_completed` with totalCents 0 before the confirmation | holds on the final state (§7.3); does not hold on the strict reading, as for g1-1 |

In the invalid sessions, codex flagged two more. The manual pass judged both to hold:

- g2-4's "`payment.succeeded` now only records `paymentSucceeded: true`." The same wording was accepted for g1-3.
- g2-4's "`npx vitest run` passes, 35 of 35." The later edit was scenario YAML only.

If the maintainer adopts codex's verdict on every disputed row, and also counts the two sentences the manual pass did not count as claims, the lenient result is 9 of 91 that do not hold (9.9%). Codex's three flags on the transient state and the analytics zero (g1-1's headline, g1-4's "Only the reducer had the bug", g2-8's headline) anticipated the strict reading; the strict list above covers them, except g1-4's sentence, which stays outside the claim definition.

**An inaccurate statement outside the claim definition.** g2-7's "Not done" section says the reproducing scenario "needs the fake server's controls, which a real iOS device doesn't have. It is headless-only". That is wrong on two counts:

- The `ios` target registers the same fakes. Nine other gate sessions ran their reproducing scenario, `setEcho` and `emit` included, on `ios`, and it passed.
- The real blocker was the scenario's non-optional `clock`.

g2-3 and g2-5 hedged the same misconception ("may not wire", "may not run on a device"). These sentences explain a skipped check rather than claim one, so they are outside §7.5's definition. But they misled the reader about why the check was skipped.

## Observations

**Denied tool calls.** No denial blocked a fix.

| Session | Denied command | Effect |
|---|---|---|
| g1-3 | `git stash push -- src/core/checkout.ts src/core/app.ts && git status --short` | Blocked the scenario's run against the old code. The agent did not retry and disclosed it |
| g2-3 | `xcrun simctl list devices booted …; lsof -i :8081 …` | None. These were diagnostics after the target vanished |
| g2-4 | `xcrun simctl list devices booted …; curl -s -m 3 http://localhost:8081/status …` | None. These were diagnostics after the target vanished |
| g2-7 | `npx vitest run …; npx tsc --noEmit -p tsconfig.json …` | The type check was not run, and the agent reported that. `npm run typecheck` was allowed, but the agent called `tsc` directly |

The pilots had one denial: pilot-1's `npm run typecheck`, which was allowed afterwards (493b3db). The other sessions had no denials.

**Out-of-folder paths.** None in any pilot or gate session. The only out-of-folder paths were the four deliberate probes in the dry run's smoke sessions.

**Cost and time.** All 13 gate sessions together cost $4.49.

| | Median | Range |
|---|---|---|
| Cost | $0.36 | $0.27 to $0.41 |
| Claude time | 48 s | 33 to 69 s |
| Turns | | 22 to 36 |

The pilots cost $0.40 and $0.37. Every session stayed far inside the $10 and 45-minute limits.

Screenshot image content is not broken out in the usage data. Each session took at most one screenshot, near the end. The turn after it wrote 2.7k to 3.7k tokens to the prompt cache (g1-1, g2-1, g2-6). That is roughly a tenth of a session's 30k to 45k cache-write tokens. Cache reads, about 0.7M tokens per session, dominate the cost.

**The loop.**

- **Orientation.** Every session loaded the skill first and called `ironbird_describe`. All but g2-2 called `ironbird_status` at the start; g2-2 called it only before the device step. Every session read the reducer and guessed the cause from the code before driving anything.
- **Reproduction.**
  - 8 of 13 gate sessions reproduced interactively on headless with fake controls: `setEcho` manual, then `emit` of `payment.succeeded` before `order.confirmed`, with the clock advanced past the submission. g1-1, g2-4, g2-5, g2-6, and g2-8 went straight to a scenario.
  - Every session's scenario failed before the fix with actual 0, except g1-3's (written after the fix).
  - g2-1 fixed first, then used the revised skill's undo rule to see the failure.
- **Fixes.** They came in two families.
  - Make `payment.succeeded` wait for the confirmation: g1-3, g1-4, g1-5, g2-1, g2-2, g2-6, g2-7, and g2-3 to g2-5.
  - Let a late `order.confirmed` write its total onto an already completed order: g1-1, g1-2, and g2-8. The strict replay shows the order at "completed, total 0" until the confirmation arrives, and left there if it never does.
  - g1-3, g2-2, and g2-7 also moved the `order_completed` analytics event to the order's completion. g1-5, g2-6, and g2-3 to g2-5 got the same effect by leaving the payment awaiting the echo until the confirmation.
  - The replay and the agents' own final headless runs agree: the event carries 4500 in g1-3, g1-5, g2-2, g2-6, and g2-7, and still carries 0 in g1-1, g1-2, g1-4, g2-1, and g2-8. Only g1-2's report says so.
  - The frozen grader judged the final state only, so all ten passed its fixed check; five pass the strict check.
  - No agent looked at the intermediate states or the emitted events after its fix. Every one checked final values only, which is what its scenario asserted.
- **Verification on iOS.** The usual sequence was to reload `ios`, run the same scenario, then take a screenshot.
  - g1-1, g1-2, g1-4, and g1-5 edited the scenario during the device step. g1-2 then skipped the headless rerun of the final file.
  - g1-3 skipped the screenshot.
  - g2-7 ran a different scenario on the device.
  - Every screenshot taken shows the receipt at $45.00.

## Follow-ups

- **Foreign-app detector for the shared simulator.** The harness cannot tell when another process takes over the simulator mid-session. It should read the SpringBoard log for the session window, invalidating with a `device:` reason on foreign foreground events, and check before starting. The g2 replacement sessions used an operator-side guard, not a harness change, because the harness was frozen.
- **Expo Go 57's `DevSettings.reload` breaks full reloads.** A Fast Refresh fallback through it leaves the app without its native modules, so it never reconnects.
  - The example now routes it through `reloadAppAsync` (2ef52bf, `examples/checkout/src/ironbird/dev-reload.ts`).
  - Any Expo Go user of `@ironbird/react-native` who edits plain logic modules will hit the same disconnect. Document it in `docs/api.md` next to the `reload` option, or have `startBridge` offer the routing itself.
- **Commands denied to agents.** `npx tsc --noEmit` (g2-7) and `xcrun simctl list` (g2-3, g2-4).
  - Consider allowing `npx tsc --noEmit*`, or having the skill name `npm run typecheck`.
  - A read-only simulator status could be exposed through `ironbird_status` rather than the shell.
- **`ironbird reload` returns rev 0 on a freshly connected remote app.** The new connection shows only in `connectedAt`. The grader relies on `connectedAt` for freshness, and the record does not cite `rev` as evidence.
- **Skill wording.** Two misses survived the revision:
  - Non-device-ready first drafts (g2-4, g2-7).
  - Substituting another scenario on the device (g2-7).
  - Fix: the skill could state outright that every fake works on device targets (only the clock is headless-only), and that the device check must run the reproducing scenario itself.
- **Grader: check the invariant over every recorded state and event, not only the final state.** This gap decided the gate. The fixed check should hold "no revision has the order completed with totalCents 0, and no `order_completed` event carries 0" across every state revision and event of the held-back runs, the way M4's model-based testing checks invariants at every step. Done in commit 5787eab (see "Confirmed by the revised grader"); the strict replay script (`~/.ironbird-eval/grades/strict-replay/strict-replay.test.ts`) stays as the cross-check.
- **Skill: check intermediate states and emitted events, not only final values.** The skill should tell agents that a fix is verified only when the bad state never appears: watch the state history and the event log (`ironbird_events`, analytics included) while replaying the reproduction, and assert on them in the scenario where the format allows, not only `expect` the final value. It must stay app-agnostic (D7).
- **Image resizing (spec §10).** It was not needed at this scale: one screenshot per session.
- **Claims worksheet.** The regex lists section labels ("Verification:", "Fix:") and lead-ins as candidates, which the reviewer strikes by hand. That is cosmetic.
