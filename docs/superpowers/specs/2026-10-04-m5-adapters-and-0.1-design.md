# M5: Adapters and 0.1 release, design

| | |
|---|---|
| Status | Drafted 2026-10-04 under the maintainer's autonomy grant; revised the same day after a codex review (11 findings, all resolved here, see §13) |
| Milestone | M5 in [roadmap.md](../../roadmap.md) |
| Builds on | [api.md](../../api.md) "Adapters (P1)" · [cli.md](../../cli.md) `snapshot`, `watch`, `doctor` · [protocol.md](../../protocol.md) `snapshotSave`, `snapshotLoad`, §2.2 `/v1/stream`, the error table · [spec.md](../../spec.md) R15, R17, R19, R20, Q8 · [M3 design](2026-09-29-m3-agent-interface-design.md) §7 (the sandboxed agent-eval harness) |

This spec records only what the existing docs leave open for M5. Where it and an older doc disagree, this spec wins, and the older doc is updated in the same pull request as the code.

## 1. Scope

M5 delivers:
- R19: `@ironbird/redux` and `@ironbird/xstate`.
- R15: snapshots.
- R17: `watch`, moved here from M3.
- R20: `doctor`.
- `examples/bare-redux`.
- A CI compatibility matrix.
- Closing Q8.
- Preparing the 0.1.0 release.

The exit criteria and how each is measured:

| Criterion (roadmap) | Measured by |
|---|---|
| A developer other than the author wires ironbird into a copy of `examples/bare-redux` that doesn't include it yet, using only the docs, in ≤ 1 day | Needs a human, so it is the maintainer's to run, and it is the maintainer's go/no-go for releasing 0.1.0 (§9). M5 prepares the material: `examples/bare-redux/integration-exercise/` is a copy without ironbird, with a task sheet, a scoring checklist, and a place to record elapsed time. M5 also records a **proxy**: one sandboxed `claude -p` Sonnet session, using the M3 harness pattern, gets the same task sheet and only the published docs, and is scored on the same checklist. The proxy result is recorded as a proxy and never ticks the human criterion. M5 closes with this criterion unticked and marked "pending human trial" |
| CI passes on the two most recent React Native minor versions and the current Expo SDK | The `compat` CI job (§8): React Native 0.86 and 0.87 (latest is 0.87.1 on 2026-10-04), each in a freshly generated bare project, and Expo SDK 57 through the checkout example. It is JavaScript-bundle evidence, reported as such; native-build evidence is the one hand-run iOS build of `bare-redux` |
| Zod 3 support question (Q8) closed, and the migration note published if support is dropped | Q8 closed by D9; `docs/migrating-from-zod-3.md` published |

Out of scope:
- **Snapshot scenario steps:** the `snapshot` step stays P1.
- **Watch beyond the CLI:** `watch` over MCP, `watch` filters other than `--path`, and reconnecting `watch` after the target disconnects.
- **Actually publishing 0.1.0:** that happens when the maintainer merges the Version Packages PR, after the checks in §9.
- **Device runs in CI**, and native builds in CI.
- **Android builds of `bare-redux`.** The iOS build is verified once, by hand, on the iPhone 17.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `@ironbird/redux` exports `fromStore(store, { commands, toAction?, select?, restore? })` returning a core `Target`. `select` only shapes the state that `getState`, `waitFor`, and `watch` see. `persist` always saves the **root** state, `store.getState()`, never the projection. `restore` exists only when the app passes `restore: { schema }`, a Zod schema for the root state, **and** wraps its root reducer with the exported `withIronbirdRestore(reducer)`. The adapter validates the snapshot with `schema` first and only then dispatches one internal action carrying the parsed value, which the wrapper returns as the new root state. If the store's state afterwards isn't that value, the reducer wasn't wrapped, and the load fails `INVALID_SNAPSHOT` | A projection such as `state.todos` cannot rebuild the root reducer's state. Redux has no built-in state replacement, and the adapter can't tell from a store instance whether its reducer was wrapped, so restore is an explicit option. The schema keeps rule 4: the reducer never receives `unknown` |
| D2 | `@ironbird/xstate` exports `fromActor(actor, { commands, toEvent?, select?, restore? })`. It returns a `Target` plus an `actor()` accessor. `persist` uses `actor().getPersistedSnapshot()`. `restore` exists only when the app passes `restore: { snapshotSchema, actorOptions? }`. The adapter owns its subscription to the actor, and restore builds and starts the replacement before touching the live actor. §3 has the contract | `createTarget` subscribes once, at creation, and XState stops an actor's observers when the actor stops, so a naive swap leaves the target watching a stopped actor. Starting the replacement first means a bad snapshot never costs the app its live actor |
| D3 | Both adapters list their library and `zod` as peer dependencies. At runtime they import `@ironbird/core` and, for `@ironbird/xstate`, `createActor` from the `xstate` peer; nothing else. Dispatching goes through the core registry, so payloads are validated where they are applied (rule 4) | Apps pin their own Redux and XState versions. Rule 7 asks for an ADR only for core and the bridge; the PR carries the justification line |
| D4 | Snapshots (R15) are `snapshotSave` and `snapshotLoad` promoted to P0 on both targets. The headless target serves them from the `Target`'s `persist` and `restore`; the bridge gains the same two handlers. Both pass `persist()`'s result through one strict serializer before replying, and `snapshotLoad` gains an optional `app` checked by the applying target. §4 has the contract | The operations, capabilities, and result shapes are already in protocol.md. The existing state serializer substitutes placeholders, which would turn a `Map` or a cycle into a successful but corrupt snapshot |
| D5 | `watch` (R17) is a CLI command over the existing `/v1/stream`. It opens the stream first, reads the initial value behind a barrier, then reads `getState` at `--path` after every `state` frame, strictly one read at a time, and prints `{ rev, patch }` lines with an RFC 6902 patch against the last value it printed. The daemon gains one additive frame: when a stream's state subscription goes live, it sends a `state` frame with the target's current revision. §5 has the contract | The stream carries revisions, not values, so the client reads them. Today the daemon subscribes to state only after the event backlog, and the client can't see when; the initial frame is the barrier that makes "stream first, then read" race-free. An in-house differ (add, remove, replace) avoids a dependency for about 100 lines of code |
| D6 | `doctor` (R20) runs without a daemon. It prints `{ checks: [{ id, ok, required, detail, fix? }] }` and exits 0 when every required check passes and 1 otherwise. §6 has the checks | Matches cli.md's list, plus a version-skew check, which the M3 eval showed is easy to get wrong |
| D7 | `examples/bare-redux` is a bare React Native 0.87 app made from the community template, with Redux Toolkit. It holds a small to-do domain with a planted bug, so it is not the checkout example: a fake sync API reorders acknowledgements. It is wired with `@ironbird/redux` (including `restore`), a headless entry, the bridge, and scenarios. `examples/bare-redux/integration-exercise/` is the same app with every ironbird file and line removed, generated by a script so the two cannot drift. It stays on 0.87 and is not the compat matrix's subject | The roadmap's second example and the material for the human exit criterion. Generating the copy from the wired app keeps the exercise honest |
| D8 | The CI compatibility matrix is a `compat` job with three legs. Each React Native leg (0.86, 0.87) generates a fresh bare project with that version's community CLI and checks the packed ironbird packages in it; the Expo SDK 57 leg checks the checkout example. `check` requires `compat`. §8 has the steps | Overriding `react-native` inside one 0.87 project would leave its template, native project, and coupled dependencies at 0.87 and prove nothing about 0.86. A generated project per minor is what a user on that minor has |
| D9 | Q8 is closed by **dropping Zod 3**: ironbird requires the installed `zod` package at ^4.2, as today. The peer range of `@ironbird/core` and both adapters is `zod ^4.2.0`. `docs/migrating-from-zod-3.md` covers apps still on Zod 3: install `zod@^4.2`, which ships the old API at `zod/v3`, move legacy schemas' imports to `zod/v3` where they aren't migrated yet, and write command schemas against Zod 4 (`zod` or `zod/v4`). It also says that `zod` 3.25.x, although it offers a `zod/v4` subpath, doesn't satisfy the peer range | Command schemas rely on Zod 4's `toJSONSchema` (ADR-0004). Supporting both versions would double the schema surface for a shrinking audience. Zod 4 carrying `zod/v3` gives Zod 3 code a path that needs no ironbird support |
| D10 | 0.1.0 is prepared, not published. Every published package gets a `minor` changeset so the Version Packages PR moves them to 0.1.0. The release-prep PR carries the pre-merge checklist in §9 | Publishing is the maintainer's action when they merge, after the human trial. A brand-new package can't publish over OIDC until it exists on npm (the 0.0.2 lesson) |
| D11 | The integration proxy reuses the M3 eval harness's sandbox, isolation check, and transcript tooling, through a thin `examples/bare-redux/eval/` script. It is scored by a checklist grader: `ironbird serve` loads the headless entry, `ironbird commands` lists the declared commands, the provided acceptance scenario passes headlessly, the bridge is started under `__DEV__` only, and `verify-bundle` passes on a production bundle | Gives a measured signal now and a ready instrument for the human trial. It is honest about being a proxy |
| D12 | One new error code, `INVALID_SNAPSHOT`, additive, with details `{ path, reason }`. It covers a `snapshotSave` whose state can't be serialized losslessly, a `snapshotLoad` whose snapshot fails the target's validation, and a restore the target couldn't apply. `APP_MISMATCH`'s meaning is extended to a `snapshotLoad` whose `app` differs from the applying target's | `DISPATCH_FAILED` describes command and control failures; reusing it for snapshots would blur both. Additive codes and an optional parameter need no `PROTOCOL_VERSION` bump |

## 3. XState restore

The adapter keeps `current`, the live actor, and its own listener set. The `subscribe` it hands to `createTarget` registers in that set, and the adapter's single subscription to `current` notifies the set. `getState`, `dispatch`, `persist`, and `actor()` always use `current`.

`restore(snapshot)` runs these steps, synchronously after validation, so no event can reach either actor in between:
1. Parse `snapshot` with `snapshotSchema`. On failure, throw `INVALID_SNAPSHOT` with the first issue's path and message. Nothing has changed.
2. Build and start the replacement: `createActor(current.logic, { ...actorOptions, snapshot: parsed }).start()`. If construction or `start()` throws, or the started actor's status is `error`, stop the replacement if it exists and throw `INVALID_SNAPSHOT` with `{ path: '', reason: 'actor failed to start: <message>' }`. The old actor stays live and subscribed.
3. Only on success: unsubscribe from the old actor, subscribe to the replacement, stop the old actor, swap `current`, and notify the listener set once, so the target emits a new revision.

Consequences, documented in api.md:
- App code that holds the old actor reference sees a stopped actor after a restore. It must read the adapter's `actor()` accessor, and re-read it when the target notifies, for example to re-render.
- Restoring restarts the invoked actors and spawned children of the restored state, as XState persistence does, and stops the old actor's. Entry actions aren't re-run. Between step 2 and step 3 both actors exist for one synchronous turn; effects that start on `start()` can run once more than in the original timeline.
- `snapshotLoad` stays in the per-target mutating queue, so no ironbird dispatch interleaves with a restore.

## 4. Snapshots

**Strict serializer.** `@ironbird/core` exports `serializeSnapshot(value)`, which returns JSON-safe data or throws `INVALID_SNAPSHOT` naming the first lossy path. It never substitutes placeholders. It rejects functions, symbols, `BigInt`, `NaN` and ±`Infinity`, `Map`, `Set`, `Date`, any other non-plain object (class instances, boxed primitives, typed arrays), cycles, `undefined` or holes in arrays, and throwing getters. `undefined` object properties are omitted, as JSON does, because XState's persisted snapshots carry them. `reason` is the kind, such as `Map` or `cycle`. The headless target and the bridge both run it on `persist()`'s result before replying to `snapshotSave`.

**Restore errors.** Adapters validate before applying (§3, D1). `createTarget` converts any other error a `Target`'s `restore` throws into `INVALID_SNAPSHOT` with `{ path: '', reason: <message> }`, and api.md says a hand-written `restore` receives `unknown` and must validate it.

**`snapshotLoad` params** become `snapshot`, `app?`. The applying target, headless or bridge, checks `app` against its own app id and fails `APP_MISMATCH` with `{ expected, received }` before anything else. A missing `app` skips the check, so direct RPC callers keep working. An older bridge ignores the parameter; `doctor`'s version check catches that skew. `snapshotLoad` stays in the per-target mutating queue.

**CLI.** `ironbird snapshot save <file>` writes `{ app, target, rev, snapshot }`, with `app` from the target's `status` entry. `ironbird snapshot load <file>` parses the file and validates that wrapper before sending anything; a file that isn't JSON or doesn't match fails `INVALID_PAYLOAD` with `{ name: 'snapshotLoad', issues }`, before any mutation. It then sends `snapshotLoad` with `snapshot` and the file's `app`. The file's `target` is informational: a snapshot can be loaded into another target of the same app. The CLI's exit-code table gains `INVALID_SNAPSHOT` next to `INVALID_PAYLOAD`.

## 5. watch

**Startup.**
1. Call `events` with `limit: 0` for `nextSeq`, and open `/v1/stream` with `since` set to it, so no event backlog is replayed.
2. Wait for the barrier: the first `state` frame, which the daemon now sends as soon as the stream's state subscription is live. It goes through the stream's throttle like any other state frame. Frames after it are buffered.
3. Read `getState` at `--path`. Print the first line, labelled with the `rev` that read returned. Then reconcile the buffer as in the steady state.

**Steady state.**
- At most one read is in flight. A `state` frame that arrives during a read marks the watcher dirty; when the read finishes, the watcher reads again if any frame arrived since the read started, whatever `rev` that frame carries. A `state` frame that arrives while no read is in flight starts a read. The frame's `rev` is never compared with the read's: revisions restart after `reset` and `reload`, and the daemon coalesces frames, so a frame whose `rev` equals the one just read can carry a different state (for example, a reset followed by as many dispatches as before lands on the same revision). A read that changed nothing costs one `getState`, and its empty patch prints nothing.
- Each line's `rev` is the revision the read actually returned, never the frame's.
- The patch is computed against the last value **printed**. A read whose patch is empty prints nothing.
- `watch` shows sampled state: the daemon throttles state frames to 10 per second and coalesces revisions, so intermediate values can be skipped. `events --follow` shows every recorded event when full history matters.

**Values and patches.**
- Patch pointers are relative to the value at `--path`, and the root pointer is `""`. Tokens are escaped per RFC 6901: `~` becomes `~0`, then `/` becomes `~1`.
- A path is present when `getState`'s result has a `value` property; `null` is present, `undefined` is missing.
- Before the first line the value counts as missing. So the first line is `{ rev, patch: [{ op: 'add', path: '', value }] }` when the path is present, and `{ rev, patch: [] }` when it is missing; it is always printed.
- Later, a value that disappears prints `{ op: 'remove', path: '' }` and one that appears prints `{ op: 'add', path: '', value }`.
- The differ compares objects by key (add, remove, replace) and arrays index by index: changed items are replaced, extra old items are removed from the highest index down, and new items are added at the end. A change of type is a `replace`.

**Ending.** SIGINT ends cleanly with exit 0. An `error` frame, such as `TARGET_DISCONNECTED`, is printed as `{ error }` and sets the exit code, as `events --follow` does.

## 6. doctor

| id | Required | Passes when | On failure |
|---|---|---|---|
| `node` | yes | Node ≥ 22 | Fix names the required version |
| `config` | yes | `ironbird.config.ts` exists and validates | A missing config fails, with a fix hint naming the file to create and linking its docs; an invalid one lists the `INVALID_CONFIG` issues |
| `headless` | yes | The configured headless entry loads. A remote-only app, with no headless entry, passes with detail "not configured" | It bundles into a fresh temporary directory, removed afterwards, never `.ironbird/cache`. A forbidden `react-native` import reports the import chain; any other load failure reports its message |
| `port` | yes | The configured daemon port is free, or held by an ironbird daemon | An occupied port is identified by `GET /v1/status` with a 1 s timeout: a 200 with a `{ version, protocol }` body, or a 401 with an `UNAUTHORIZED` envelope, counts as ironbird. Anything else fails, with a fix to change `port` or stop the process |
| `gitignore` | yes | `.ironbird/` is ignored by git, or the project isn't in a git repository | Fix: add `.ironbird/` to `.gitignore` |
| `versions` | yes | The installed `@ironbird/*` packages and `ironbird` resolve to the same version | Lists each package's version |
| `simctl` | no | macOS with `xcrun simctl` available; detail lists booted simulators | Informational |
| `adb` | no | `adb` available; detail lists devices | Informational |

## 7. Doc and protocol changes

- **protocol.md:** `snapshotSave` and `snapshotLoad` drop "(P1)"; `snapshotLoad` takes `app?`; `snapshotSave` is strict; the `INVALID_SNAPSHOT` row; `APP_MISMATCH`'s extended meaning; §2.2's initial `state` frame. All additive, so `PROTOCOL_VERSION` stays 1 and no ADR is needed (rule 5).
- **api.md:** the Adapters section with D1 and D2's signatures, `withIronbirdRestore`, `actor()`, `serializeSnapshot`, and the `restore` validation duty.
- **cli.md:** `snapshot`, `watch` (§5's line rules), and `doctor` (§6's output).
- Changesets for every touched published package (rule 6).

## 8. Compatibility matrix

**React Native legs (0.86, 0.87).** Each leg runs on Linux, in a temporary directory outside the workspace:
1. Generate a project with `npx @react-native-community/cli@<pin> init --version <rn>`. Each leg pins the CLI version that React Native minor's template declares, recorded in the workflow's matrix.
2. Assert that `react-native` resolves to the leg's minor.
3. Install `@ironbird/core` and `@ironbird/react-native` from tarballs made by `pnpm pack` in the same run.
4. Add a minimal wiring file that builds a `createTarget` and calls `startBridge`, and import it from `index.js`.
5. Typecheck the wiring against that React Native version's types.
6. Build a production bundle with `react-native bundle --dev false` and run `verify-bundle` on it: it must be clean.
7. Build a dev bundle and run `verify-bundle` on it: the marker must be found, so a clean result in step 6 isn't vacuous.

**Expo SDK 57 leg.** The checkout example, on React Native 0.86 as Expo SDK 57 pins it: assert the resolved `expo` and `react-native` versions, run `expo export`, and run `verify-bundle` on the output, which must be clean.

**Evidence.** The evals record reports these as JavaScript-bundle evidence: the packages install, typecheck, bundle, and stay out of production bundles on each version. It isn't native-build evidence. That is the one hand-run iOS build of `bare-redux` on the iPhone 17, recorded separately.

## 9. Release and the human gate

- The human trial is the maintainer's go/no-go before releasing 0.1.0. M5 records the proxy result and leaves criterion 1 unticked, marked "pending human trial", in roadmap.md and the evals record.
- The release-prep PR's description lists what must hold before the Version Packages PR is merged:
  1. For each new package (`@ironbird/redux`, `@ironbird/xstate`, and `@ironbird/testing` if still unpublished): publish its first version by hand from the Version Packages PR's branch, then run `npm trust github <pkg> --file release.yml --repo ironbird-dev/ironbird --allow-publish`.
  2. Run `pnpm pack` for every published package and check the contents: ESM and CommonJS builds where they apply, type declarations, README and LICENSE, no tests or sources that shouldn't ship.
  3. The `compat` job passes on the Version Packages PR.
  4. The human trial's result and elapsed time are recorded.
- If the maintainer releases with the human trial failed or skipped, the criterion stays unticked with that outcome and the release date written next to it, and the evals record says so.

## 10. Work breakdown

Five plans:

1. **Adapters:** `@ironbird/redux` and `@ironbird/xstate`, including §3's restore, with unit tests and the api.md sections. Each adapter gets an in-repo headless sample that `@ironbird/testing` drives.
2. **Snapshots and watch:** the strict serializer, `INVALID_SNAPSHOT`, `snapshotSave` and `snapshotLoad` on both targets, the `snapshot` commands, the stream's initial `state` frame, `watch` with its differ, and §7's doc changes.
3. **Doctor:** the command, its checks, and its tests.
4. **bare-redux and compatibility:** the example app, its headless entry and scenarios, the integration exercise generator, the CI compat job, and one hand-run iOS build.
5. **Release and gate:** Q8 and the migration note, the 0.1.0 changesets and README, the release-prep PR with §9's checklist, the integration proxy eval, and the M5 evals record.

Plans 1 to 3 are independent of each other, except that plan 1's restore errors use plan 2's `INVALID_SNAPSHOT`; whichever lands first adds the code. Plan 4 needs plan 1's redux adapter. Plan 5 needs all four.

## 11. Testing

- **Adapters:**
  - Unit tests against real Redux Toolkit and XState v5 stores and actors: dispatch, validation, state, subscribe, `persist` and `restore`, and capabilities absent without support.
  - Redux: `persist` saves the root state even with a `select` projection; a schema failure leaves the store untouched; a store whose reducer isn't wrapped fails `INVALID_SNAPSHOT`.
  - XState: `dispatch`, `waitFor`, and `watch` after a restore all follow the new actor; a schema failure and an incompatible snapshot that fails to start each leave the old actor live and subscribed; `actor()` returns the replacement; a restored state with an invoked actor shows it restarted, and the test notes it.
  - A `modelTest` run over each adapter's sample, so the adapters work with M4's tooling.
- **Snapshots:**
  - The strict serializer: each rejected kind names its path; `undefined` object properties are omitted.
  - Headless and bridge handler tests: `INVALID_SNAPSHOT` on save, `APP_MISMATCH` with `app`, no check without it, and `UNSUPPORTED` without the capabilities.
  - A CLI round trip that saves, mutates, loads, and gets the same state; a malformed file fails `INVALID_PAYLOAD` with the target's state unchanged.
- **Watch:**
  - A differ property test with fast-check: applying the patch to the last printed value yields the next value, including keys with `~` and `/`, array shifts, and the path disappearing and reappearing.
  - CLI integration tests against a daemon, one per boundary: a change before the stream opens, between the barrier and the initial read, during the initial read, and during a slow later read; a `reset` that moves the revision backwards; `--path`; and ending on SIGINT and on an error frame.
  - A daemon test that the initial `state` frame follows the event backlog and carries the current revision.
- **Doctor:** a unit test per check, with fake environment probes, including the missing config, a remote-only app, a port held by an ironbird daemon with and without a token, a port held by something else, and the exit codes.
- **bare-redux:**
  - Unit and headless scenario tests in the unit and serial projects.
  - The CI compat job.
  - One device run on the iPhone 17, by hand, with evidence in the evals record.
- **Proxy eval:** the grader's pure checks get unit tests.

## 12. Risks

| Risk | Mitigation |
|---|---|
| A bare React Native 0.87 iOS build on this Mac fails, through CocoaPods or Xcode 27 | The device run is evidence, not a CI gate; a failure is recorded with its cause, and headless and CI coverage still stand |
| A generated compat project is flaky, through registry fetches or a CLI release that drifts from its pin | The CLI version is pinned per leg and the generated projects live outside the workspace, so the committed lockfile is untouched. A fetch failure is retried once; anything else fails the leg |
| The integration proxy overstates human ease | It is labeled a proxy everywhere, and the human criterion stays unticked, pending the maintainer's trial, which gates the 0.1.0 release |
| Sampled `watch` hides intermediate states | Documented. `events --follow` shows every recorded event when full history matters |
| An XState restore re-runs invoked effects | Documented in api.md and covered by a test that records it |

## 13. Review resolution

| Codex finding | Resolved in |
|---|---|
| 1. XState restore leaves the target on a stopped actor | D2, §3 |
| 2. The matrix doesn't prove two bare React Native versions | D7, D8, §8 |
| 3. Snapshot saving substitutes placeholders | D4, D12, §4 |
| 4. Redux restore persists the projection and can't detect the wrapper | D1 |
| 5. XState restore has no failure or lifecycle contract | §3 |
| 6. `watch` can miss a change at startup | D5, §5 Startup |
| 7. `watch` sequencing and path rules | §5 Steady state and Values and patches |
| 8. The Zod 3 migration text is inconsistent | D9 |
| 9. App matching applies only to the CLI file | D12, §4 |
| 10. `doctor` promises more than the loader supplies | §6 |
| 11. Release and exit-gate ordering | §1, D10, §9 |

A later codex review of the five implementation plans changed one rule here: §5's steady state now reads again after any frame that arrives during a read, whatever its `rev`, because an equal revision after a `reset`, a `reload`, or coalescing can carry a different state. D5's summary says the same.
