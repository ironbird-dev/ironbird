# M5 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| A developer other than the author wires ironbird into a copy of `examples/bare-redux` that doesn't include it yet, using only the docs, in ≤ 1 day | **pending human trial** | Not measured here: it needs a human, and it is the maintainer's go/no-go for releasing 0.1.0 (M5 design §9). The material is `examples/bare-redux/integration-exercise/`: TASK.md, CHECKLIST.md, RESULTS.md, and acceptance.yaml. **Proxy, which does not tick the criterion:** one valid sandboxed `claude -p` session on Sonnet (`claude-sonnet-5-5`), `proxy-5`, was given the same task sheet and only the published docs. It scored 5/5 on the checklist. It reported after 1.8 minutes of work and 11.2 minutes of wall clock, most of that spent waiting for a background daemon to be stopped, and cost $0.49 (2026-10-15; "Integration proxy" below). `proxy-5` was the fifth session. It ran after harness fixes and beyond the plan's cap of three sessions. Sessions 1 to 4 were invalidated by harness causes, not by ironbird: the docs layout and path-audit false positives |
| CI passes on the two most recent React Native minor versions and the current Expo SDK | met | The `compat` job on 761a502 (https://github.com/ironbird-dev/ironbird/actions/runs/38742986829): React Native 0.86.3 and 0.87.1, each in a freshly generated bare project, and Expo SDK 57 with React Native 0.86.3 through the checkout example; all three legs passed. This is JavaScript-bundle evidence: the packages install, typecheck, bundle, and stay out of production bundles on each version. Native-build evidence is the hand-run iOS build below |
| Zod 3 support question (Q8) closed, and the migration note published if support is dropped | met | Q8 closed by M5 design D9 (2026-10-04): Zod 3 is dropped, `zod ^4.2.0` stays the peer range of core and both adapters, `defineCommands` rejects any other schema with `INVALID_CONFIG`, and [docs/migrating-from-zod-3.md](../migrating-from-zod-3.md) is published |

## Integration proxy (2026-10-14 to 2026-10-15)

The proxy is one agent session standing in for the human trial, so the trial starts from a measured signal and a working instrument (M5 design D11). It is not the criterion: an agent that reads every doc in minutes is not a developer meeting ironbird for a day.

**Disclosure.** The plan allows at most three proxy sessions and measures the first valid one. None of the first three was valid. A fourth and a fifth ran after harness fixes, beyond that cap, and the fifth, `proxy-5`, is the measured session. Sessions 1 to 4 were all invalidated by the harness, not by ironbird:

- In sessions 1 to 3, the docs layout led the agent to try a `cd` outside its project. Permissions denied the command each time, so it never ran, but the attempt invalidated the session.
- In session 4, the path audit read `~0.1` in a results table as the home folder.

Each fix is a commit on this branch, listed below. Every session is in the table under "The sessions", with its reason.

### Setup

- **Machine:** Apple M3 Pro, macOS 27.2, Node v26.11.1 (the local Node when this record was written; the session record doesn't store the Node version).
- **Claude Code and model:** Claude Code 2.1.296, `--model sonnet`, which resolved to `claude-sonnet-5-5`. The plan expected Claude Code 2.1.283 and `claude-sonnet-5`. By the time the sessions ran, the installed version and the alias had moved on, and the baseline captured at prepare time recorded the versions above. Limits: 90 minutes and $20 per session.
- **Harness:** `examples/bare-redux/eval/`, reusing `examples/checkout/eval/lib/`: the sandbox, the isolation check in its `ironbird: 'absent'` mode, and the transcript tools. Each run's template was prepared from the branch head with no uncommitted sources:

  | Template commit | Sessions | Harness changes it carries |
  |---|---|---|
  | ce7a9c5 | `smoke-1`, `proxy-1` | none of the fixes below |
  | 761a502 | `smoke-2`, `proxy-2`, `proxy-3` | heredoc bodies ignored by the path audit (5b1a341, 5345e80) |
  | 726be78 | `smoke-3`, `proxy-4` | adds: the prompt states the docs layout and says to list or search the docs by absolute path; the session record keeps every `result` event |
  | 643fb79 | `smoke-4`, `proxy-5` | adds: the path audit's tilde rule (26cb439, db93cbf, e9ff3f2, 32b3919, 643fb79) |

  The measured template was prepared at 2026-10-16T00:38:32Z. Earlier `prepare.json` files were replaced by later ones.
- **Tarballs**, repacked at 0.1.0 (sha256 prefix, 643fb79 template):

  | Tarball | sha256 |
  |---|---|
  | `ironbird-core-0.1.0.tgz` | `1000363a2e46` |
  | `ironbird-react-native-0.1.0.tgz` | `ba77039e648a` |
  | `ironbird-redux-0.1.0.tgz` | `0ebc4ef33461` |
  | `ironbird-cli-0.1.0.tgz` | `934959153604` |

- **Docs given:** 25 files: the README, the package READMEs, and `docs/` without `docs/superpowers/` and `docs/evals/`. They name bare-redux in 5 lines, none showing its wiring:
  - `docs/api.md:462`: bare-redux's `metro.config.js` carries the zod setting;
  - `docs/guides/getting-started.md:11`: a link to the example;
  - `docs/releasing.md:41`: the human trial's folder;
  - `docs/roadmap.md:117` and `:124`: the M5 scope and criterion.

  The `prepare.json` files for the 761a502 and 643fb79 templates give the same counts.
- **Isolation:**
  - `claude -p` runs under `sandbox-exec`. The repository and `~/.ironbird-eval` are denied; the session's `project/` and a read-only `docs/` are allowed.
  - `--setting-sources project`, with no MCP server and no ironbird skill, checked on the init event. Every session's isolation check was valid.
  - Tools are `Bash,Read,Edit,Write,Glob,Grep`. Bash is limited to `npm install*`, `npm test*`, `npm run *`, `npx ironbird *`, `npx react-native bundle *`, `npx tsc*`, `git status|diff|log*`, `ls*`, and `mkdir *`, and `--permission-prompts none` denies anything else automatically.
  - Claude Code applied this allowlist inconsistently; see the follow-ups. `sandbox-exec` held in every session: in `smoke-3`, it stopped the write into the docs with `EPERM`.
- **Grader self-checks:**
  - The wired `examples/bare-redux` scored 5/5 with `grade.mjs --selftest`, rerun on 643fb79 for this record.
  - The un-integrated template failed checks 1 to 4 and passed check 5, as it must. This is `prepare.json`'s check on the 643fb79 template.

### Smoke

Four smoke sessions ran, one before each prepared template was used:

| Smoke | When (MDT) | Template commit |
|---|---|---|
| `smoke-1` | 2026-10-14 20:15 | ce7a9c5 |
| `smoke-2` | 2026-10-15 07:27 | 761a502 |
| `smoke-3` | 2026-10-15 15:24 | 726be78 |
| `smoke-4` | 2026-10-15 18:38 | 643fb79 |

Each behaved as designed. Steps 1 (`ls`), 2 (read a doc), and 4 (write and read in the project) worked. Step 3 (read the repository's AGENTS.md) was refused with "File is in a directory that is denied by your permission settings." Step 5 (write into the docs) was refused too:

- in `smoke-1`, `smoke-2`, and `smoke-4`, by the permission rules ("Permission for this tool use was denied … Path is outside allowed working directories.");
- in `smoke-3`, by the sandbox (`EPERM: operation not permitted`).

Each smoke session is invalid by design, for naming the repository. Each took about 10 seconds and $0.03.

### The sessions

Times are wall clock. In sessions 1, 2, 3, and 5, the agent started `ironbird serve` as a Claude Code background task and couldn't stop it, because `pkill` was denied. The session stayed open until Claude Code killed that task about 9.5 minutes after the agent's report. The agent then woke for one short final turn, so these transcripts have two `result` events.

Since 726be78, the session record keeps every `result` event and the first report separately. For sessions 1 to 3, the totals below were added up by hand from the transcripts. In every session, the cost is the last event's `total_cost_usd`, which is the session total.

| Session | Template commit | Valid | Ended by | Duration | Turns | Cost | Denied tool calls | Docs read |
|---|---|---|---|---|---|---|---|---|
| `proxy-1` (2026-10-14 20:16 MDT) | ce7a9c5 | no: docs layout. Transcript line 14: `cd` into the session folder, then `ls -R docs`; denied by permissions, not performed | success, exit 0 | 11.2 min (report at 1.8 min) | 47 | $0.42 | 5 | 3 files, 2 searches |
| `proxy-2` (2026-10-15 07:28 MDT) | 761a502 | no: docs layout. Line 12: `cd` into the session folder, then `find docs`; denied, not performed | success, exit 0 | 11.1 min (report at 1.7 min) | 45 | $0.46 | 6 | 3 files, 1 search |
| `proxy-3` (2026-10-15 07:39 MDT) | 761a502 | no: docs layout. Line 12: `cd` into the session folder, then `ls -R docs`; denied, not performed | success, exit 0 | 11.3 min (report at 1.9 min) | 49 | $0.41 | 5 | 3 files, 2 searches |
| `proxy-4` (2026-10-15 15:24 MDT) | 726be78 | no: path-audit false positive. Line 63, a `python3` heredoc that wrote `~0.1` (hours) into RESULTS.md, read as the home folder | success, exit 0 | 2.6 min (report at 2.5 min) | 16 | $0.36 | 0 | 3 files, 0 searches |
| **`proxy-5`** (2026-10-15 18:38 MDT) | 643fb79 | **yes** | success, exit 0 | 11.2 min (report at 1.8 min) | 54 | $0.49 | 8 | 2 files, 2 searches |

`proxy-5` is the measured session, and no session ran after it.

**Why sessions 1 to 3 failed.** Each session's `docs/` folder sits next to `project/` in the session folder and holds the repository's `docs/` as `docs/docs/`. Each agent first tried `docs/guides/getting-started.md` without the nested `docs/` and got "File does not exist" (or `No such file`). It then tried to list the docs from the shared parent folder. From 726be78 on, the prompt names the layout and gives the guide's absolute path. `proxy-4` and `proxy-5` read the guide on their first try.

**Rescan with the final harness.** The transcripts were re-scanned with the final path audit (643fb79). The `cd` is still the only invalidating path in sessions 1 to 3. Sessions 4 and 5 have none. `proxy-1`'s stored record also lists paths from heredoc bodies, which were harness false positives fixed before `proxy-2` ran.

### Grade

`proxy-5`, the measured session:

| # | Check | Result | Reason |
|---|---|---|---|
| 1 | `serve` | pass | ironbird serve loaded the headless entry; status lists the headless target |
| 2 | `commands` | pass | lists 2 commands, including every command acceptance.yaml sends: todos.add, todos.toggle |
| 3 | `acceptance` | pass | passed: 9 steps in 46 ms |
| 4 | `bridgeDevOnly` | pass | startBridge is called in src/ironbird/device.ts, and the development bundle contains the bridge |
| 5 | `releaseBundleClean` | pass | the release bundle does not contain the bridge |

**Proxy score: 5/5** (`proxy-5`).

The four invalid sessions, graded for the record only, also scored 5/5 each. `proxy-4` declared a third command, `todos.rename`, and wired `PLANT_BUG` through the headless `env`. It then checked that the acceptance scenario fails at its last step with `PLANT_BUG=1`.

Files the agent added or changed in `proxy-5`:

- `.gitignore`, `RESULTS.md`, `index.js`, `metro.config.js`, `package.json`, `package-lock.json`, `src/app/instance.ts`;
- new: `ironbird.config.ts`, `src/ironbird/commands.ts`, `src/ironbird/device.ts`, `src/ironbird/fakes.ts`, `src/ironbird/headless.ts`, `src/ironbird/target.ts`.

Docs it read: `docs/guides/getting-started.md` and `docs/api.md`. Its two searches were a listing of the docs folder and a search of `docs/cli.md` for `verify-bundle`. It never opened the docs' `README.md`.

### Where the docs fell short

No tool error in `proxy-5` came from the docs being wrong. Its eight denied calls were command shapes outside the session's Bash rules: two compound `cd …;` commands, a `cat` heredoc, a `( … &)` subshell, two `echo exit=$?`, and two `pkill`. The agent switched to the Read, Glob, Write, and Edit tools, a background task, and single commands. These are harness constraints, not doc gaps.

These are the places where `proxy-5` had to choose because the docs were silent, from its RESULTS.md and transcript:

- **A fake that holds a call until a control releases it.** There is no example in `docs/api.md` (`defineFake`) or the guide. The agent wrote a list of pending promises (line 81), as every earlier session did.
- **A held call and the default settle.** The tracker's default `idle` settle waits for held calls, which is why the acceptance scenario sets `settle: false`. The agent inferred this from `acceptance.yaml` (line 21); the docs don't say it.
- **Which `appId` a bare app should use.** No format is stated. The agent used `com.example.bareredux` in both `startBridge` (line 87) and `ironbird.config.ts` (line 91). The earlier sessions chose `com.barereduxapp`, `bare-redux`, `com.example.barredux`, and `com.barereduxtodos`.
- **`tracker.wrap` on the app's real port.** The guide's step 8 wraps the device store's port, but it doesn't say this is safe in a release build. It is: a disabled tracker returns the port untouched (line 89).

The invalid sessions, for the record, also reported these gaps:

- what a release control should do when nothing is held: `proxy-2` and `proxy-3` made it throw, and `proxy-4` made it a no-op;
- how a headless entry reads `PLANT_BUG`: `proxy-1` and `proxy-4` found `env` on the headless context in `docs/api.md`, and `proxy-3` read `process.env` through `globalThis`;
- whether a bare app with `"types": []` needs `declare const __DEV__`: `proxy-3` and `proxy-4` added it, but it isn't needed, since `proxy-1`, `proxy-2`, and `proxy-5` typechecked without it;
- npm's warning that esbuild's install script wasn't run (`proxy-4`), which the docs don't mention, though `serve` works anyway;
- how to stop `serve`: `proxy-2` noted that `docs/cli.md` gives no stop command.

## Compatibility matrix (CI)

| Leg | Project | Versions | Result |
|---|---|---|---|
| React Native 0.86 | fresh bare project, `@react-native-community/cli@20.1.0` | `react-native` 0.86.3 | success (2:14) |
| React Native 0.87 | fresh bare project, `@react-native-community/cli@20.2.0` | `react-native` 0.87.1 | success (1:52) |
| Expo SDK 57 | `examples/checkout` | `expo` 57.0.23, `react-native` 0.86.3 | success (1:18) |

The versions are the resolved ones each leg prints, for example `compat: react-native 0.86.3 (CLI 20.1.0), typecheck passed` and `compat: Expo SDK 57 (expo 57.0.23, react-native 0.86.3)`. Each `verify-bundle` exit matched its expected value:

- in each bare leg, 0 on the iOS and Android release bundles and 1 on the dev bundles;
- in the Expo leg, 0 on the release export and 1 on the forced-bridge export.

The same run's `test (node 22)`, `test (node 26)`, and `check` jobs passed. The commits after 761a502 change only the proxy eval harness and the docs, not a published package.

Run: https://github.com/ironbird-dev/ironbird/actions/runs/38742986829, on 761a502, 2026-10-15 (pull request #13).

## Device run (iOS, by hand)

This is plan 4's record, given in full in [m5-compat-and-ios.md](m5-compat-and-ios.md#bare-redux-ios-build-hand-run).

- **When and what:** on 2026-10-10, at commit c5bff21, `examples/bare-redux` was built by hand with Xcode 27.0 (27A266a) and React Native 0.87.1 for the iPhone 17 simulator (9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6, iOS 27.0).
- **Build:** `pod install` and the Debug build passed.
- **First launch:** it failed. The iOS 27 SDK requires the UIScene life cycle, which the 0.87 template's `AppDelegate` doesn't adopt.
- **After the fix:** with a `SceneDelegate` added (committed with that record), the app launched and the bridge connected as target `ios`. These passed on the device target:
  - both scenarios, `add-and-sync` and `ack-reorder`;
  - a snapshot save, toggle, and load round trip;
  - `verify-bundle` on the release bundle.

The device run is evidence, not a gate (spec §12).

## Release readiness

- `node scripts/release/check-packs.mjs`: no problems in the seven packages on 643fb79.
- `changeset status`: all seven published packages `minor` to 0.1.0; no private package released.
- Before the Version packages PR merges (docs/releasing.md): the first publishes of `@ironbird/redux`, `@ironbird/xstate`, and `@ironbird/testing`; the pack check with `--expect-version 0.1.0`; `compat` on that PR; and the human trial. All four are open.

## Human trial

Pending. It is the maintainer's go/no-go for releasing 0.1.0; `examples/bare-redux/eval/README.md` ("The human trial") says how to run and score it. Its result and elapsed time go here, and roadmap M5's first criterion is ticked only if every check passed within one day. If 0.1.0 is released with the trial failed or skipped, the criterion stays unticked with that outcome and the release date, and this section says so.

## Follow-ups

- **Resolved:**
  - **Proxy docs layout (726be78).** The prompt states the docs layout and says to list or search the docs by absolute path. `proxy-4` and `proxy-5` read the guide on their first try.
  - **The session record (726be78).** The record keeps every `result` event and the first report, and `final-report.md` holds every report.
  - **The path audit's tilde rule (26cb439 to 643fb79).** A bare `~` before text other than `/`, such as `~0.1`, is no longer a path. Every tilde prefix that Bash could expand is reported, and forms other than the home folder or `+` can't be normalized back inside the session.
  - **Accepted residuals of the tilde rule:**
    - a quoted `"~/x"` is reported, a false positive;
    - `a:~root`-style words are reported, false positives;
    - `PATH=a:/etc` is missed, as it was before the fix.
- **Proxy harness, Bash permissions.** The same allowlist and `--permission-prompts none` gave different decisions in different sessions:
  - `proxy-4` had no denials and ran commands outside the allowlist: `python3`, `sed -i`, `pkill`, and a `( … &)` subshell;
  - `proxy-5` had eight denials of similar shapes;
  - `smoke-3`'s write into the docs got past the permission rules and was stopped by `sandbox-exec`.

  The sandbox is the boundary that held. The allowlist shapes what an agent can do, so check how Claude Code applies it before relying on it.
- **Proxy harness, the background daemon.** Agents start `ironbird serve` as a background task and can't stop it, which added about 9.5 idle minutes to four of the five sessions. Allowing a narrow stop command, or telling the agent how the harness ends background tasks, would keep the wall clock close to the work.
- **Proxy harness, `docsRead`.** It counts a failed read of a missing path as a read: `proxy-1` lists `guides/getting-started.md`.
- **Docs gaps to consider before the human trial:**
  - in `docs/api.md`, `defineFake`: an example of a fake that holds a call until a control releases it; what a control should do when nothing is held; and that held calls block the default `idle` settle;
  - guidance on choosing `appId` for a bare app;
  - that `tracker.wrap` on a real port is safe in release builds;
  - `env` on the headless context, in the getting-started guide;
  - the esbuild install-script warning;
  - how to stop `serve` (`docs/cli.md`).
- **Self-reported times.** The agents' RESULTS.md times are their own estimates. `proxy-5` wrote "about 18:50 MDT", but its transcript shows its report at 18:40:45 MDT. The human trial's RESULTS.md is the participant's own record and has the same limitation.
