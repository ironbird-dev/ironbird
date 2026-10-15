# M5 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| A developer other than the author wires ironbird into a copy of `examples/bare-redux` that doesn't include it yet, using only the docs, in ≤ 1 day | **pending human trial** | Not measured here: it needs a human, and it is the maintainer's go/no-go for releasing 0.1.0 (M5 design §9). The material is `examples/bare-redux/integration-exercise/`: TASK.md, CHECKLIST.md, RESULTS.md, and acceptance.yaml. **Proxy, which does not tick the criterion:** the proxy produced no valid session. Three sandboxed `claude -p` sessions on Sonnet (`claude-sonnet-5-5`) were given the same task sheet and only the published docs, and each is invalid because it attempted one shell command naming the session folder, outside its project; permissions denied the command each time, so it was never performed. Graded for the record only, as unofficial supporting evidence, each scored 5/5 on the checklist, after 1.7 to 1.9 minutes of work and $0.41 to $0.46 per session (2026-10-14 and 2026-10-15; "Integration proxy" below) |
| CI passes on the two most recent React Native minor versions and the current Expo SDK | met | The `compat` job on 761a502 (https://github.com/ironbird-dev/ironbird/actions/runs/38742986829): React Native 0.86.3 and 0.87.1, each in a freshly generated bare project, and Expo SDK 57 with React Native 0.86.3 through the checkout example; all three legs passed. This is JavaScript-bundle evidence: the packages install, typecheck, bundle, and stay out of production bundles on each version. Native-build evidence is the hand-run iOS build below |
| Zod 3 support question (Q8) closed, and the migration note published if support is dropped | met | Q8 closed by M5 design D9 (2026-10-04): Zod 3 is dropped, `zod ^4.2.0` stays the peer range of core and both adapters, `defineCommands` rejects any other schema with `INVALID_CONFIG`, and [docs/migrating-from-zod-3.md](../migrating-from-zod-3.md) is published |

## Integration proxy (2026-10-14 to 2026-10-15)

The proxy is one agent session standing in for the human trial, so the trial starts from a measured signal and a working instrument (M5 design D11). It is not the criterion: an agent that reads every doc in minutes is not a developer meeting ironbird for a day.

No proxy session was valid. The plan runs at most three sessions and measures the first valid one; all three were invalid for the same reason (below), so there is no measured proxy result. The grades below are for the record only.

### Setup

- **Machine:** Apple M3 Pro, macOS 27.2, Node v26.11.1 (the local Node when this record was written; the session record doesn't store the Node version).
- **Claude Code and model:** Claude Code 2.1.296, `--model sonnet`, which resolved to `claude-sonnet-5-5`. The plan expected Claude Code 2.1.283 and `claude-sonnet-5`; the alias and the installed version had moved by the time the sessions ran, and the baseline captured at prepare time recorded the versions above. Limits: 90 minutes and $20 for the whole session.
- **Harness:** `examples/bare-redux/eval/`, reusing `examples/checkout/eval/lib/` (the sandbox, the isolation check in its `ironbird: 'absent'` mode, the transcript tools). Template prepared 2026-10-15T13:27:53Z from 761a502, with no uncommitted sources. `proxy-1` ran from an earlier template, prepared from ce7a9c5 before the final fix wave; that template's `prepare.json` was replaced by the 761a502 one.
- **Tarballs**, repacked at 0.1.0 (sha256 prefix, 761a502 template):

  | Tarball | sha256 |
  |---|---|
  | `ironbird-core-0.1.0.tgz` | `c9a59e1dea39` |
  | `ironbird-react-native-0.1.0.tgz` | `e28ed98dc6d9` |
  | `ironbird-redux-0.1.0.tgz` | `3993e3ceee6d` |
  | `ironbird-cli-0.1.0.tgz` | `630daa6a5f58` |

- **Docs given:** 25 files: the README, the package READMEs, and `docs/` without `docs/superpowers/` and `docs/evals/`. They name bare-redux in 5 lines, none showing its wiring: `docs/api.md:462` (bare-redux's `metro.config.js` carries the zod setting), `docs/guides/getting-started.md:11` (a link to the example), `docs/releasing.md:41` (the human trial's folder), and `docs/roadmap.md:117` and `:124` (the M5 scope and criterion).
- **Isolation:** `claude -p` under `sandbox-exec`, with the repository and `~/.ironbird-eval` denied and the session's `project/` and read-only `docs/` allowed; `--setting-sources project`; no MCP server and no ironbird skill (checked on the init event; every session's isolation check was valid); tools `Bash,Read,Edit,Write,Glob,Grep`, Bash limited to `npm install*`, `npm test*`, `npm run *`, `npx ironbird *`, `npx react-native bundle *`, `npx tsc*`, `git status|diff|log*`, `ls*`, `mkdir *`. `--permission-prompts none` denies anything else automatically.
- **Grader self-checks:** the wired `examples/bare-redux` scored 5/5 (`grade.mjs --selftest`, rerun on 761a502 for this record); the un-integrated template failed checks 1 to 4 and passed check 5, as it must (`prepare.json`'s check on the 761a502 template).

### Smoke (2026-10-14 and 2026-10-15)

`smoke-1` (2026-10-14 20:15 MDT, ce7a9c5) and `smoke-2` (2026-10-15 07:27 MDT, 761a502) behaved the same: steps 1 (`ls`), 2 (read a doc), and 4 (write and read in the project) worked; step 3 (read the repository's AGENTS.md) was refused with "File is in a directory that is denied by your permission settings.", and step 5 (write into the docs) was refused with "Permission for this tool use was denied. It requires approval, and this session has no approval surface". Invalid by design, for naming the repository. Each took about 10 seconds and $0.03.

### The sessions

Times are wall clock. Each agent reported its work after under 2 minutes, but it had started `ironbird serve` as a Claude Code background task and couldn't stop it (`pkill` isn't allowed), so the session stayed open until Claude Code killed that task about 9.5 minutes later. The agent then woke for one short final turn, so each transcript has two `result` events. The turns and denied calls below add up both; the cost is the last event's `total_cost_usd`, which is the session total.

| Session | Head | Valid | Ended by | Duration | Turns | Cost | Denied tool calls | Docs read |
|---|---|---|---|---|---|---|---|---|
| `proxy-1` (2026-10-14 20:16 MDT) | ce7a9c5 | no: transcript line 14, `cd` into the session folder, then `ls -R docs`; denied by permissions, not performed | success, exit 0 | 11.2 min (report at 1.8 min) | 47 | $0.42 | 5 | 3 files, 2 searches |
| `proxy-2` (2026-10-15 07:28 MDT) | 761a502 | no: transcript line 12, `cd` into the session folder, then `find docs`; denied by permissions, not performed | success, exit 0 | 11.1 min (report at 1.7 min) | 45 | $0.46 | 6 | 3 files, 1 search |
| `proxy-3` (2026-10-15 07:39 MDT) | 761a502 | no: transcript line 12, `cd` into the session folder, then `ls -R docs`; denied by permissions, not performed | success, exit 0 | 11.3 min (report at 1.9 min) | 49 | $0.41 | 5 | 3 files, 2 searches |

No session was valid, so none is the measured one, and no fourth session ran (the plan allows three).

The cause was the same each time. The session's `docs/` folder is a sibling of `project/` in the session folder, and it holds the repository's `docs/` as `docs/docs/`. Each agent first read the docs' README, then tried `docs/guides/getting-started.md` without the nested `docs/` and got "File does not exist" (or `No such file`). It then tried to list the docs from the shared parent folder. When that was denied, it found the guide with Glob and went on. `proxy-1`'s stored record also lists paths from heredoc bodies; those were harness false positives, fixed in 5b1a341 and 5345e80, and a rescan of its transcript with the fixed code leaves only line 14.

### Grade (for the record only, not a proxy result)

All three sessions got the same result on every check; only the acceptance run's duration differs (31, 32, and 30 ms).

| # | Check | Result | Reason |
|---|---|---|---|
| 1 | `serve` | pass | ironbird serve loaded the headless entry; status lists the headless target |
| 2 | `commands` | pass | lists 2 commands, including every command acceptance.yaml sends: todos.add, todos.toggle |
| 3 | `acceptance` | pass | passed: 9 steps in 31 ms (`proxy-1`), 32 ms (`proxy-2`), 30 ms (`proxy-3`) |
| 4 | `bridgeDevOnly` | pass | startBridge is called in src/ironbird/device.ts, and the development bundle contains the bridge |
| 5 | `releaseBundleClean` | pass | the release bundle does not contain the bridge |

**Proxy score: none (no valid session). Each invalid session scored 5/5 when graded for the record.**

Files the agent added or changed, the same in all three: `.gitignore`, `RESULTS.md`, `index.js`, `metro.config.js`, `package-lock.json`, `package.json`, `src/app/instance.ts`, `ironbird.config.ts`, `src/ironbird/commands.ts`, `src/ironbird/device.ts`, `src/ironbird/fakes.ts`, `src/ironbird/headless.ts`, `src/ironbird/target.ts`, plus `src/ironbird/globals.d.ts` in `proxy-3`. Docs it read: `README.md`, `docs/guides/getting-started.md`, and `docs/api.md` in each session. `proxy-1`'s record also lists `guides/getting-started.md`, which is its failed read of the missing path, not a fourth doc.

### Where the docs fell short

No tool error in any transcript came from the docs being wrong. The failed attempts that the agents retried differently were the docs path above (a harness layout problem) and commands that the session's permissions denied: a `cat` heredoc, a `( … &)` subshell, `echo $?`, and `pkill`. The agents switched to Write and a background task, which are harness constraints rather than doc gaps. The places where an agent had to choose because the docs were silent, from its RESULTS.md and the transcript:

- **A fake that holds a call until a control releases it.** No example in `docs/api.md` (`defineFake`) or the getting-started guide; each agent wrote its own list of pending saves (`proxy-1` line 71, `proxy-2` line 58, `proxy-3` line 63). All three versions passed the acceptance scenario.
- **What a control should do when there is nothing to release.** Not stated in `docs/api.md`; `proxy-2` (line 58) and `proxy-3` (line 63) made `release` throw, which surfaces as a failed control.
- **Which `appId` a bare app should use.** The guide shows one only as an example. The three sessions chose `com.barereduxapp` (`proxy-1` line 79), `bare-redux` (`proxy-2` line 66), and `com.example.barredux` (`proxy-3` line 75), each consistent between `ironbird.config.ts` and `startBridge`.
- **How a headless entry reads an environment switch such as `PLANT_BUG`.** The guide doesn't say. `proxy-1` (line 73) found `env` on the headless context in `docs/api.md`; `proxy-3` (line 67) read `process.env` through `globalThis` instead.
- **`__DEV__` under `"types": []`.** `proxy-3` (line 71) added `declare const __DEV__: boolean;` because the guide doesn't say whether it is needed. It isn't: `proxy-1` and `proxy-2` typechecked without it.
- **Stopping the daemon.** `proxy-2` noted that `docs/cli.md` describes no command to stop `serve` (Ctrl-C is implied).

## Compatibility matrix (CI)

| Leg | Project | Versions | Result |
|---|---|---|---|
| React Native 0.86 | fresh bare project, `@react-native-community/cli@20.1.0` | `react-native` 0.86.3 | success (2:14) |
| React Native 0.87 | fresh bare project, `@react-native-community/cli@20.2.0` | `react-native` 0.87.1 | success (1:52) |
| Expo SDK 57 | `examples/checkout` | `expo` 57.0.23, `react-native` 0.86.3 | success (1:18) |

The versions are the resolved ones the legs print (`compat: react-native 0.86.3 (CLI 20.1.0), typecheck passed`; `compat: Expo SDK 57 (expo 57.0.23, react-native 0.86.3)`). In each bare leg, `verify-bundle` exited 0 on the iOS and Android release bundles and 1 on the dev bundles, as expected. In the Expo leg, it exited 0 on the release export and 1 on the forced-bridge export. The same run's `test (node 22)` and `test (node 26)` jobs and `check` passed.

Run: https://github.com/ironbird-dev/ironbird/actions/runs/38742986829, on 761a502, 2026-10-15 (pull request #13).

## Device run (iOS, by hand)

Plan 4's record, in full in [m5-compat-and-ios.md](m5-compat-and-ios.md#bare-redux-ios-build-hand-run). On 2026-10-10, at commit c5bff21, `examples/bare-redux` was built by hand with Xcode 27.0 (27A266a) and React Native 0.87.1 for the iPhone 17 simulator (9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6, iOS 27.0). `pod install` and the Debug build passed. The first launch failed because the iOS 27 SDK requires the UIScene life cycle, which the 0.87 template's `AppDelegate` doesn't adopt. With a `SceneDelegate` added (committed with that record), the app launched, the bridge connected as target `ios`, and these passed on the device target: both scenarios (`add-and-sync`, `ack-reorder`), a snapshot save, toggle, and load round trip, and `verify-bundle` on the release bundle. This is evidence, not a gate (spec §12).

## Release readiness

- `node scripts/release/check-packs.mjs`: no problems in the seven packages on 761a502.
- `changeset status`: all seven published packages `minor` to 0.1.0; no private package released.
- Before the Version packages PR merges (docs/releasing.md): the first publishes of `@ironbird/redux`, `@ironbird/xstate`, and `@ironbird/testing`; the pack check with `--expect-version 0.1.0`; `compat` on that PR; and the human trial. All four are open.

## Human trial

Pending. It is the maintainer's go/no-go for releasing 0.1.0; `examples/bare-redux/eval/README.md` ("The human trial") says how to run and score it. Its result and elapsed time go here, and roadmap M5's first criterion is ticked only if every check passed within one day. If 0.1.0 is released with the trial failed or skipped, the criterion stays unticked with that outcome and the release date, and this section says so.

## Follow-ups

- **Proxy harness, docs location (needs a decision before any re-run).** The agent's first look at the docs led it outside its project in all three sessions, so the proxy can't produce a valid session as it stands. Options: put the session's docs outside the session folder, so the shared parent isn't the natural place to list them, and flatten the nested `docs/docs/`; or decide that a denied `cd` into the session's own folder, which reads nothing, doesn't invalidate a session. Choose one before running a proxy session again.
- **Proxy harness, the session record.** `run-session.mjs` and `grade.mjs` read only the transcript's last `result` event. When a background task outlives the agent's report, that event covers only the final short turn, so `session.json`'s `durationMs`, `numTurns`, and `deniedToolCalls` (0 for every proxy session) and `final-report.md` (only the follow-up message) understate the session. The cost is right, because `total_cost_usd` is cumulative. Sum the turns and denials across `result` events, and take the report from the first one. `docsRead` also counts a failed read of a missing path as a read.
- **Proxy harness, the background daemon.** Every agent started `ironbird serve` as a background task and couldn't stop it, which added about 9.5 idle minutes to each session. Allowing a narrow stop command, or telling the agent how the harness ends background tasks, would keep the wall clock close to the work.
- **Docs gaps to consider before the human trial:** an example of a fake that holds a call until a control releases it, and what a control should do when there is nothing to release (`docs/api.md`, `defineFake`); guidance on choosing `appId` for a bare app; `env` on the headless context in the getting-started guide; and how to stop `serve` (`docs/cli.md`).
- **Self-reported times.** The agents' RESULTS.md times are their own estimates. For example, `proxy-1` wrote 20:16 to 20:25 MDT, but its transcript shows its report at 20:17:54. The human trial's RESULTS.md is the participant's own record and has the same limitation.
