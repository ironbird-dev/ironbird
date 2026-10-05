# M5 bare-redux and Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `examples/bare-redux`, a bare React Native 0.87 to-do app on Redux Toolkit with a planted acknowledgement-ordering bug, wired with `@ironbird/redux` (including restore), a headless entry, the bridge, and scenarios; a generator for its ironbird-free `integration-exercise/` copy with the task sheet, checklist, and results sheet, whose single source is `examples/bare-redux/exercise/`; the `compat` CI job (React Native 0.86 and 0.87 in freshly generated bare projects, Expo SDK 57 through the checkout example) that `check` requires; and one hand-run iOS build on the iPhone 17 recorded as evidence.

**Architecture:** The app is built first without ironbird (store, middleware, simulated sync server, screen), then wired: commands map to the app's existing action creators through `fromStore`'s `toAction`, the root reducer is wrapped with `withIronbirdRestore`, and a `defineFake` sync fake reuses the simulated server's timing. Lines that exist only for ironbird or for this monorepo sit between `// exercise:begin-remove` / `// exercise:else` / `// exercise:end` markers, so `scripts/make-exercise.mjs` derives the exercise copy mechanically and a unit test proves the committed copy matches. The exercise's material files (`README.md`, `TASK.md`, `CHECKLIST.md`, `RESULTS.md`, `acceptance.yaml`) live in `exercise/`, their single source of truth; the generator copies them into the copy, and the same byte-for-byte test covers them. The compat legs are Node scripts under `scripts/compat/` with their pure parts unit-tested; CI runs them in a matrix.

**Tech Stack:** React Native 0.87.1 (community template 0.87.2, community CLI 20.2.0), Redux Toolkit 2.13, react-redux 9.3, react-native-safe-area-context 5, Metro 0.87 in a pnpm 12 workspace, Zod 4, `@ironbird/core`, `@ironbird/redux` (plan 1), `@ironbird/react-native`, `@ironbird/cli`, `@ironbird/testing`, Vitest 5 (`unit` and `serial` projects), GitHub Actions, CocoaPods 1.16 and Xcode 27 (hand run only).

**Spec:** [docs/superpowers/specs/2026-10-04-m5-adapters-and-0.1-design.md](../specs/2026-10-04-m5-adapters-and-0.1-design.md). This plan implements D7, D8, §8, the "bare-redux" rows of §11, the §1 exit-criterion measurement "CI passes on the two most recent React Native minor versions and the current Expo SDK" (its bundle evidence), and the material for criterion 1 (the integration exercise). Cross-plan names: `.superpowers/sdd/m5-contract.md` (not committed), "Plan 4: bare-redux and compat".

**Prerequisites:** Branch `m5-adapters-and-0.1`, with plans 2 (snapshots and watch), 1 (adapters), and 3 (doctor) already landed, in that order (contract). From plan 1 this plan uses `@ironbird/redux`'s `fromStore` and `withIronbirdRestore`; from plan 2, `INVALID_SNAPSHOT` and `ironbird snapshot save|load`. Run `pnpm install && pnpm build` once before Task 1. Never switch branches.

## Verified external facts

Checked on 2026-10-04 with `npm view`, by unpacking the template and CLI tarballs in a scratch directory, and by reading the installed Metro 0.84.5:

| Fact | Value |
|---|---|
| `react-native` dist-tags | `latest` 0.87.1, `0.86-stable` 0.86.3, `next` 0.88.0-rc.3. So the two most recent minors are 0.86 (latest patch 0.86.3) and 0.87 (latest patch 0.87.1) |
| `react-native` engines | 0.87.1: `node ^22.13.0 \|\| ^24.3.0 \|\| >=26.0.0`; 0.86.3: `^20.19.4 \|\| ^22.13.0 \|\| ^24.3.0 \|\| >=25.0.0`. Both peer on `react ^19.2.3` |
| `@react-native-community/template` | `latest` 0.87.2. Template 0.86.3 declares `react-native 0.86.3`, `@react-native-community/cli 20.1.0`, `typescript ^5.8.3`. Templates 0.87.1 and 0.87.2 both declare `react-native 0.87.1`, CLI `20.2.0`, `typescript ^6.0.3`. Template 0.87.2's `scripts.version` is `0.87.1` |
| Template choice | CLI 20.2.0's `init --version X` asks the registry for the template versions whose `scripts.version` (or `scripts.reactNativeVersion`) equals X and takes the last published, so `--version 0.87.1` gets template 0.87.2 and `--version 0.86.3` gets template 0.86.3 |
| `@react-native-community/cli` | `latest` 20.2.0, engines `node >=20.19.4`. `init` options: `--version`, `--template`, `--pm` (npm default), `--directory`, `--title`, `--skip-install`, `--install-pods [boolean]`, `--package-name` (Android package and iOS `PRODUCT_BUNDLE_IDENTIFIER`, at least two dot segments), `--platform-name`, `--skip-git-init`, `--replace-directory` |
| Template files (0.87.2) | `App.tsx` (uses `@react-native/new-app-screen` and `react-native-safe-area-context`), `Gemfile`, `README.md`, `__tests__/App.test.tsx`, `_bundle/config`, `_eslintrc.js`, `_gitignore`, `_prettierrc.js`, `_watchmanconfig` (renamed to dotfiles by `init`), `android/**` (including the binary `gradle-wrapper.jar` and `debug.keystore`), `app.json`, `babel.config.js` (`module:@react-native/babel-preset`), `index.js`, `ios/HelloWorld.xcodeproj`, `ios/HelloWorld/*` (Swift `AppDelegate`), `ios/Podfile`, `ios/_xcode.env`, `jest.config.js`, `metro.config.js` (`mergeConfig(getDefaultConfig(__dirname), {})`), `package.json`, `tsconfig.json` (extends `@react-native/typescript-config`) |
| Template `index.js` | `import { AppRegistry } from 'react-native'; import App from './App'; import { name as appName } from './app.json'; AppRegistry.registerComponent(appName, () => App);` under a `@format` doc comment |
| Template `.gitignore` | Ignores `build/`, `*.jsbundle`, `**/Pods/`, `**/.xcode.env.local`, `/vendor/bundle/`, `node_modules/`, `*.keystore` except `debug.keystore` |
| Template `Gemfile` | `cocoapods >= 1.13, != 1.15.0, != 1.15.1`, `xcodeproj < 1.26.0`, `activesupport >= 6.1.7.5, != 7.1.0`, `concurrent-ruby < 1.3.4`, plus `bigdecimal logger benchmark mutex_m nkf` for Ruby 3.4. The `Podfile` resolves `react-native/scripts/react_native_pods.rb` through `node -p require.resolve(...)` |
| `@react-native/typescript-config@0.87.1` | `types: ["jest"]`, `module esnext`, `moduleResolution bundler`, `customConditions ["react-native"]`, `jsx react-native`, `noEmit`, `strict`, `allowImportingTsExtensions`, `resolveJsonModule`, `skipLibCheck`, `lib` es2019 plus es2020–es2022 pieces including `es2022.array` (so `Array.prototype.at` types) |
| Redux | `@reduxjs/toolkit` 2.13.0 (deps `immer ^11`, `redux ^5.0.1`, `redux-thunk ^3.1`, `reselect ^5.1`; optional peers `react`, `react-redux`); `react-redux` 9.3.0 (peers `react ^18 \|\| ^19`, `redux ^5`, `@types/react`); `redux` 5.0.1 |
| Expo | `expo` `latest` = `sdk-57` = 57.0.26. The workspace resolves `expo` 57.0.23 and `react-native` 0.86.3 for `examples/checkout` |
| Metro, release builds | The transform worker runs `inlinePlugin` (replaces `__DEV__` with the build's `dev` value) and then, when not dev, `constantFoldingPlugin`, **before** collecting dependencies, so `if (__DEV__) { require(...) }` drops that module from release bundles |
| Metro, dev bundles | Each module's `verboseName` is `path.relative(projectRoot, module.path)`, so a dev bundle names the resolved package directories (under pnpm, `.pnpm/react-native@<version>_...`) |
| Workspace hazard | `packages/react-native/node_modules/react-native` links `react-native@0.86.3` (pnpm auto-installs the bridge's peer), so a Metro build of a 0.87 app that resolves `react-native` from `packages/react-native/dist` would bundle a second, older copy |
| `verify-bundle` | Exits 0 when the marker is absent, 1 when found, 2 when a path doesn't exist; prints `{ scanned, found: [{ file, offset }] }` (docs/cli.md) |
| Local toolchain | Node 22.14.0, pnpm 12.4.1, Xcode 27.0 (27A266a), CocoaPods 1.16.2 (warns unless `LANG=en_US.UTF-8`), Ruby 3.4.2, watchman installed. Simulator iPhone 17 `9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6` is available and booted; another "iPhone 17" (`3618DB9F-…`) is unavailable |

Not verified here (no packages were installed): Redux Toolkit's exact middleware and reducer generics under TypeScript 6, and whether CocoaPods 1.16.2 and Xcode 27 build React Native 0.87.1 inside a pnpm workspace. Tasks 1 and 6 carry decision rules for both.

## Global Constraints

Copied from [AGENTS.md](../../../AGENTS.md) hard rules (every task's requirements include these):

1. `@ironbird/core` imports only `zod`. No `react-native`, no `node:*` modules, no DOM or browser globals. It must run unmodified in Node and Hermes. Lint enforces this.
2. No arbitrary code execution anywhere. No `eval`, no `new Function`, and no protocol operation that runs caller-supplied code. Agents act only through declared commands and fake controls ([ADR-0001](../../adr/0001-commands-only-agent-surface.md)).
3. The bridge stays dev-only. `startBridge` must no-op when `__DEV__` is false unless `allowInNonDevBuilds` is set, and the bridge marker must stay referenced in the `hello` message so `ironbird verify-bundle` can detect it after minification. The marker constant is defined in `@ironbird/react-native` and nowhere else: `@ironbird/core` ships in release bundles, so the string must not appear in it or in any other package.
4. Validate every payload where it is applied, including inside the app. Never trust the daemon.
5. Protocol changes update [docs/protocol.md](../../protocol.md) in the same PR. Breaking changes bump `PROTOCOL_VERSION` and need an ADR.
6. Public API or CLI changes update [docs/api.md](../../api.md) or [docs/cli.md](../../cli.md) in the same PR and include a changeset.
7. New runtime dependencies in `core` or `react-native` need an ADR. New dependencies in `cli` need a one-line justification in the PR.
8. Errors that cross a package boundary are `IronbirdError` with a code from the protocol error table. No bare string throws.
9. Headless determinism is a feature. Library code and example app logic take time from the injected `Clock`, never from global `setTimeout`, `setInterval`, or `Date.now`. The bridge is library code too: it uses the `Clock` passed to `startBridge`, which defaults to the real clock. `requestAnimationFrame` is a rendering signal rather than a clock and may be used directly. Inside `@ironbird/core`, `clock.ts` and `scheduler.ts` are the only files that may use global timers or `Date.now`, and lint enforces that.

From the spec and the contract:

- `examples/bare-redux` is a bare React Native **0.87** app (pinned `react-native 0.87.1`) made from the community template with Redux Toolkit, a to-do domain, and a planted bug where "a fake sync API reorders acknowledgements" (D7). It is wired with `@ironbird/redux` **including `restore`**, a headless entry, the bridge, and scenarios. It is not the compat matrix's subject.
- `examples/bare-redux/integration-exercise/` is the same app with every ironbird file and line removed, **generated by a script so the two cannot drift** (D7). Never edit it by hand; run `pnpm --filter @ironbird-examples/bare-redux make:exercise` and commit the result.
- The exercise's material files, `README.md`, `TASK.md`, `CHECKLIST.md`, `RESULTS.md`, and `acceptance.yaml`, have one source of truth: `examples/bare-redux/exercise/`. The generator copies them into `integration-exercise/`, and its byte-for-byte drift test covers the copies, so a hand edit to a copy fails the test. Anyone changing them, plan 5 included, edits the sources in `exercise/` and reruns `make:exercise`.
- App code outside `src/ironbird/` (`App.tsx`, `index.js`, `metro.config.js`, `src/app/`, `src/store/`, `src/sync/`) mentions "ironbird" only inside exercise markers, comments included. The generator's leak check enforces it.
- The CI job is named `compat`, with three legs: React Native 0.86 and 0.87, each generating a fresh bare project with that minor's community CLI **pinned in the workflow matrix**, and Expo SDK 57 through the checkout example. `check` requires `compat` (D8).
- React Native legs follow §8 steps 1–7 in a temporary directory **outside the workspace**, installing `@ironbird/core` and `@ironbird/react-native` from tarballs made by `pnpm pack` in the same run. The Expo leg asserts the resolved `expo` and `react-native` versions, runs `expo export`, and runs `verify-bundle`, which must be clean.
- A fetch failure is retried once; anything else fails the leg (§12). The fetch steps, template `init` and `npm install`, run under bounded time limits (`STEP_TIMEOUT_MS`), and one that hits its limit is killed and classified as a `fetch-timeout`, which gets the same single retry, so a stalled registry fetch never consumes the whole job. The job's `timeout-minutes` is set from the measured cold-run time (Task 5 Steps 6 and 7).
- The compat results are reported as **JavaScript-bundle evidence**; native-build evidence is only the hand-run iOS build (§1, §8).
- The hand-run iOS build targets the iPhone 17 simulator `9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6` and **never the iPhone 18 Pro**. Device runs and native builds are not in CI. Android builds of `bare-redux` are out of scope (§1).
- App id `com.example.bareredux` everywhere (config, bridge, iOS bundle id, Android package).
- Nothing published changes in this plan, so it adds no changeset. New dependencies land only in the private example, so rule 7 needs no ADR or justification line; the PR says so.
- Durations are milliseconds. Named exports only, except `ironbird.config.ts` and the headless definition. Tests live next to code as `*.test.ts`, or in `test/` for daemon and Metro tests (serial project).
- Commit messages are plain imperative subjects with no attribution trailers. Never commit `.superpowers/`, anything from a scratchpad, `ios/Pods`, `ios/build`, `ios/Podfile.lock`, or `ios/*.xcworkspace`.
- Packages import each other from `dist`. Run `pnpm build` before the example's tests whenever a package changed; the example's tests import `@ironbird/core`, `@ironbird/redux`, `@ironbird/testing`, and run `packages/cli/dist/bin.js`.
- Run `pnpm test` under Node 22 and Node 26 before the final commit; CI runs both.

## Review Focus

The inputs the spec implies but no spec test names, most likely to bite a person first. Each has a test in the task that owns the code.

1. **An acknowledgement for a to-do the state no longer has, or one that arrives when nothing is counted in flight** (after `snapshot load` replaced the state, or a duplicate from the server). It must be ignored for the to-dos and never drive `sync.inFlight` below zero (Task 1, "never counts below zero and ignores acknowledgements for unknown ids"; Task 2, "survives an acknowledgement for a to-do the restored state does not have").
2. **Two copies of `react-native` in the monorepo bundle.** The bridge package's own dev install links React Native 0.86.3; a 0.87 app that bundled both would crash or misbehave on device. The dev bundle must contain only 0.87.1 (Task 3, "ships the bridge in the dev bundle with exactly one react-native").
3. **Malformed exercise markers** (a block never closed, an `else` line left uncommented, a stray or nested marker) and **leftover ironbird lines**. Generation must fail loudly, naming file and line, rather than ship a copy that doesn't compile or still contains ironbird (Task 4, the `transformSource` error tests and the leak check).
4. **A snapshot whose shape is close but wrong**: an extra top-level key, a negative count, a malformed id. `snapshot load` must refuse it with `INVALID_SNAPSHOT` and leave the store exactly as it was (Task 2, "refuses a snapshot with an extra key or a wrong type"; schema test).
5. **A registry blip during a compat leg versus a real failure.** A network error during `init` or `npm install`, or either step stalling past its time limit, is retried once; a version mismatch, a failed typecheck, or a bundle that leaks the bridge is never retried and fails the leg (Task 5, `retryOnFetchFailure`, `isFetchFailure`, and `classifyFailure` tests).

---

## File Structure

```text
examples/bare-redux/
  .bundle/config, .gitignore, .watchmanconfig, Gemfile, app.json, babel.config.js   from the template (.gitignore gains two CocoaPods lines)
  android/**, ios/**                       from the template, BareRedux, com.example.bareredux
  package.json                             @ironbird-examples/bare-redux, private, workspace deps
  tsconfig.json                            app code; standalone-safe (copied into the exercise)
  tsconfig.test.json                       tests and ironbird.config.ts, with Node types
  metro.config.js                          monorepo block between exercise markers
  index.js                                 template entry + dev-only bridge block between markers
  App.tsx                                  the to-do screen
  ironbird.config.ts                       appId com.example.bareredux, headless entry
  README.md                                the example's guide
  src/sync/port.ts                         SavedTodo, SyncAck, SyncPort
  src/sync/server.ts                       Timers, SLOW_ACK_MS, FAST_ACK_MS, createSimulatedServer
  src/sync/real-timers.ts                  createRealTimers: the real clock injected into the server (core's real clock; the exercise's own in its copy)
  src/store/todos.ts                       AppState, Todo, action creators, createRootReducer (planted bug)
  src/store/middleware.ts                  createSyncMiddleware
  src/store/store.ts                       createAppStore, AppPorts, AppStoreOptions, AppStore, AppDispatch
  src/app/instance.ts                      the device store (ironbird wiring between markers)
  src/ironbird/commands.ts                 todos.add, todos.toggle, todos.rename
  src/ironbird/schema.ts                   appStateSchema (root state, for restore)
  src/ironbird/target.ts                   toAction, toTarget (fromStore with restore)
  src/ironbird/fakes/sync.ts               fakeSync: alternating timer, manual mode, release
  src/ironbird/headless.ts                 the headless definition (PLANT_BUG)
  src/ironbird/device.ts                   startIronbird (bridge)
  src/**/*.test.ts                         unit tests
  ironbird/scenarios/*.yaml                add-and-sync, ack-reorder, auto-reorder
  test/cli.test.ts                         serial: a real daemon over the headless entry
  test/bundle.test.ts                      serial: Metro release and dev bundles + verify-bundle
  exercise/README.md, TASK.md, CHECKLIST.md, RESULTS.md, acceptance.yaml  exercise material: the single source, copied by the generator
  scripts/lib/exercise.mjs (+ .test.mjs)   generator, markers, leak check, drift helpers
  scripts/make-exercise.mjs                writes integration-exercise/
  integration-exercise/**                  generated, committed
scripts/pack-packages.mjs (+ .test.mjs)    pnpm pack for named @ironbird packages
scripts/compat/lib.mjs (+ .test.mjs)       pure helpers for the compat legs
scripts/compat/proc.mjs                    run with retry, verify-bundle, step summary
scripts/compat/bare-leg.mjs                one React Native leg (§8 steps 1–7)
scripts/compat/expo-leg.mjs                the Expo SDK 57 leg
.github/workflows/ci.yml                   compat job; check needs it
vitest.config.ts                           unit and serial includes
eslint.config.js                           ignores and the bare-redux entry/config block
pnpm-lock.yaml                             the example's dependencies
AGENTS.md                                  repository layout line for bare-redux
docs/evals/m5-compat-and-ios.md            local compat runs and the iOS build evidence
```

---

### Task 1: Scaffold the bare app and build the to-do core

The app as it would exist before anyone added ironbird: template, workspace integration, Redux store, sync middleware, simulated server, and the screen. No app logic touches a platform timer (rule 9): the device store injects a real clock, `createRealTimers()` from `src/sync/real-timers.ts`, into the simulated server. In this repository that adapter is `@ironbird/core`'s `createRealClock()`, behind exercise markers; the generated exercise gets the marker's `else` branch instead, a minimal real clock that is the only place in the exercise's app code that calls the platform timer. Task 3 moves the device store's own ironbird wiring behind markers.

**Files:**
- Create (from the template): `examples/bare-redux/{.bundle/config,.gitignore,.watchmanconfig,Gemfile,app.json,babel.config.js,index.js}`, `examples/bare-redux/android/**`, `examples/bare-redux/ios/**`
- Create: `examples/bare-redux/package.json`, `tsconfig.json`, `tsconfig.test.json`, `metro.config.js`, `App.tsx`
- Create: `examples/bare-redux/src/sync/port.ts`, `src/sync/server.ts`, `src/sync/server.test.ts`, `src/sync/real-timers.ts`
- Create: `examples/bare-redux/src/store/todos.ts`, `src/store/todos.test.ts`, `src/store/middleware.ts`, `src/store/store.ts`, `src/store/store.test.ts`
- Create: `examples/bare-redux/src/app/instance.ts`
- Modify: `eslint.config.js`, `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `createManualClock` from `@ironbird/core` (tests); `createRealClock` from `@ironbird/core` (only in `src/sync/real-timers.ts`, inside exercise markers).
- Produces:
  - `src/sync/port.ts`: `interface SavedTodo { id: string; title: string; done: boolean; rev: number }`, `interface SyncAck { id: string; rev: number }`, `interface SyncPort { save(todo: SavedTodo): Promise<SyncAck> }`.
  - `src/sync/server.ts`: `interface Timers { setTimeout(callback: () => void, ms: number, label?: string): unknown }`, `SLOW_ACK_MS = 300`, `FAST_ACK_MS = 100`, `createSimulatedServer(timers: Timers): SyncPort` (odd-numbered saves 300 ms, even-numbered 100 ms, timer label `sync.ack`).
  - `src/store/todos.ts`: `interface Todo { id; title; done; rev; syncedRev }`, `interface AppState { todos: { items: Todo[]; nextId: number }; sync: { inFlight: number; lastError: string | null } }`, action creators `added({ title })` (`todos/added`), `toggled({ id })` (`todos/toggled`), `renamed({ id, title })` (`todos/renamed`), `saveStarted({ id, rev })` (`sync/saveStarted`), `saveAcked({ id, rev })` (`sync/saveAcked`), `saveFailed({ id, rev, reason })` (`sync/saveFailed`), `initialState: AppState`, `interface ReducerOptions { plantBug?: boolean }`, `createRootReducer(options?: ReducerOptions): Reducer<AppState>`.
  - `src/store/middleware.ts`: `createSyncMiddleware(sync: SyncPort): Middleware<object, AppState>`; an edit to a missing id throws `Error('No to-do with id <id>')` before the reducer runs.
  - `src/store/store.ts`: `interface AppPorts { sync: SyncPort }`, `interface AppStoreOptions { plantBug?: boolean; wrapReducer?: (reducer: Reducer<AppState>) => Reducer<AppState> }`, `createAppStore(ports: AppPorts, options?: AppStoreOptions)`, `type AppStore = ReturnType<typeof createAppStore>`, `type AppDispatch = AppStore['dispatch']`.
  - `src/sync/real-timers.ts`: `createRealTimers(): Timers`, the real clock the device store injects into the simulated server. Wired app: returns `createRealClock()`; exercise copy (the `else` branch): `{ setTimeout: (callback, ms) => setTimeout(callback, ms) }`, the exercise's only platform-timer call.
  - `src/app/instance.ts`: `export const store: AppStore`, built with `createSimulatedServer(createRealTimers())`.

- [ ] **Step 1: Generate the project from the community template**

Run from the repository root (network required):

```sh
SCRATCH="$(mktemp -d -t ironbird-bare-redux-template)"
npx --yes @react-native-community/cli@20.2.0 init BareRedux --version 0.87.1 --directory "$SCRATCH/BareRedux" --package-name com.example.bareredux --pm npm --skip-install --skip-git-init --install-pods false
node -p "const p = require('$SCRATCH/BareRedux/package.json'); [p.dependencies['react-native'], p.devDependencies['@react-native-community/cli']].join(' ')"
grep -c 'PRODUCT_BUNDLE_IDENTIFIER = "com.example.bareredux"' "$SCRATCH/BareRedux/ios/BareRedux.xcodeproj/project.pbxproj"
```

Expected: the `node -p` line prints `0.87.1 20.2.0`; `grep -c` prints `2`. If `init` fails with a network error, run the same `npx` command once more; any other failure is a real problem to fix before going on (for example a flag the CLI rejects: check `npx --yes @react-native-community/cli@20.2.0 init --help`).

- [ ] **Step 2: Copy the template into the workspace**

```sh
mkdir -p examples/bare-redux
rsync -a \
  --exclude node_modules --exclude __tests__ --exclude jest.config.js --exclude .eslintrc.js --exclude .prettierrc.js \
  --exclude App.tsx --exclude README.md --exclude package.json --exclude tsconfig.json --exclude metro.config.js \
  "$SCRATCH/BareRedux/" examples/bare-redux/
rm -rf "$SCRATCH"
cat >> examples/bare-redux/.gitignore <<'EOF'

# Written by `pod install`; regenerate them instead of committing them.
ios/Podfile.lock
ios/*.xcworkspace
EOF
git status --short --untracked-files=all examples/bare-redux | sed 's|examples/bare-redux/||' | awk '{print $2}' | sed 's|/.*||' | sort -u
```

Expected top-level entries: `.bundle`, `.gitignore`, `.watchmanconfig`, `Gemfile`, `android`, `app.json`, `babel.config.js`, `index.js`, `ios`. The template's Jest, ESLint 8, and Prettier setup and its `NewAppScreen` aren't copied: the monorepo lints with its own ESLint 10 config and tests with Vitest, and the example's screen is exercised on the device rather than by component tests (AGENTS.md, Tooling).

- [ ] **Step 3: Write `package.json`, the two tsconfigs, and the Metro config**

Create `examples/bare-redux/package.json`:

```json
{
  "name": "@ironbird-examples/bare-redux",
  "private": true,
  "license": "MIT",
  "version": "0.0.0",
  "scripts": {
    "android": "react-native run-android",
    "ios": "react-native run-ios",
    "start": "react-native start",
    "bundle:release": "mkdir -p build && react-native bundle --platform ios --dev false --entry-file index.js --bundle-output build/main.jsbundle --assets-dest build",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json",
    "test": "vitest run --project unit"
  },
  "dependencies": {
    "@ironbird/core": "workspace:*",
    "@ironbird/react-native": "workspace:*",
    "@ironbird/redux": "workspace:*",
    "@reduxjs/toolkit": "^2.13.0",
    "react": "19.2.3",
    "react-native": "0.87.1",
    "react-native-safe-area-context": "^5.5.2",
    "react-redux": "^9.3.0",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@babel/core": "^7.25.2",
    "@babel/preset-env": "^7.25.3",
    "@babel/runtime": "^7.25.0",
    "@ironbird/cli": "workspace:*",
    "@ironbird/testing": "workspace:*",
    "@react-native-community/cli": "20.2.0",
    "@react-native-community/cli-platform-android": "20.2.0",
    "@react-native-community/cli-platform-ios": "20.2.0",
    "@react-native/babel-preset": "0.87.1",
    "@react-native/metro-config": "0.87.1",
    "@react-native/typescript-config": "0.87.1",
    "@types/react": "~19.2.18"
  },
  "engines": {
    "node": ">= 22.11.0"
  }
}
```

No `"type"` field: `metro.config.js` and `babel.config.js` are CommonJS, as in the template. TypeScript comes from the workspace root (6.0.3), as for the checkout example.

Create `examples/bare-redux/tsconfig.json` (it is copied into the exercise as is, so it must not reach outside the app):

```json
{
  "extends": "@react-native/typescript-config",
  "compilerOptions": {
    "types": [],
    "jsx": "react-jsx",
    "noUncheckedIndexedAccess": true
  },
  "include": ["App.tsx", "src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["**/*.test.ts"]
}
```

`types: []` replaces the template's `["jest"]`, which would need `@types/jest`.

Create `examples/bare-redux/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src/**/*.test.ts", "test/**/*.ts", "ironbird.config.ts"],
  "exclude": []
}
```

Create `examples/bare-redux/metro.config.js`:

```js
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// exercise:begin-remove
// This app lives in the ironbird monorepo. pnpm links its dependencies into the workspace root's
// node_modules/.pnpm and links the ironbird packages to packages/*/dist, so Metro watches both
// folders and falls back to this app's node_modules for helpers that compiled package code
// imports, such as @babel/runtime. react and react-native always resolve to this app's copies:
// @ironbird/react-native's own development install links another react-native (0.86.3, for the
// checkout example), and two copies in one bundle break the app.
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const singletons = ['react', 'react-native'];
const isSingleton = (name) => singletons.some((singleton) => name === singleton || name.startsWith(`${singleton}/`));

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: [path.join(workspaceRoot, 'node_modules'), path.join(workspaceRoot, 'packages')],
  resolver: {
    nodeModulesPaths: [path.join(projectRoot, 'node_modules'), path.join(workspaceRoot, 'node_modules')],
    // The generated exercise copy is a second app inside this one; Metro must not crawl it.
    blockList: [/[/\\]integration-exercise[/\\]/],
    resolveRequest: (context, moduleName, platform) =>
      context.resolveRequest(isSingleton(moduleName) ? { ...context, originModulePath: path.join(projectRoot, 'index.js') } : context, moduleName, platform),
  },
};
// exercise:else
// /**
//  * Metro configuration
//  * https://reactnative.dev/docs/metro
//  *
//  * @type {import('@react-native/metro-config').MetroConfig}
//  */
// const config = {};
// exercise:end

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
```

The markers are inert until Task 4's generator reads them; the `else` branch is the template's own config.

- [ ] **Step 4: Teach ESLint about the bare app**

In `eslint.config.js`, extend the first `ignores` array with `'**/ios/Pods/**', '**/ios/build/**', '**/android/build/**', '**/android/app/build/**', '**/vendor/bundle/**'`. Then add this block right after the `examples/checkout/index.js` block:

```js
  {
    // The bare React Native example and its generated exercise copy: Metro's entry, where `__DEV__`
    // is a Metro-injected global and the dev-only require() must stay synchronous so release bundles
    // drop it, and the CommonJS config files Metro and Babel load.
    files: [
      'examples/bare-redux/index.js',
      'examples/bare-redux/*.config.js',
      'examples/bare-redux/integration-exercise/index.js',
      'examples/bare-redux/integration-exercise/*.config.js',
    ],
    languageOptions: { globals: { ...globals.node, ...globals['react-native'] } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // AGENTS.md rule 9 for the bare example's app logic, wired and generated: time comes from an
    // injected clock. The one platform-timer call allowed is the exercise copy's real-clock adapter,
    // src/sync/real-timers.ts; in the wired app that file uses @ironbird/core's real clock instead.
    files: ['examples/bare-redux/App.tsx', 'examples/bare-redux/src/**/*.ts', 'examples/bare-redux/integration-exercise/App.tsx', 'examples/bare-redux/integration-exercise/src/**/*.ts'],
    ignores: ['examples/bare-redux/**/*.test.ts', 'examples/bare-redux/integration-exercise/src/sync/real-timers.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate'].map((name) => ({
          name,
          message: 'Take time from the injected clock (AGENTS.md hard rule 9); only the real-clock adapter, src/sync/real-timers.ts, may call the platform timer.',
        })),
      ],
      'no-restricted-properties': ['error', { object: 'Date', property: 'now', message: 'Take time from the injected clock (AGENTS.md hard rule 9).' }],
    },
  },
```

- [ ] **Step 5: Install and check the resolved versions**

```sh
pnpm install
node -e "const r = require('module').createRequire(require('path').resolve('examples/bare-redux/package.json')); for (const p of ['react-native', 'react', '@reduxjs/toolkit', 'react-redux']) console.log(p, r(p + '/package.json').version)"
```

Expected: `react-native 0.87.1`, `react 19.2.3`, `@reduxjs/toolkit 2.13.x`, `react-redux 9.3.x`. Decision rule for pnpm's build-script report: if `pnpm install` prints "Ignored build scripts" for a new package, add it to `allowBuilds` in `pnpm-workspace.yaml` as `false` with a one-line comment naming why it isn't needed (nothing in this plan needs a dependency's install script: bundling and typechecking are pure JavaScript, and `pod install` runs its own steps). Re-run `pnpm install` until it reports nothing ignored.

- [ ] **Step 6: Write the failing simulated-server test**

Create `examples/bare-redux/src/sync/server.test.ts`:

```ts
import { createManualClock } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { SyncAck } from './port';
import { FAST_ACK_MS, SLOW_ACK_MS, createSimulatedServer } from './server';

const todo = (rev: number) => ({ id: 't1', title: 'Buy milk', done: rev % 2 === 0, rev });

describe('the simulated sync server', () => {
  it('alternates a slow and a fast acknowledgement, so a quick second save is acknowledged first', async () => {
    const clock = createManualClock();
    const server = createSimulatedServer(clock);
    const acks: SyncAck[] = [];
    void server.save(todo(1)).then((ack) => acks.push(ack));
    void server.save(todo(2)).then((ack) => acks.push(ack));
    expect(clock.timers().map((timer) => timer.label)).toEqual(['sync.ack', 'sync.ack']);

    await clock.advance(FAST_ACK_MS);
    expect(acks).toEqual([{ id: 't1', rev: 2 }]);
    await clock.advance(SLOW_ACK_MS - FAST_ACK_MS);
    expect(acks).toEqual([
      { id: 't1', rev: 2 },
      { id: 't1', rev: 1 },
    ]);
  });

  it('keeps alternating: the third save is slow again', async () => {
    const clock = createManualClock();
    const server = createSimulatedServer(clock);
    const acks: number[] = [];
    for (const rev of [1, 2, 3]) void server.save(todo(rev)).then((ack) => acks.push(ack.rev));
    await clock.advance(FAST_ACK_MS);
    expect(acks).toEqual([2]);
    await clock.advance(SLOW_ACK_MS - FAST_ACK_MS);
    expect(acks).toEqual([2, 1, 3]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/sync/server.test.ts`
Expected: FAIL, cannot resolve `./server`.

- [ ] **Step 8: Write the port and the server**

Create `examples/bare-redux/src/sync/port.ts`:

```ts
/** What the app sends to the sync API: one to-do at one revision. */
export interface SavedTodo {
  id: string;
  title: string;
  done: boolean;
  rev: number;
}

/** The sync API's acknowledgement of one save. */
export interface SyncAck {
  id: string;
  rev: number;
}

/** The app's only way to reach the sync API. */
export interface SyncPort {
  save(todo: SavedTodo): Promise<SyncAck>;
}
```

Create `examples/bare-redux/src/sync/server.ts`:

```ts
import type { SavedTodo, SyncAck, SyncPort } from './port';

/** The timer the simulated server waits on. Any timer with this shape works, including a test clock. */
export interface Timers {
  setTimeout(callback: () => void, ms: number, label?: string): unknown;
}

/** How long the 1st, 3rd, 5th, ... save takes to be acknowledged. */
export const SLOW_ACK_MS = 300;
/** How long the 2nd, 4th, 6th, ... save takes to be acknowledged. */
export const FAST_ACK_MS = 100;

/**
 * A stand-in for the sync backend. It acknowledges every save, alternating a slow and a fast reply,
 * so two saves less than SLOW_ACK_MS - FAST_ACK_MS apart are acknowledged newest first: the
 * reordering a real network produces, which the app has to handle.
 */
export function createSimulatedServer(timers: Timers): SyncPort {
  let saves = 0;
  return {
    save(todo: SavedTodo): Promise<SyncAck> {
      saves += 1;
      const delay = saves % 2 === 1 ? SLOW_ACK_MS : FAST_ACK_MS;
      return new Promise((resolve) => {
        timers.setTimeout(() => resolve({ id: todo.id, rev: todo.rev }), delay, 'sync.ack');
      });
    },
  };
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/sync/server.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 10: Write the failing reducer test**

Create `examples/bare-redux/src/store/todos.test.ts`:

```ts
import type { Reducer, UnknownAction } from '@reduxjs/toolkit';
import { describe, expect, it } from 'vitest';
import { added, createRootReducer, initialState, renamed, saveAcked, saveFailed, saveStarted, toggled, type AppState } from './todos';

const run = (reducer: Reducer<AppState>, actions: UnknownAction[], from: AppState = initialState): AppState =>
  actions.reduce<AppState>((state, action) => reducer(state, action), from);

// Two saves of t1, acknowledged newest first: the reordering the sync API produces.
const reordered: UnknownAction[] = [
  added({ title: 'Buy milk' }),
  saveStarted({ id: 't1', rev: 1 }),
  toggled({ id: 't1' }),
  saveStarted({ id: 't1', rev: 2 }),
  saveAcked({ id: 't1', rev: 2 }),
  saveAcked({ id: 't1', rev: 1 }),
];

describe('the to-do reducer', () => {
  const reducer = createRootReducer();

  it('starts empty, with ids from t1 and nothing in flight', () => {
    expect(reducer(undefined, { type: '@@init' })).toEqual({ todos: { items: [], nextId: 1 }, sync: { inFlight: 0, lastError: null } });
  });

  it('adds to-dos at revision 1, unsynced, with sequential ids', () => {
    const state = run(reducer, [added({ title: 'Buy milk' }), added({ title: 'Call Sam' })]);
    expect(state.todos).toEqual({
      items: [
        { id: 't1', title: 'Buy milk', done: false, rev: 1, syncedRev: 0 },
        { id: 't2', title: 'Call Sam', done: false, rev: 1, syncedRev: 0 },
      ],
      nextId: 3,
    });
  });

  it('bumps the revision on every toggle and rename', () => {
    const state = run(reducer, [added({ title: 'Buy milk' }), toggled({ id: 't1' }), renamed({ id: 't1', title: 'Buy oat milk' }), toggled({ id: 't1' })]);
    expect(state.todos.items[0]).toEqual({ id: 't1', title: 'Buy oat milk', done: false, rev: 4, syncedRev: 0 });
  });

  it('ignores edits to an id it does not have', () => {
    const before = run(reducer, [added({ title: 'Buy milk' })]);
    expect(run(reducer, [toggled({ id: 't9' }), renamed({ id: 't9', title: 'x' })], before)).toEqual(before);
  });

  it('counts saves in flight and keeps the highest acknowledged revision when acknowledgements arrive out of order', () => {
    const state = run(reducer, reordered);
    expect(state.sync).toEqual({ inFlight: 0, lastError: null });
    expect(state.todos.items[0]).toMatchObject({ rev: 2, syncedRev: 2 });
  });

  it('with the planted bug, lets an older acknowledgement overwrite a newer one', () => {
    const state = run(createRootReducer({ plantBug: true }), reordered);
    expect(state.sync.inFlight).toBe(0);
    expect(state.todos.items[0]).toMatchObject({ rev: 2, syncedRev: 1 });
  });

  it('never counts below zero and ignores acknowledgements for unknown ids', () => {
    const state = run(reducer, [saveAcked({ id: 't7', rev: 3 }), saveFailed({ id: 't7', rev: 3, reason: 'offline' }), saveAcked({ id: 't7', rev: 4 })]);
    expect(state.sync.inFlight).toBe(0);
    expect(state.todos.items).toEqual([]);
  });

  it('records the last failure', () => {
    const state = run(reducer, [added({ title: 'Buy milk' }), saveStarted({ id: 't1', rev: 1 }), saveFailed({ id: 't1', rev: 1, reason: 'offline' })]);
    expect(state.sync).toEqual({ inFlight: 0, lastError: 'Saving t1 failed: offline' });
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/store/todos.test.ts`
Expected: FAIL, cannot resolve `./todos`.

- [ ] **Step 12: Write the reducer**

Create `examples/bare-redux/src/store/todos.ts`:

```ts
import { combineReducers, createAction, createReducer, type Reducer } from '@reduxjs/toolkit';

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  /** Local revision: 1 when added, plus 1 per edit. */
  rev: number;
  /** The highest revision the sync API has acknowledged; 0 before the first acknowledgement. */
  syncedRev: number;
}

export interface AppState {
  todos: { items: Todo[]; nextId: number };
  sync: { inFlight: number; lastError: string | null };
}

export const added = createAction<{ title: string }>('todos/added');
export const toggled = createAction<{ id: string }>('todos/toggled');
export const renamed = createAction<{ id: string; title: string }>('todos/renamed');
export const saveStarted = createAction<{ id: string; rev: number }>('sync/saveStarted');
export const saveAcked = createAction<{ id: string; rev: number }>('sync/saveAcked');
export const saveFailed = createAction<{ id: string; rev: number; reason: string }>('sync/saveFailed');

export const initialState: AppState = {
  todos: { items: [], nextId: 1 },
  sync: { inFlight: 0, lastError: null },
};

export interface ReducerOptions {
  /**
   * The planted bug: an acknowledgement sets syncedRev to its own revision even when a newer one
   * was already acknowledged, so a reordered pair leaves the to-do unsaved with nothing in flight.
   */
  plantBug?: boolean;
}

export function createRootReducer(options: ReducerOptions = {}): Reducer<AppState> {
  const plantBug = options.plantBug ?? false;

  const todos = createReducer(initialState.todos, (builder) => {
    builder
      .addCase(added, (state, action) => {
        state.items.push({ id: `t${state.nextId}`, title: action.payload.title, done: false, rev: 1, syncedRev: 0 });
        state.nextId += 1;
      })
      .addCase(toggled, (state, action) => {
        const todo = state.items.find((item) => item.id === action.payload.id);
        if (!todo) return;
        todo.done = !todo.done;
        todo.rev += 1;
      })
      .addCase(renamed, (state, action) => {
        const todo = state.items.find((item) => item.id === action.payload.id);
        if (!todo) return;
        todo.title = action.payload.title;
        todo.rev += 1;
      })
      .addCase(saveAcked, (state, action) => {
        const todo = state.items.find((item) => item.id === action.payload.id);
        if (!todo) return;
        todo.syncedRev = plantBug ? action.payload.rev : Math.max(todo.syncedRev, action.payload.rev);
      });
  });

  const sync = createReducer(initialState.sync, (builder) => {
    builder
      .addCase(saveStarted, (state) => {
        state.inFlight += 1;
      })
      .addCase(saveAcked, (state) => {
        state.inFlight = Math.max(0, state.inFlight - 1);
      })
      .addCase(saveFailed, (state, action) => {
        state.inFlight = Math.max(0, state.inFlight - 1);
        state.lastError = `Saving ${action.payload.id} failed: ${action.payload.reason}`;
      });
  });

  return combineReducers({ todos, sync });
}
```

Decision rule: if TypeScript rejects `return combineReducers({ todos, sync })` as `Reducer<AppState>` (its preloaded-state parameter type), write `const root: Reducer<AppState> = combineReducers({ todos, sync }); return root;` and, only if that also fails, `return combineReducers({ todos, sync }) as Reducer<AppState>;` with a comment naming the RTK type that differs.

- [ ] **Step 13: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/store/todos.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 14: Write the failing store test**

Create `examples/bare-redux/src/store/store.test.ts`:

```ts
import { createManualClock } from '@ironbird/core';
import type { Reducer } from '@reduxjs/toolkit';
import { describe, expect, it } from 'vitest';
import type { SavedTodo, SyncAck, SyncPort } from '../sync/port';
import { SLOW_ACK_MS, createSimulatedServer } from '../sync/server';
import { createAppStore } from './store';
import { added, renamed, toggled, type AppState } from './todos';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A sync port whose saves the test acknowledges or fails by hand, by save index. */
function manualSync() {
  const saves: SavedTodo[] = [];
  const pending: Array<{ todo: SavedTodo; resolve: (ack: SyncAck) => void; reject: (error: Error) => void }> = [];
  const port: SyncPort = {
    save: (todo) => {
      saves.push(todo);
      return new Promise((resolve, reject) => {
        pending.push({ todo, resolve, reject });
      });
    },
  };
  const at = (index: number) => {
    const entry = pending[index];
    if (!entry) throw new Error(`No save #${index}`);
    return entry;
  };
  return {
    port,
    saves,
    ack: (index: number): void => {
      const { todo, resolve } = at(index);
      resolve({ id: todo.id, rev: todo.rev });
    },
    fail: (index: number, reason: string): void => at(index).reject(new Error(reason)),
  };
}

describe('the app store', () => {
  it('saves a new to-do and marks it saved when the acknowledgement arrives', async () => {
    const sync = manualSync();
    const store = createAppStore({ sync: sync.port });
    store.dispatch(added({ title: 'Buy milk' }));
    expect(sync.saves).toEqual([{ id: 't1', title: 'Buy milk', done: false, rev: 1 }]);
    expect(store.getState().sync.inFlight).toBe(1);

    sync.ack(0);
    await flush();
    expect(store.getState().sync.inFlight).toBe(0);
    expect(store.getState().todos.items[0]).toMatchObject({ rev: 1, syncedRev: 1 });
  });

  it('saves every edit at its new revision', () => {
    const sync = manualSync();
    const store = createAppStore({ sync: sync.port });
    store.dispatch(added({ title: 'Buy milk' }));
    store.dispatch(toggled({ id: 't1' }));
    store.dispatch(renamed({ id: 't1', title: 'Buy oat milk' }));
    expect(sync.saves.map((todo) => [todo.rev, todo.done, todo.title])).toEqual([
      [1, false, 'Buy milk'],
      [2, true, 'Buy milk'],
      [3, true, 'Buy oat milk'],
    ]);
    expect(store.getState().sync.inFlight).toBe(3);
  });

  it('throws on an edit to a missing to-do and changes nothing', () => {
    const sync = manualSync();
    const store = createAppStore({ sync: sync.port });
    store.dispatch(added({ title: 'Buy milk' }));
    const before = store.getState();
    expect(() => store.dispatch(toggled({ id: 't9' }))).toThrow('No to-do with id t9');
    expect(() => store.dispatch(renamed({ id: 't9', title: 'x' }))).toThrow('No to-do with id t9');
    expect(store.getState()).toBe(before);
    expect(sync.saves).toHaveLength(1);
  });

  it('records a failed save and stops counting it', async () => {
    const sync = manualSync();
    const store = createAppStore({ sync: sync.port });
    store.dispatch(added({ title: 'Buy milk' }));
    sync.fail(0, 'offline');
    await flush();
    expect(store.getState().sync).toEqual({ inFlight: 0, lastError: 'Saving t1 failed: offline' });
    expect(store.getState().todos.items[0]).toMatchObject({ rev: 1, syncedRev: 0 });
  });

  it('ends saved at the latest revision when the simulated server acknowledges a quick edit first', async () => {
    const clock = createManualClock();
    const store = createAppStore({ sync: createSimulatedServer(clock) });
    store.dispatch(added({ title: 'Buy milk' }));
    store.dispatch(toggled({ id: 't1' }));
    await clock.advance(SLOW_ACK_MS);
    await flush();
    expect(store.getState().sync.inFlight).toBe(0);
    expect(store.getState().todos.items[0]).toMatchObject({ rev: 2, syncedRev: 2 });
  });

  it('with the planted bug, ends unsaved with nothing in flight after the same reordering', async () => {
    const clock = createManualClock();
    const store = createAppStore({ sync: createSimulatedServer(clock) }, { plantBug: true });
    store.dispatch(added({ title: 'Buy milk' }));
    store.dispatch(toggled({ id: 't1' }));
    await clock.advance(SLOW_ACK_MS);
    await flush();
    expect(store.getState().sync.inFlight).toBe(0);
    expect(store.getState().todos.items[0]).toMatchObject({ rev: 2, syncedRev: 1 });
  });

  it('wraps the root reducer when asked', () => {
    const seen: string[] = [];
    const wrap = (reducer: Reducer<AppState>): Reducer<AppState> => (state, action) => {
      seen.push(action.type);
      return reducer(state, action);
    };
    const store = createAppStore({ sync: manualSync().port }, { wrapReducer: wrap });
    store.dispatch(added({ title: 'Buy milk' }));
    expect(seen).toContain('todos/added');
    expect(seen).toContain('sync/saveStarted');
  });
});
```

- [ ] **Step 15: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/store/store.test.ts`
Expected: FAIL, cannot resolve `./store`.

- [ ] **Step 16: Write the middleware and the store**

Create `examples/bare-redux/src/store/middleware.ts`:

```ts
import type { Middleware } from '@reduxjs/toolkit';
import type { SyncPort } from '../sync/port';
import { added, renamed, saveAcked, saveFailed, saveStarted, toggled, type AppState, type Todo } from './todos';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Saves every to-do the user changes, at its new revision, and reports each acknowledgement or
 * failure back to the store. An edit to an id that doesn't exist throws before the reducer runs,
 * so whoever dispatched it hears about it instead of the edit vanishing.
 */
export function createSyncMiddleware(sync: SyncPort): Middleware<object, AppState> {
  return (api) => (next) => (action) => {
    if ((toggled.match(action) || renamed.match(action)) && !api.getState().todos.items.some((item) => item.id === action.payload.id)) {
      throw new Error(`No to-do with id ${action.payload.id}`);
    }
    const result = next(action);

    let changed: Todo | undefined;
    if (added.match(action)) changed = api.getState().todos.items.at(-1);
    else if (toggled.match(action) || renamed.match(action)) changed = api.getState().todos.items.find((item) => item.id === action.payload.id);
    if (changed) {
      const { id, title, done, rev } = changed;
      api.dispatch(saveStarted({ id, rev }));
      void sync.save({ id, title, done, rev }).then(
        (ack) => api.dispatch(saveAcked(ack)),
        (error: unknown) => api.dispatch(saveFailed({ id, rev, reason: messageOf(error) })),
      );
    }
    return result;
  };
}
```

Create `examples/bare-redux/src/store/store.ts`:

```ts
import { configureStore, type Reducer } from '@reduxjs/toolkit';
import type { SyncPort } from '../sync/port';
import { createSyncMiddleware } from './middleware';
import { createRootReducer, type AppState } from './todos';

export interface AppPorts {
  sync: SyncPort;
}

export interface AppStoreOptions {
  /** See ReducerOptions.plantBug. */
  plantBug?: boolean;
  /** Wraps the root reducer, for reducer enhancers such as persistence or state restore. */
  wrapReducer?: (reducer: Reducer<AppState>) => Reducer<AppState>;
}

export function createAppStore(ports: AppPorts, options: AppStoreOptions = {}) {
  const root = createRootReducer({ plantBug: options.plantBug });
  return configureStore({
    reducer: options.wrapReducer ? options.wrapReducer(root) : root,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(createSyncMiddleware(ports.sync)),
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
export type AppDispatch = AppStore['dispatch'];
```

Decision rule: if TypeScript rejects `Middleware<object, AppState>` inside `concat` (RTK's dispatch-extension inference), type the factory's return as `Middleware` and read state through `const state = (): AppState => api.getState() as AppState;`, changing nothing else.

- [ ] **Step 17: Run the three test files**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src`
Expected: PASS, 3 files, 16 tests.

- [ ] **Step 18: Write the device store and the screen**

Create `examples/bare-redux/src/sync/real-timers.ts`, the real clock the device store injects (rule 9: app logic takes time from an injected clock, and the platform timer lives only in a clock implementation):

```ts
import type { Timers } from './server';
// exercise:begin-remove
import { createRealClock } from '@ironbird/core';

/**
 * The real clock the device store injects into the simulated server. In this repository it is
 * @ironbird/core's real clock, so the platform timer is called only inside core's clock.ts.
 */
export function createRealTimers(): Timers {
  return createRealClock();
}
// exercise:else
// /**
//  * The real clock the device store injects into the simulated server. It is the only code in the
//  * app that calls the platform timer; everything else takes time from the Timers it is given.
//  */
// export function createRealTimers(): Timers {
//   return { setTimeout: (callback, ms) => setTimeout(callback, ms) };
// }
// exercise:end
```

The `else` branch is commented out here, so this repository's app code never calls the global timer, and Task 4's generator writes it uncommented into the exercise, where it is that app's real-clock adapter.

Create `examples/bare-redux/src/app/instance.ts`:

```ts
import { createAppStore } from '../store/store';
import { createRealTimers } from '../sync/real-timers';
import { createSimulatedServer } from '../sync/server';

// The one store the screen renders. The device build has no backend: a simulated sync server
// answers every save, timed by the injected real clock.
export const store = createAppStore({ sync: createSimulatedServer(createRealTimers()) });
```

Create `examples/bare-redux/App.tsx`:

```tsx
import { useState } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { store } from './src/app/instance';
import type { AppDispatch } from './src/store/store';
import { added, toggled, type AppState, type Todo } from './src/store/todos';

export default function App() {
  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" />
        <TodoScreen />
      </SafeAreaProvider>
    </Provider>
  );
}

function TodoScreen() {
  const items = useSelector((state: AppState) => state.todos.items);
  const sync = useSelector((state: AppState) => state.sync);
  const dispatch = useDispatch<AppDispatch>();
  const [title, setTitle] = useState('');

  const add = (): void => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    dispatch(added({ title: trimmed }));
    setTitle('');
  };

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>To-dos</Text>
      <Text style={styles.status} testID="sync-status">
        {sync.inFlight === 0 ? 'All changes sent' : `Saving ${sync.inFlight}…`}
      </Text>
      {sync.lastError ? <Text style={styles.error}>{sync.lastError}</Text> : null}
      <View style={styles.addRow}>
        <TextInput value={title} onChangeText={setTitle} onSubmitEditing={add} placeholder="What needs doing?" style={styles.input} testID="new-title" />
        <Pressable onPress={add} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]} accessibilityRole="button">
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>
      <FlatList data={items} keyExtractor={(item) => item.id} renderItem={({ item }) => <TodoRow todo={item} onToggle={() => dispatch(toggled({ id: item.id }))} />} />
    </SafeAreaView>
  );
}

function TodoRow({ todo, onToggle }: { todo: Todo; onToggle: () => void }) {
  const saved = todo.syncedRev >= todo.rev;
  return (
    <Pressable onPress={onToggle} style={styles.row} accessibilityRole="checkbox" accessibilityState={{ checked: todo.done }}>
      <Text style={[styles.rowTitle, todo.done && styles.done]}>
        {todo.done ? '☑' : '☐'} {todo.title}
      </Text>
      <Text style={saved ? styles.saved : styles.saving}>{saved ? 'Saved' : 'Saving…'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff', paddingHorizontal: 20 },
  title: { fontSize: 30, fontWeight: '700', marginTop: 12 },
  status: { fontSize: 13, color: '#666666', marginBottom: 8 },
  error: { fontSize: 13, color: '#b42318', marginBottom: 8 },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: { flex: 1, borderWidth: 1, borderColor: '#cccccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  button: { backgroundColor: '#1f6feb', paddingHorizontal: 16, justifyContent: 'center', borderRadius: 8 },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#ffffff', fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dddddd' },
  rowTitle: { fontSize: 16, flexShrink: 1 },
  done: { color: '#888888', textDecorationLine: 'line-through' },
  saved: { fontSize: 13, color: '#1a7f37' },
  saving: { fontSize: 13, color: '#9a6700' },
});
```

- [ ] **Step 19: Typecheck and lint**

Run: `pnpm --filter @ironbird-examples/bare-redux typecheck && pnpm exec eslint examples/bare-redux eslint.config.js`
Expected: no output from either; the rule-9 block from Step 4 finds no platform timer in `App.tsx` or `src/` (the only one, in `src/sync/real-timers.ts`, is commented out). Decision rules: a TypeScript 6 deprecation error coming from `@react-native/typescript-config` is fixed by adding `"ignoreDeprecations": "6.0"` to `tsconfig.json`'s `compilerOptions`, as the root base config does; a missing `__DEV__` or `setTimeout` declaration means the React Native types weren't loaded, so check that `App.tsx` is in `include`.

- [ ] **Step 20: Commit**

```sh
git add examples/bare-redux eslint.config.js pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "Add the bare-redux example: a React Native 0.87 to-do app on Redux Toolkit"
```

---
### Task 2: Wire ironbird headless: commands, the sync fake, restore, and scenarios

**Files:**
- Create: `examples/bare-redux/src/ironbird/commands.ts`, `schema.ts`, `schema.test.ts`, `target.ts`, `headless.ts`, `headless.test.ts`, `scenarios.test.ts`
- Create: `examples/bare-redux/src/ironbird/fakes/sync.ts`, `fakes/sync.test.ts`
- Create: `examples/bare-redux/ironbird.config.ts`
- Create: `examples/bare-redux/ironbird/scenarios/add-and-sync.yaml`, `ack-reorder.yaml`, `auto-reorder.yaml`
- Create: `examples/bare-redux/test/cli.test.ts`
- Modify: `vitest.config.ts` (serial include)

**Interfaces:**
- Consumes (Task 1): `createAppStore`, `AppStore`, `AppState`, `initialState`, `added`, `toggled`, `renamed`, `createSimulatedServer`, `SLOW_ACK_MS`, `FAST_ACK_MS`, `SyncAck`, `SyncPort`.
- Consumes (plan 1, `@ironbird/redux`): `fromStore(store, { commands, toAction?, select?, restore?: { schema } }): Target` and `withIronbirdRestore(reducer)`, whose result is assignable to `Reducer<AppState>` when given a `Reducer<AppState>`. If plan 1 shipped a different option name or shape, follow its api.md "Adapters" section and change only `src/ironbird/target.ts`.
- Consumes (plan 2): error code `INVALID_SNAPSHOT`; CLI `ironbird snapshot save <file>` writing `{ app, target, rev, snapshot }` and `ironbird snapshot load <file>`, exit code 1 for `INVALID_SNAPSHOT`.
- Consumes (`@ironbird/testing`): `runScenario(file: string, options: { headless, env? }): Promise<ScenarioResult>`.
- Produces: `commands` (names in order `todos.add`, `todos.toggle`, `todos.rename`); `appStateSchema` (a Zod strict object whose output type equals `AppState`); `toAction(command: CommandOf<typeof commands>): UnknownAction`; `toTarget(store: AppStore): Target`; `fakeSync`, a `defineFake` factory named `sync` whose `create({ clock, recorder })` returns a `FakeInstance` with a `SyncPort` as its `port` and the controls `setAcks({ mode: 'auto' | 'manual' })` and `release({ order: 'oldest' | 'newest' })`, declared in that order; the default-exported headless definition (env `PLANT_BUG === '1'` plants the bug); app id `com.example.bareredux`.

- [ ] **Step 1: Write the failing fake test**

Create `examples/bare-redux/src/ironbird/fakes/sync.test.ts`:

```ts
import { createEventRecorder, createManualClock, type EventRecorder } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { SyncAck } from '../../sync/port';
import { fakeSync } from './sync';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function boot() {
  const clock = createManualClock();
  const recorder = createEventRecorder({ clock });
  const sync = fakeSync.create({ clock, recorder });
  const acks: SyncAck[] = [];
  const save = (rev: number): void => {
    void sync.port.save({ id: 't1', title: 'Buy milk', done: rev % 2 === 0, rev }).then((ack) => acks.push(ack));
  };
  return { clock, recorder, sync, acks, save };
}

const names = (recorder: EventRecorder): string[] => recorder.since(0).events.map((event) => `${event.source}:${event.name}`);

describe('fake sync', () => {
  it('acknowledges on the alternating timer in auto mode and records saves and acknowledgements', async () => {
    const { clock, recorder, acks, save } = boot();
    save(1);
    save(2);
    await clock.advance(100);
    expect(acks).toEqual([{ id: 't1', rev: 2 }]);
    await clock.advance(200);
    expect(acks).toEqual([
      { id: 't1', rev: 2 },
      { id: 't1', rev: 1 },
    ]);
    expect(names(recorder)).toEqual(['sync:save', 'sync:save', 'sync:ack', 'sync:ack']);
    expect(recorder.since(0).events[2]?.data).toEqual({ id: 't1', rev: 2 });
  });

  it('holds acknowledgements in manual mode and releases them oldest or newest first', async () => {
    const { clock, sync, acks, save } = boot();
    await sync.control('setAcks', { mode: 'manual' });
    save(1);
    save(2);
    save(3);
    await clock.advance(1_000);
    expect(acks).toEqual([]);
    expect(clock.timers()).toEqual([]);

    await sync.control('release', { order: 'newest' });
    await sync.control('release', { order: 'oldest' });
    await sync.control('release', { order: 'oldest' });
    await flush();
    expect(acks.map((ack) => ack.rev)).toEqual([3, 1, 2]);
  });

  it('keeps held acknowledgements held after switching back to auto', async () => {
    const { clock, sync, acks, save } = boot();
    await sync.control('setAcks', { mode: 'manual' });
    save(1);
    await sync.control('setAcks', { mode: 'auto' });
    save(2);
    await clock.advance(300);
    expect(acks.map((ack) => ack.rev)).toEqual([2]);
    await sync.control('release', { order: 'oldest' });
    await flush();
    expect(acks.map((ack) => ack.rev)).toEqual([2, 1]);
  });

  it('fails release with DISPATCH_FAILED when nothing is held', async () => {
    const { sync } = boot();
    await expect(sync.control('release', { order: 'oldest' })).rejects.toMatchObject({
      code: 'DISPATCH_FAILED',
      details: { name: 'sync.release', message: expect.stringContaining('No acknowledgement is held') },
    });
  });

  it('validates control payloads and declares setAcks then release', async () => {
    const { sync } = boot();
    await expect(sync.control('release', { order: 'random' })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'sync.release' } });
    await expect(sync.control('setAcks', { mode: 'sometimes' })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'sync.setAcks' } });
    expect(sync.controls.names()).toEqual(['setAcks', 'release']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/ironbird/fakes/sync.test.ts`
Expected: FAIL, cannot resolve `./sync`.

- [ ] **Step 3: Write the fake**

Create `examples/bare-redux/src/ironbird/fakes/sync.ts`:

```ts
import { defineFake } from '@ironbird/core';
import { z } from 'zod';
import type { SyncAck, SyncPort } from '../../sync/port';
import { FAST_ACK_MS, SLOW_ACK_MS, createSimulatedServer } from '../../sync/server';

interface Held {
  ack: SyncAck;
  resolve: (ack: SyncAck) => void;
}

export const fakeSync = defineFake('sync', {
  description: `Sync API: in auto mode acknowledges each save after ${SLOW_ACK_MS} ms or ${FAST_ACK_MS} ms, alternating, so two saves less than ${SLOW_ACK_MS - FAST_ACK_MS} ms apart are acknowledged newest first; in manual mode holds every acknowledgement until release`,
  controls: {
    setAcks: z
      .object({ mode: z.enum(['auto', 'manual']).describe('auto acknowledges on the alternating timer; manual holds each acknowledgement until release') })
      .describe('Choose how saves made after this call are acknowledged; acknowledgements already held stay held'),
    release: z
      .object({ order: z.enum(['oldest', 'newest']).describe('oldest delivers in save order; newest delivers the latest save first, out of order') })
      .describe('Deliver one held acknowledgement now; fails when none is held'),
  },
  create({ clock, record }) {
    // The same timing the app's own simulated server uses, on the injected clock.
    const server = createSimulatedServer(clock);
    const held: Held[] = [];
    let mode: 'auto' | 'manual' = 'auto';

    const acknowledged = (ack: SyncAck): SyncAck => {
      record('ack', ack);
      return ack;
    };

    const port: SyncPort = {
      save: (todo) => {
        record('save', todo);
        if (mode === 'auto') return server.save(todo).then(acknowledged);
        return new Promise((resolve) => {
          held.push({ ack: { id: todo.id, rev: todo.rev }, resolve });
        });
      },
    };

    return {
      port,
      controls: {
        setAcks: ({ mode: next }) => {
          mode = next;
        },
        release: ({ order }) => {
          const entry = order === 'oldest' ? held.shift() : held.pop();
          if (!entry) throw new Error('No acknowledgement is held: switch to manual with setAcks, then change a to-do');
          entry.resolve(acknowledged(entry.ack));
        },
      },
    };
  },
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/ironbird/fakes/sync.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing schema and headless tests**

Create `examples/bare-redux/src/ironbird/schema.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { initialState, type AppState } from '../store/todos';
import { appStateSchema } from './schema';

const todo = { id: 't1', title: 'Buy milk', done: false, rev: 2, syncedRev: 1 };

describe('the root-state schema', () => {
  it('describes AppState exactly and accepts real states', () => {
    expectTypeOf<z.output<typeof appStateSchema>>().toEqualTypeOf<AppState>();
    expect(appStateSchema.parse(initialState)).toEqual(initialState);
    const state = { todos: { items: [todo], nextId: 2 }, sync: { inFlight: 1, lastError: 'Saving t1 failed: offline' } };
    expect(appStateSchema.parse(state)).toEqual(state);
  });

  it('rejects unknown keys, malformed ids, empty titles, and negative counts', () => {
    expect(appStateSchema.safeParse({ ...initialState, extra: 1 }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...initialState, todos: { items: [{ ...todo, id: 'x1' }], nextId: 2 } }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...initialState, todos: { items: [{ ...todo, title: '' }], nextId: 2 } }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...initialState, todos: { items: [{ ...todo, notes: 'x' }], nextId: 2 } }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...initialState, sync: { inFlight: -1, lastError: null } }).success).toBe(false);
  });
});
```

Create `examples/bare-redux/src/ironbird/headless.test.ts`:

```ts
import { createEventRecorder, createManualClock, createTracker, type FakeInstance, type HeadlessApp } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { AppState } from '../store/todos';
import headless from './headless';

async function boot(env: Record<string, string> = {}) {
  const clock = createManualClock({ now: Date.parse('2026-01-01T00:00:00.000Z') });
  const recorder = createEventRecorder({ clock });
  const tracker = createTracker({ clock });
  const app = await headless.create({ clock, recorder, tracker, env });
  const settle = () => tracker.whenIdle({ mode: 'quiescent', timeoutMs: 1_000 });
  return { app, clock, settle };
}

const state = (app: HeadlessApp): AppState => app.target.getState() as AppState;

function syncFake(app: HeadlessApp): FakeInstance {
  const fake = app.fakes?.find((candidate) => candidate.name === 'sync');
  if (!fake) throw new Error('sync fake not wired');
  return fake;
}

function persistAndRestore(app: HeadlessApp): { persist: () => unknown; restore: (snapshot: unknown) => Promise<void> } {
  const { persist, restore } = app.target;
  if (!persist || !restore) throw new Error('the target lacks persist or restore');
  return { persist, restore };
}

describe('bare-redux headless entry', () => {
  it('describes the three commands, the sync fake, and both snapshot capabilities', async () => {
    const { app } = await boot();
    expect(app.target.commands.names()).toEqual(['todos.add', 'todos.toggle', 'todos.rename']);
    expect(app.fakes?.map((fake) => [fake.name, fake.controls.names()])).toEqual([['sync', ['setAcks', 'release']]]);
    expect(app.target.capabilities).toEqual(['persist', 'restore']);
  });

  it('adds a to-do with a trimmed title, waits on the 300 ms save, and ends saved', async () => {
    const { app, clock, settle } = await boot();
    await app.target.dispatch('todos.add', { title: '  Buy milk ' });
    let result = await settle();
    expect(result).toMatchObject({ idle: false, quiescent: true, nextTimerInMs: 300 });
    expect(result.pending.map((pending) => pending.label)).toEqual(['sync.save']);
    expect(state(app)).toEqual({
      todos: { items: [{ id: 't1', title: 'Buy milk', done: false, rev: 1, syncedRev: 0 }], nextId: 2 },
      sync: { inFlight: 1, lastError: null },
    });

    await clock.advance(300);
    result = await settle();
    expect(result.idle).toBe(true);
    expect(state(app)).toMatchObject({ todos: { items: [{ syncedRev: 1 }] }, sync: { inFlight: 0 } });
  });

  it('fails an edit to a missing to-do with DISPATCH_FAILED', async () => {
    const { app } = await boot();
    await expect(app.target.dispatch('todos.toggle', { id: 't9' })).rejects.toMatchObject({
      code: 'DISPATCH_FAILED',
      details: { name: 'todos.toggle', message: 'No to-do with id t9' },
    });
  });

  it('without PLANT_BUG, a quick second edit ends saved at revision 2', async () => {
    const { app, clock, settle } = await boot();
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    await app.target.dispatch('todos.toggle', { id: 't1' });
    await clock.advance(300);
    await settle();
    expect(state(app).sync.inFlight).toBe(0);
    expect(state(app).todos.items[0]).toMatchObject({ rev: 2, syncedRev: 2 });
  });

  it('with PLANT_BUG=1, the same edits end unsaved with nothing in flight', async () => {
    const { app, clock, settle } = await boot({ PLANT_BUG: '1' });
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    await app.target.dispatch('todos.toggle', { id: 't1' });
    await clock.advance(300);
    await settle();
    expect(state(app).sync.inFlight).toBe(0);
    expect(state(app).todos.items[0]).toMatchObject({ rev: 2, syncedRev: 1 });
  });

  it('persists the root state and restores it through the wrapped reducer', async () => {
    const { app, clock, settle } = await boot();
    const { persist, restore } = persistAndRestore(app);
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    await clock.advance(300);
    await settle();
    const saved = persist();
    expect(saved).toEqual({
      todos: { items: [{ id: 't1', title: 'Buy milk', done: false, rev: 1, syncedRev: 1 }], nextId: 2 },
      sync: { inFlight: 0, lastError: null },
    });

    await app.target.dispatch('todos.toggle', { id: 't1' });
    await restore(saved);
    expect(state(app)).toEqual(saved);
  });

  it('refuses a snapshot with an extra key or a wrong type and leaves the store as it was', async () => {
    const { app } = await boot();
    const { persist, restore } = persistAndRestore(app);
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    const before = state(app);
    const saved = persist() as AppState;
    await expect(restore({ ...saved, extra: true })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    await expect(restore({ ...saved, sync: { inFlight: -1, lastError: null } })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    await expect(restore({ ...saved, todos: { items: 'none', nextId: 2 } })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    expect(state(app)).toBe(before);
  });

  it('survives an acknowledgement for a to-do the restored state does not have', async () => {
    const { app, settle } = await boot();
    const { persist, restore } = persistAndRestore(app);
    const empty = persist();
    await syncFake(app).control('setAcks', { mode: 'manual' });
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    await restore(empty);
    await syncFake(app).control('release', { order: 'oldest' });
    await settle();
    expect(state(app)).toEqual({ todos: { items: [], nextId: 1 }, sync: { inFlight: 0, lastError: null } });
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/ironbird/schema.test.ts examples/bare-redux/src/ironbird/headless.test.ts`
Expected: FAIL, cannot resolve `./schema` and `./headless`.

- [ ] **Step 7: Write the commands, the schema, the target, and the headless entry**

Create `examples/bare-redux/src/ironbird/commands.ts`:

```ts
import { defineCommands } from '@ironbird/core';
import { z } from 'zod';

const title = z.string().trim().min(1).max(200).describe('The to-do text; surrounding spaces are trimmed');
const id = z.string().min(1).describe('A to-do id, such as t1');

export const commands = defineCommands({
  'todos.add': z.object({ title }).describe('Add a to-do; it is saved to the sync API at once'),
  'todos.toggle': z.object({ id }).describe('Mark a to-do done or not done; the change is saved'),
  'todos.rename': z.object({ id, title }).describe('Change a to-do text; the change is saved'),
});
```

Create `examples/bare-redux/src/ironbird/schema.ts`:

```ts
import { z } from 'zod';
import type { AppState } from '../store/todos';

const todo = z.strictObject({
  id: z.string().regex(/^t[1-9]\d*$/),
  title: z.string().min(1),
  done: z.boolean(),
  rev: z.number().int().min(1),
  syncedRev: z.number().int().min(0),
});

/**
 * The store's root state. `snapshot load` validates a snapshot against it before the reducer sees
 * it (AGENTS.md hard rule 4); strict objects, so a snapshot with a key the app doesn't know is
 * refused rather than carried into the store.
 */
export const appStateSchema = z.strictObject({
  todos: z.strictObject({ items: z.array(todo), nextId: z.number().int().min(1) }),
  sync: z.strictObject({ inFlight: z.number().int().min(0), lastError: z.string().nullable() }),
}) satisfies z.ZodType<AppState>;
```

Create `examples/bare-redux/src/ironbird/target.ts`:

```ts
import type { CommandOf, Target } from '@ironbird/core';
import { fromStore } from '@ironbird/redux';
import type { UnknownAction } from '@reduxjs/toolkit';
import type { AppStore } from '../store/store';
import { added, renamed, toggled } from '../store/todos';
import { commands } from './commands';
import { appStateSchema } from './schema';

/** Each command dispatches the app's own action, with the payload the command schema already validated. */
export function toAction(command: CommandOf<typeof commands>): UnknownAction {
  switch (command.name) {
    case 'todos.add':
      return added(command.payload);
    case 'todos.toggle':
      return toggled(command.payload);
    case 'todos.rename':
      return renamed(command.payload);
  }
}

/** The store as an ironbird target. No `select`: agents and scenarios see the root state. */
export const toTarget = (store: AppStore): Target => fromStore(store, { commands, toAction, restore: { schema: appStateSchema } });
```

Create `examples/bare-redux/src/ironbird/headless.ts`:

```ts
import { defineHeadless } from '@ironbird/core';
import { withIronbirdRestore } from '@ironbird/redux';
import { createAppStore } from '../store/store';
import { fakeSync } from './fakes/sync';
import { toTarget } from './target';

export default defineHeadless(({ clock, recorder, tracker, env }) => {
  // A fresh fake and store per boot: `reset` runs this factory again, so ids, revisions, held
  // acknowledgements, and the fake's slow/fast alternation all start over.
  const sync = fakeSync.create({ clock, recorder });
  const store = createAppStore(
    { sync: tracker.wrap(sync.port, 'sync') },
    { plantBug: env['PLANT_BUG'] === '1', wrapReducer: withIronbirdRestore },
  );
  return { target: toTarget(store), fakes: [sync] };
});
```

Create `examples/bare-redux/ironbird.config.ts`:

```ts
import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({
  appId: 'com.example.bareredux',
  headless: './src/ironbird/headless.ts',
  defaultTarget: 'headless',
  clock: { start: '2026-01-01T00:00:00.000Z' },
  // Pins the iOS capture device when more than one simulator is booted, which otherwise makes
  // `screenshot` fail with AMBIGUOUS_DEVICE; unset, it changes nothing.
  devices: { ios: process.env['IRONBIRD_SIM_UDID'] },
});
```

- [ ] **Step 8: Rebuild if needed and run the tests**

Run: `pnpm build && pnpm exec vitest run --project unit examples/bare-redux/src/ironbird`
Expected: PASS, 3 files, 15 tests (fake 5, schema 2, headless 8). If `@ironbird/redux`'s `restore` reports a schema failure with a code other than `INVALID_SNAPSHOT`, that is a plan 1 defect against spec D1: fix it in `packages/redux`, with its own test there, rather than loosening this test.

- [ ] **Step 9: Write the scenarios**

Create `examples/bare-redux/ironbird/scenarios/add-and-sync.yaml`:

```yaml
name: Add a to-do and let it sync
description: A new to-do is saved to the sync API and shows as saved once its acknowledgement arrives. Runs on a fresh app (headless resets; on a device, run `ironbird reload --target ios` first).
steps:
  - send: todos.add
    payload: { title: Buy milk }
  - expect: todos.items.0.title
    equals: Buy milk
  - clock: 300ms
    optional: true   # headless: the first save's 300 ms acknowledgement; a remote target's settle already waited for it
  - wait: sync.inFlight
    equals: 0
  - expect: todos.items.0.syncedRev
    equals: 1
```

Create `examples/bare-redux/ironbird/scenarios/ack-reorder.yaml`:

```yaml
name: Acknowledgements arrive out of order
description: Two edits to one to-do are saved back to back and the sync API acknowledges the newer save first. Once both arrive, the to-do must show as saved at its latest revision. Fails at the last step with PLANT_BUG=1. Runs on a fresh app.
steps:
  - fake: sync
    control: setAcks
    payload: { mode: manual }
  - send: todos.add
    payload: { title: Buy milk }
    settle: false   # a device's settle waits for every pending save, and this one is held until release
  - send: todos.toggle
    payload: { id: t1 }
    settle: false
  - expect: sync.inFlight
    equals: 2
  - fake: sync
    control: release
    payload: { order: newest }   # the rev 2 acknowledgement
    settle: false                # the rev 1 save is still held
  - fake: sync
    control: release
    payload: { order: newest }   # then the older rev 1 acknowledgement; nothing is held after it
  - expect: sync.inFlight
    equals: 0
  - expect: todos.items.0.rev
    equals: 2
  - expect: todos.items.0.syncedRev
    equals: 2
```

Create `examples/bare-redux/ironbird/scenarios/auto-reorder.yaml`:

```yaml
name: The sync API answers a quick second edit first
description: A to-do is added and toggled at once. The sync API's alternating timer acknowledges the second save after 100 ms and the first after 300 ms, so the acknowledgements arrive newest first without any fake control. Fails at the last step with PLANT_BUG=1.
target: headless   # the manual clock decides when each acknowledgement lands
steps:
  - send: todos.add
    payload: { title: Buy milk }
  - send: todos.toggle
    payload: { id: t1 }
  - clock: 100ms   # the second save (rev 2) is acknowledged
  - expect: todos.items.0.syncedRev
    equals: 2
  - expect: sync.inFlight
    equals: 1
  - clock: 200ms   # the first save (rev 1) is acknowledged after it
  - expect: sync.inFlight
    equals: 0
  - expect: todos.items.0.syncedRev
    equals: 2
```

- [ ] **Step 10: Write the scenario test and run it**

Create `examples/bare-redux/src/ironbird/scenarios.test.ts`:

```ts
import { runScenario } from '@ironbird/testing';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import headless from './headless';

const file = (name: string): string => path.resolve(__dirname, '../../ironbird/scenarios', name);

describe('the bare-redux scenarios, headless and in process', () => {
  it.each(['add-and-sync.yaml', 'ack-reorder.yaml', 'auto-reorder.yaml'])('%s passes', async (name) => {
    const result = await runScenario(file(name), { headless });
    expect(result.failedStep).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it.each([
    ['ack-reorder.yaml', 8],
    ['auto-reorder.yaml', 7],
  ])('%s fails at its last step with PLANT_BUG=1, showing revision 1', async (name, index) => {
    const result = await runScenario(file(name), { headless, env: { PLANT_BUG: '1' } });
    expect(result).toMatchObject({ passed: false, failedStep: { index, expected: { equals: 2 }, actual: 1 } });
  });

  it('add-and-sync passes with PLANT_BUG=1 too: a single save cannot be reordered', async () => {
    const result = await runScenario(file('add-and-sync.yaml'), { headless, env: { PLANT_BUG: '1' } });
    expect(result.passed).toBe(true);
  });
});
```

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/ironbird/scenarios.test.ts`
Expected: PASS, 6 tests. Step indexes are 0-based (`failedStep.index` 8 is `ack-reorder.yaml`'s ninth step). The `settle: false` flags in `ack-reorder.yaml` matter only on a device: the bridge's settle waits until nothing is pending (packages/react-native/src/settle.ts has no quiescent mode), so a step that leaves a held save behind would time out there; headless settle already treats a held fake call as quiescent.

- [ ] **Step 11: Write the failing daemon test**

In `vitest.config.ts`, add `'examples/bare-redux/test/**/*.test.ts'` to the `serial` project's `include` array and extend its comment with one line: `// examples/bare-redux/test/ drives a real daemon and Metro against that example.`

Create `examples/bare-redux/test/cli.test.ts`:

```ts
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const example = path.resolve(__dirname, '..');
const bin = path.resolve(example, '../../packages/cli/dist/bin.js');
const env = { ...process.env, IRONBIRD_TOKEN: undefined, PLANT_BUG: undefined };

interface Result {
  code: number;
  json: Record<string, unknown>;
  lines: string[];
}

async function ironbird(...args: string[]): Promise<Result> {
  try {
    const { stdout } = await exec('node', [bin, ...args], { cwd: example, env });
    const lines = stdout.trim().split('\n');
    return { code: 0, json: JSON.parse(lines[0] ?? '{}') as Record<string, unknown>, lines };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    const lines = (failure.stdout ?? '').trim().split('\n');
    return { code: failure.code, json: JSON.parse(lines[0] || '{}') as Record<string, unknown>, lines };
  }
}

let daemon: ChildProcess | undefined;
let exited: Promise<number | null>;

beforeAll(async () => {
  daemon = spawn('node', [bin, 'serve', '--port', '0', '--bridge-port', '0'], { cwd: example, env, stdio: ['ignore', 'pipe', 'inherit'] });
  exited = new Promise<number | null>((resolve) => {
    daemon?.once('exit', (code) => resolve(code));
  });
  await new Promise<void>((resolve, reject) => {
    daemon?.stdout?.once('data', () => resolve());
    void exited.then((code) => reject(new Error(`serve exited early with ${code}`)));
  });
}, 30_000);

afterAll(async () => {
  if (daemon) {
    if (daemon.exitCode === null) daemon.kill('SIGTERM');
    await exited;
  }
  await rm(path.join(example, '.ironbird/daemon.json'), { force: true });
});

describe('ironbird CLI against the bare-redux example', () => {
  it('serves the headless entry and lists the three commands', async () => {
    expect((await ironbird('status')).json).toMatchObject({ protocol: 1, targets: [{ id: 'headless', appId: 'com.example.bareredux' }] });
    expect(Object.keys((await ironbird('commands')).json).sort()).toEqual(['todos.add', 'todos.rename', 'todos.toggle']);
  });

  it('runs every scenario in ironbird/scenarios', async () => {
    const run = await ironbird('scenario', 'run', 'ironbird/scenarios');
    expect(run.code).toBe(0);
    const results = run.lines.map((line) => JSON.parse(line) as { scenario: string; passed: boolean });
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it('saves a snapshot, loads it back over a later edit, and refuses one that fails the schema', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-bare-redux-'));
    try {
      expect((await ironbird('reset')).code).toBe(0);
      expect((await ironbird('send', 'todos.add', '{"title":"Buy milk"}')).code).toBe(0);
      expect((await ironbird('clock', 'advance', '300')).code).toBe(0);

      const file = path.join(dir, 'saved.json');
      expect((await ironbird('snapshot', 'save', file)).code).toBe(0);
      const saved = JSON.parse(await readFile(file, 'utf8')) as { snapshot: Record<string, unknown> } & Record<string, unknown>;
      expect(saved).toMatchObject({
        app: 'com.example.bareredux',
        target: 'headless',
        snapshot: { todos: { items: [{ id: 't1', title: 'Buy milk', done: false, rev: 1, syncedRev: 1 }], nextId: 2 }, sync: { inFlight: 0, lastError: null } },
      });

      expect((await ironbird('send', 'todos.toggle', '{"id":"t1"}')).code).toBe(0);
      expect((await ironbird('snapshot', 'load', file)).code).toBe(0);
      expect((await ironbird('state', 'todos.items.0')).json).toMatchObject({ value: { done: false, rev: 1, syncedRev: 1 } });

      const bad = path.join(dir, 'bad.json');
      await writeFile(bad, JSON.stringify({ ...saved, snapshot: { ...saved.snapshot, todos: { items: 'none', nextId: 2 } } }));
      const refused = await ironbird('snapshot', 'load', bad);
      expect(refused.code).toBe(1);
      expect(refused.json).toMatchObject({ error: { code: 'INVALID_SNAPSHOT' } });
      expect((await ironbird('state', 'todos.items.0')).json).toMatchObject({ value: { done: false, rev: 1 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an edit to a missing to-do as DISPATCH_FAILED and a blank title as INVALID_PAYLOAD', async () => {
    await ironbird('reset');
    const missing = await ironbird('send', 'todos.toggle', '{"id":"t9"}');
    expect(missing.code).toBe(1);
    expect(missing.json).toMatchObject({ error: { code: 'DISPATCH_FAILED', details: { name: 'todos.toggle', message: 'No to-do with id t9' } } });

    const blank = await ironbird('send', 'todos.add', '{"title":"   "}');
    expect(blank.code).toBe(1);
    expect(blank.json).toMatchObject({ error: { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['title'] }] } } });
    expect((await ironbird('state', 'todos.items')).json).toMatchObject({ value: [] });
  });
});
```

- [ ] **Step 12: Run it**

Run: `pnpm exec vitest run --project serial examples/bare-redux/test/cli.test.ts`
Expected: PASS, 4 tests. The test is green on its first run because Steps 7–9 already built what it exercises; it is the end-to-end proof that the daemon bundles this headless entry (Redux Toolkit and `@ironbird/redux` included, no `react-native` in the graph) and that plan 2's snapshot commands reach plan 1's restore. If it fails with `HEADLESS_LOAD_FAILED` naming `react-native`, something under `src/store`, `src/sync`, or `src/ironbird` (other than the later `device.ts`) imports it: remove that import.

- [ ] **Step 13: Typecheck, lint, commit**

Run: `pnpm --filter @ironbird-examples/bare-redux typecheck && pnpm exec eslint examples/bare-redux vitest.config.ts`
Expected: no output.

```sh
git add examples/bare-redux vitest.config.ts
git commit -m "Wire bare-redux into ironbird headlessly with the Redux adapter, a sync fake, and scenarios"
```

---

### Task 3: Wire the device: the bridge, the device store, and release-bundle checks

**Files:**
- Create: `examples/bare-redux/src/ironbird/device.ts`
- Modify: `examples/bare-redux/src/app/instance.ts` (whole file), `examples/bare-redux/index.js` (whole file)
- Create: `examples/bare-redux/test/bundle.test.ts`

**Interfaces:**
- Consumes: `startBridge(options: BridgeOptions): BridgeHandle` from `@ironbird/react-native`; `toTarget`, `fakeSync` (Task 2); `createAppStore` (Task 1); `withIronbirdRestore` (plan 1).
- Produces: `src/app/instance.ts` exports `store`, and inside the exercise markers `clock`, `tracker`, `recorder`, `fakes`; `src/ironbird/device.ts` exports `startIronbird(): BridgeHandle`; `index.js` starts the bridge only under `__DEV__`.

- [ ] **Step 1: Write the failing bundle test**

The file holds two tests with different jobs. **The dev-bundle test is this task's red-to-green gate:** it fails before Step 3 (nothing starts the bridge, so `verify-bundle` finds no marker) and passes only once Step 3 wires the bridge. **The release-bundle test is a regression check, not evidence of Step 3:** it passes before Step 3 (there is no bridge to leak yet) and must still pass after it, which is what shows the `__DEV__` guard keeps the bridge out of release builds.

Create `examples/bare-redux/test/bundle.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Metro builds of this example, checked the way a user checks theirs (docs/cli.md, verify-bundle):
// the release bundle must not contain the bridge, and the dev bundle must, so the clean release
// result isn't vacuous. The dev bundle also names every module's resolved path, which shows
// whether the monorepo resolved a second react-native.
const exec = promisify(execFile);
const example = path.resolve(__dirname, '..');
const cli = path.resolve(example, '../../packages/cli/dist/bin.js');
const reactNativeBin = path.join(example, 'node_modules/.bin/react-native');
let out: string;

beforeAll(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), 'ironbird-bare-redux-bundle-'));
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

async function bundle(dev: boolean): Promise<string> {
  const file = path.join(out, dev ? 'dev.jsbundle' : 'release.jsbundle');
  await exec(reactNativeBin, ['bundle', '--platform', 'ios', '--dev', String(dev), '--entry-file', 'index.js', '--bundle-output', file], {
    cwd: example,
    maxBuffer: 256 * 1024 * 1024,
  });
  return file;
}

async function verify(file: string): Promise<{ code: number; found: unknown[] }> {
  try {
    const { stdout } = await exec('node', [cli, 'verify-bundle', file, '--json'], { cwd: example });
    return { code: 0, found: (JSON.parse(stdout) as { found: unknown[] }).found };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    return { code: failure.code, found: (JSON.parse(failure.stdout) as { found: unknown[] }).found };
  }
}

describe('bare-redux Metro bundles', () => {
  // Regression check: passes before the bridge is wired and must keep passing after.
  it('keeps the bridge out of the release bundle', async () => {
    const result = await verify(await bundle(false));
    expect(result).toEqual({ code: 0, found: [] });
  }, 300_000);

  // The red-to-green gate for the device wiring (Step 3).
  it('ships the bridge in the dev bundle with exactly one react-native', async () => {
    const file = await bundle(true);
    const result = await verify(file);
    expect(result.code).toBe(1);
    expect(result.found).toHaveLength(1);
    const source = await readFile(file, 'utf8');
    expect(source).toMatch(/react-native@0\.87\.1/);
    expect(source).not.toMatch(/react-native@0\.86\./);
  }, 300_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project serial examples/bare-redux/test/bundle.test.ts`
Expected: the dev test FAILS with `expected 0 to be 1`: this is the required red state, and Step 3 is not done until it turns green. The release test PASSES, as a regression check should before the bridge exists; its pass here proves nothing about Step 3. If the dev test fails for any other reason (Metro errors, a missing binary), that is not the red state: fix it with the rules below until the only failure is the missing marker. Decision rules if Metro itself errors: "Unable to resolve module X from packages/…" means X must be reachable from `nodeModulesPaths` (add X to the example's dependencies if it is a runtime import of compiled package code, as `@babel/runtime` is); "SHA-1 for file … is not computed" or "… is outside the project's watch folders" means that file's root is missing from `watchFolders`; fix `metro.config.js` inside its exercise block and re-run. If the positive `react-native@0\.87\.1` assertion fails later in Step 6, print the first few `__d(` lines' last string argument to see the verbose path form Metro used and match that form instead.

- [ ] **Step 3: Write the device wiring**

Create `examples/bare-redux/src/ironbird/device.ts`:

```ts
import { startBridge, type BridgeHandle } from '@ironbird/react-native';
import { clock, fakes, recorder, store, tracker } from '../app/instance';
import { toTarget } from './target';

/**
 * Called from index.js inside `if (__DEV__)`, so release bundles never contain the bridge. The
 * default URL, ws://localhost:4568, reaches the daemon from the iOS Simulator directly. The sync
 * fake makes `ironbird fake sync ...` work against the running app, and React Native's own
 * `DevSettings.reload` serves `ironbird reload` in a bare app.
 */
export function startIronbird(): BridgeHandle {
  return startBridge({ target: toTarget(store), clock, tracker, recorder, fakes, appId: 'com.example.bareredux', appName: 'Bare Redux' });
}
```

Replace `examples/bare-redux/src/app/instance.ts` with:

```ts
import { createAppStore } from '../store/store';
// exercise:begin-remove
import { createEventRecorder, createRealClock, createTracker, type FakeInstance } from '@ironbird/core';
import { withIronbirdRestore } from '@ironbird/redux';
import { fakeSync } from '../ironbird/fakes/sync';

// The device build has no backend. The fake the headless entry uses stands in for the sync API,
// here on the real clock: a save takes real milliseconds, the bridge's settle has a pending save
// to wait for, and `ironbird fake sync ...` works against the running app. The wrapped reducer
// lets `ironbird snapshot load` replace the root state. The bug is never planted on the device.
export const clock = createRealClock();
export const tracker = createTracker({ clock, enabled: __DEV__ });
export const recorder = createEventRecorder({ clock, enabled: __DEV__ });
const sync = fakeSync.create({ clock, recorder });
export const fakes: FakeInstance[] = [sync];
export const store = createAppStore({ sync: tracker.wrap(sync.port, 'sync') }, { wrapReducer: withIronbirdRestore });
// exercise:else
// import { createRealTimers } from '../sync/real-timers';
// import { createSimulatedServer } from '../sync/server';
//
// // The one store the screen renders. The device build has no backend: a simulated sync server
// // answers every save, timed by the injected real clock.
// export const store = createAppStore({ sync: createSimulatedServer(createRealTimers()) });
// exercise:end
```

The `else` branch is the app before ironbird, as Task 1 wrote it: the store injects the real-clock adapter from `src/sync/real-timers.ts` into the simulated server, so even the exercise's app logic never calls the global timer itself (rule 9); in the exercise, that adapter's own `else` branch is the only platform-timer call. Task 4's generator uncomments this branch for the exercise.

Replace `examples/bare-redux/index.js` with:

```js
/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// exercise:begin-remove
// The bridge is dev-only. Metro replaces `__DEV__` with false in release builds and drops this
// branch, require() included, before it collects dependencies, so the bridge never reaches a
// release bundle; `ironbird verify-bundle` checks that (test/bundle.test.ts).
if (__DEV__) {
  require('./src/ironbird/device').startIronbird();
}
// exercise:end

AppRegistry.registerComponent(appName, () => App);
```

- [ ] **Step 4: Run the bundle test**

Run: `pnpm build && pnpm exec vitest run --project serial examples/bare-redux/test/bundle.test.ts`
Expected: PASS, 2 tests. The dev test, red in Step 2, is now green (the gate); the release test still passes (the regression check), so the `__DEV__` guard keeps the bridge out of release bundles. Note the wall time of each test from the reporter; if either takes more than 150 s on this machine, raise both timeouts to twice the measured time and say so in the commit message body, because CI runners are slower. If CI's Linux runs later fail at the iOS bundle with an error naming Xcode, CocoaPods, or the iOS project config (this Mac can't show that), bundle for `process.platform === 'linux' ? 'android' : 'ios'` in `bundle()`; the marker check and the single-`react-native` check hold for either platform.

- [ ] **Step 5: Run the example's whole suite, typecheck, lint**

Run: `pnpm exec vitest run --project unit examples/bare-redux && pnpm exec vitest run --project serial examples/bare-redux && pnpm --filter @ironbird-examples/bare-redux typecheck && pnpm exec eslint examples/bare-redux`
Expected: unit 7 files and 37 tests pass; serial 2 files and 6 tests pass; typecheck and lint print nothing.

- [ ] **Step 6: Commit**

```sh
git add examples/bare-redux
git commit -m "Start the ironbird bridge in bare-redux dev builds and check its Metro bundles"
```

---
### Task 4: Generate the integration exercise, with its task sheet, checklist, and results sheet

**Files:**
- Create: `examples/bare-redux/scripts/lib/exercise.mjs`, `scripts/lib/exercise.test.mjs`, `scripts/make-exercise.mjs`
- Create: `examples/bare-redux/exercise/README.md`, `TASK.md`, `CHECKLIST.md`, `RESULTS.md`, `acceptance.yaml` (the single source of the exercise material; plan 5 later rewrites `TASK.md`, `CHECKLIST.md`, `RESULTS.md`, and `acceptance.yaml` here, never in the generated copy)
- Create (generated): `examples/bare-redux/integration-exercise/**`
- Create: `scripts/pack-packages.mjs`, `scripts/pack-packages.test.mjs`
- Modify: `examples/bare-redux/package.json` (scripts), `examples/bare-redux/src/ironbird/scenarios.test.ts` (acceptance test), `vitest.config.ts` (unit include)

**Interfaces:**
- Consumes: the markers in `metro.config.js`, `index.js`, `src/app/instance.ts` (Tasks 1 and 3); the headless entry (Task 2).
- Produces:
  - `scripts/lib/exercise.mjs`: `EXCLUDED_PATHS: string[]`, `MATERIAL_FILES = ['TASK.md', 'CHECKLIST.md', 'RESULTS.md', 'acceptance.yaml']`, `OVERLAY_FILES: Record<string, string>` (`exercise/README.md` and the four materials, each to the same name at the copy's root), `IRONBIRD_DEPENDENCIES`, `IRONBIRD_DEV_DEPENDENCIES`, `KEPT_SCRIPTS`, `TYPESCRIPT_RANGE`, `isIncluded(file: string): boolean`, `transformSource(source: string, file: string): string`, `transformPackageJson(source: string): string`, `findLeaks(files: Array<{ file: string; text: string }>): string[]`, `listExampleFiles(dir: string): string[]`, `walkFiles(dir: string): Promise<string[]>`, `generateExercise({ exampleDir, outDir }): Promise<{ files: string[] }>`, `snapshotTree(dir: string, files: string[]): Promise<Map<string, { hash: string; executable: boolean }>>`, `diffTrees(committed, generated): string[]`.
  - `scripts/pack-packages.mjs`: `PACKABLE = ['core', 'react-native', 'redux', 'xstate', 'cli', 'testing']`, `packPackages(names: string[], outDir: string): string[]` (tarball paths in the order of `names`); CLI `node scripts/pack-packages.mjs <out-dir> <name...>` printing `{ tarballs }`. Task 5 and plan 5 use it.
  - The exercise material plan 5's proxy eval reuses: sources `exercise/TASK.md`, `CHECKLIST.md` (five checks), `RESULTS.md`, `acceptance.yaml` (and `README.md`), copied to the same names in `integration-exercise/`. Plan 5 edits the sources and reruns `make:exercise`; the drift test fails on any hand edit to a copy.
  - Script `make:exercise` in the example.

- [ ] **Step 1: Write the failing generator tests**

In `vitest.config.ts`, add `'examples/*/scripts/**/*.test.mjs'` and `'scripts/**/*.test.mjs'` to the `unit` project's `include` array.

Create `examples/bare-redux/scripts/lib/exercise.test.mjs`:

```js
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MATERIAL_FILES, diffTrees, findLeaks, generateExercise, isIncluded, listExampleFiles, snapshotTree, transformPackageJson, transformSource, walkFiles } from './exercise.mjs';

const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lines = (...parts) => parts.join('\n');

const made = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-exercise-test-'));
  made.push(dir);
  return dir;
}

describe('transformSource', () => {
  it('leaves a file without markers byte for byte, blank runs included', () => {
    const source = lines("import a from 'a';", '', '', 'a();', '');
    expect(transformSource(source, 'x.ts')).toBe(source);
  });

  it('removes a marked block and collapses the blank lines around it', () => {
    const source = lines("import a from 'a';", '', '// exercise:begin-remove', 'wire();', '// exercise:end', '', 'a();', '');
    expect(transformSource(source, 'x.ts')).toBe(lines("import a from 'a';", '', 'a();', ''));
  });

  it('writes an else branch uncommented, keeping indentation and turning "//" into a blank line', () => {
    const source = lines('const x = 1;', '  // exercise:begin-remove', '  wired();', '  // exercise:else', '  // plain();', '  //', '  // /** doc */', '  // exercise:end', '');
    expect(transformSource(source, 'x.ts')).toBe(lines('const x = 1;', '  plain();', '', '  /** doc */', ''));
  });

  it.each([
    ['a nested begin', lines('// exercise:begin-remove', '// exercise:begin-remove', '// exercise:end'), 'x.ts:2: // exercise:begin-remove inside a block opened at line 1'],
    ['an else without a begin', lines('// exercise:else'), 'x.ts:1: // exercise:else without // exercise:begin-remove'],
    ['a second else', lines('// exercise:begin-remove', '// exercise:else', '// exercise:else', '// exercise:end'), 'x.ts:3: // exercise:else without // exercise:begin-remove'],
    ['an end without a begin', lines('// exercise:end'), 'x.ts:1: // exercise:end without // exercise:begin-remove'],
    ['a block never closed', lines('a();', '// exercise:begin-remove', 'b();'), 'x.ts: the block opened at line 2 is never closed with // exercise:end'],
    ['an unknown marker', lines('// exercise:remove'), 'x.ts:1: unknown marker // exercise:remove'],
    ['an uncommented else line', lines('// exercise:begin-remove', '// exercise:else', 'plain();', '// exercise:end'), 'x.ts:3: a line in an else branch must start with "// " or be "//"'],
  ])('fails on %s, naming the file and line', (_label, source, message) => {
    expect(() => transformSource(source, 'x.ts')).toThrow(message);
  });
});

describe('transformPackageJson', () => {
  const wired = {
    name: '@ironbird-examples/bare-redux',
    private: true,
    license: 'MIT',
    version: '0.0.0',
    scripts: {
      android: 'react-native run-android',
      ios: 'react-native run-ios',
      start: 'react-native start',
      'bundle:release': 'mkdir -p build && react-native bundle --platform ios',
      'make:exercise': 'node scripts/make-exercise.mjs',
      typecheck: 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json',
      test: 'vitest run --project unit',
    },
    dependencies: { '@ironbird/core': 'workspace:*', '@ironbird/react-native': 'workspace:*', '@ironbird/redux': 'workspace:*', '@reduxjs/toolkit': '^2.13.0', react: '19.2.3', 'react-native': '0.87.1', zod: '^4.2.0' },
    devDependencies: { '@ironbird/cli': 'workspace:*', '@ironbird/testing': 'workspace:*', '@types/react': '~19.2.18' },
    engines: { node: '>= 22.11.0' },
  };

  it('drops ironbird and Zod, renames the app, keeps the app scripts, and adds TypeScript', () => {
    const result = JSON.parse(transformPackageJson(JSON.stringify(wired)));
    expect(Object.keys(result)).toEqual(['name', 'version', 'private', 'scripts', 'dependencies', 'devDependencies', 'engines']);
    expect(result).toEqual({
      name: 'bare-redux',
      version: '0.0.0',
      private: true,
      scripts: {
        android: 'react-native run-android',
        ios: 'react-native run-ios',
        start: 'react-native start',
        'bundle:release': 'mkdir -p build && react-native bundle --platform ios',
        typecheck: 'tsc --noEmit -p tsconfig.json',
      },
      dependencies: { '@reduxjs/toolkit': '^2.13.0', react: '19.2.3', 'react-native': '0.87.1' },
      devDependencies: { '@types/react': '~19.2.18', typescript: '^6.0.3' },
      engines: { node: '>= 22.11.0' },
    });
  });

  it('refuses an ironbird or workspace dependency it does not know how to drop', () => {
    const extra = { ...wired, dependencies: { ...wired.dependencies, '@ironbird/xstate': 'workspace:*' } };
    expect(() => transformPackageJson(JSON.stringify(extra))).toThrow('package.json: unexpected ironbird dependency @ironbird/xstate');
  });
});

describe('isIncluded', () => {
  it.each([
    ['App.tsx', true],
    ['src/store/todos.ts', true],
    ['src/app/instance.ts', true],
    ['ios/Podfile', true],
    ['.gitignore', true],
    ['src/ironbird/headless.ts', false],
    ['ironbird/scenarios/ack-reorder.yaml', false],
    ['ironbird.config.ts', false],
    ['test/cli.test.ts', false],
    ['src/store/todos.test.ts', false],
    ['scripts/make-exercise.mjs', false],
    ['exercise/TASK.md', false],
    ['integration-exercise/App.tsx', false],
    ['eval/run.mjs', false],
    ['README.md', false],
    ['tsconfig.test.json', false],
  ])('%s → %s', (file, expected) => {
    expect(isIncluded(file)).toBe(expected);
  });
});

describe('findLeaks', () => {
  it('names every line that mentions ironbird, in any case, or an exercise marker', () => {
    const files = [
      { file: 'a.ts', text: lines('ok', 'import x from "@ironbird/core";', '') },
      { file: 'b.js', text: lines('// exercise:end', '// IronBird was here') },
      { file: 'c.md', text: 'clean' },
    ];
    expect(findLeaks(files)).toEqual(['a.ts:2: import x from "@ironbird/core";', 'b.js:1: // exercise:end', 'b.js:2: // IronBird was here']);
  });
});

describe('diffTrees', () => {
  it('lists missing, extra, changed, and re-moded files by path', () => {
    const entry = (hash, executable = false) => ({ hash, executable });
    const committed = new Map([
      ['a', entry('1')],
      ['b', entry('2')],
      ['c', entry('3')],
    ]);
    const generated = new Map([
      ['a', entry('1', true)],
      ['c', entry('4')],
      ['d', entry('5')],
    ]);
    expect(diffTrees(committed, generated)).toEqual(['a: executable bit differs', 'b: missing from the generated copy', 'c: content differs', 'd: not in the committed copy']);
  });
});

describe('generateExercise on this app', () => {
  it('writes the app without ironbird, with the exercise material and the template intact', async () => {
    const outDir = await tmp();
    const { files } = await generateExercise({ exampleDir, outDir });
    expect(files).toEqual(
      expect.arrayContaining(['App.tsx', 'index.js', 'metro.config.js', 'package.json', 'tsconfig.json', 'src/app/instance.ts', 'src/store/store.ts', 'src/sync/server.ts', 'src/sync/real-timers.ts', 'README.md', 'TASK.md', 'CHECKLIST.md', 'RESULTS.md', 'acceptance.yaml', 'ios/Podfile', 'android/gradlew']),
    );
    expect(files.filter((file) => /ironbird|\.test\.|^test\/|^scripts\/|^exercise\//.test(file))).toEqual([]);
    // exercise/ is the material's single source: each copy is byte for byte its source.
    for (const file of ['README.md', ...MATERIAL_FILES]) {
      expect(await readFile(path.join(outDir, file)), file).toEqual(await readFile(path.join(exampleDir, 'exercise', file)));
    }

    // Rule 9 in the exercise too: the store's simulated server gets an injected real clock, and the
    // platform timer is called only inside that clock's implementation.
    const instance = await readFile(path.join(outDir, 'src/app/instance.ts'), 'utf8');
    expect(instance).toContain('createSimulatedServer(createRealTimers())');
    expect(instance).not.toMatch(/ironbird|__DEV__|setTimeout/i);
    const timers = await readFile(path.join(outDir, 'src/sync/real-timers.ts'), 'utf8');
    expect(timers).toContain('return { setTimeout: (callback, ms) => setTimeout(callback, ms) };');
    expect(timers).not.toMatch(/ironbird/i);
    const appCode = files.filter((file) => file === 'App.tsx' || file === 'index.js' || /^src\/.*\.tsx?$/.test(file));
    const callsPlatformTimer = [];
    for (const file of appCode) {
      if (/(?<![.\w])(?:setTimeout|setInterval)\(/.test(await readFile(path.join(outDir, file), 'utf8'))) callsPlatformTimer.push(file);
    }
    expect(callsPlatformTimer).toEqual(['src/sync/real-timers.ts']);
    const index = await readFile(path.join(outDir, 'index.js'), 'utf8');
    expect(index).not.toContain('__DEV__');
    expect(index).toContain('AppRegistry.registerComponent(appName, () => App);');
    const metro = await readFile(path.join(outDir, 'metro.config.js'), 'utf8');
    expect(metro).toContain('const config = {};');
    expect(metro).not.toContain('watchFolders');
    expect(JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8')).dependencies).not.toHaveProperty('zod');
    expect((await stat(path.join(outDir, 'android/gradlew'))).mode & 0o111).not.toBe(0);
  }, 60_000);

  it('matches the committed integration-exercise byte for byte', async () => {
    const outDir = await tmp();
    await generateExercise({ exampleDir, outDir });
    const committedDir = path.join(exampleDir, 'integration-exercise');
    const committed = await snapshotTree(committedDir, listExampleFiles(committedDir));
    const generated = await snapshotTree(outDir, await walkFiles(outDir));
    expect(diffTrees(committed, generated), 'integration-exercise is stale: run `pnpm --filter @ironbird-examples/bare-redux make:exercise` and commit the result').toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit examples/bare-redux/scripts/lib/exercise.test.mjs`
Expected: FAIL, cannot resolve `./exercise.mjs`.

- [ ] **Step 3: Write the generator**

Create `examples/bare-redux/scripts/lib/exercise.mjs`:

```js
// Generates examples/bare-redux/integration-exercise: this app with every ironbird file and line
// removed (M5 design D7), plus the exercise's README, task sheet, checklist, results sheet, and
// acceptance scenario, copied from exercise/, their single source. Lines that exist only for ironbird, or only because this app lives in the monorepo,
// sit between markers:
//
//   // exercise:begin-remove    removed, through the matching end marker
//   // exercise:else            optional: the lines up to the end marker are commented out here and
//                               written to the exercise uncommented ("// " stripped once; "//" alone
//                               becomes a blank line)
//   // exercise:end
//
// The copy is committed, and exercise.test.mjs regenerates it and compares, so the two can't drift.
// The comparison covers the material copies too: edit exercise/, never integration-exercise/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Paths, relative to the app, that never reach the exercise: ironbird, tests, tooling, and the material's sources. */
export const EXCLUDED_PATHS = ['integration-exercise', 'exercise', 'eval', 'scripts', 'test', 'ironbird', 'src/ironbird', 'ironbird.config.ts', 'tsconfig.test.json', 'README.md'];
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
const TRANSFORMED = new Set(['.js', '.ts', '.tsx']);

/**
 * The exercise's material: about ironbird, so exempt from the leak check, and the only exercise
 * files that may name it (plan 5's eval/lib/paths.mjs MATERIALS must equal this list).
 */
export const MATERIAL_FILES = ['TASK.md', 'CHECKLIST.md', 'RESULTS.md', 'acceptance.yaml'];

/**
 * Overlay sources in this app → path in the exercise. exercise/ is the single source of truth for
 * these files: change them there and regenerate, never in integration-exercise/. The app's README
 * is leak-checked like app code; the four materials are not.
 */
export const OVERLAY_FILES = Object.fromEntries(['README.md', ...MATERIAL_FILES].map((file) => [`exercise/${file}`, file]));

export const IRONBIRD_DEPENDENCIES = ['@ironbird/core', '@ironbird/react-native', '@ironbird/redux', 'zod'];
export const IRONBIRD_DEV_DEPENDENCIES = ['@ironbird/cli', '@ironbird/testing'];
export const KEPT_SCRIPTS = ['android', 'ios', 'start', 'bundle:release'];
/** The exercise is a standalone app, so it brings the TypeScript the 0.87 template declares. */
export const TYPESCRIPT_RANGE = '^6.0.3';

const BEGIN = '// exercise:begin-remove';
const ELSE = '// exercise:else';
const END = '// exercise:end';

export function isIncluded(file) {
  if (TEST_FILE.test(file)) return false;
  return !EXCLUDED_PATHS.some((excluded) => file === excluded || file.startsWith(`${excluded}/`));
}

export function transformSource(source, file) {
  const out = [];
  let state = 'keep';
  let openedAt = 0;
  let marked = false;
  source.split('\n').forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    const trimmed = line.trim();
    if (trimmed === BEGIN) {
      if (state !== 'keep') throw new Error(`${where}: ${BEGIN} inside a block opened at line ${openedAt}`);
      state = 'remove';
      openedAt = index + 1;
      marked = true;
      return;
    }
    if (trimmed === ELSE) {
      if (state !== 'remove') throw new Error(`${where}: ${ELSE} without ${BEGIN}`);
      state = 'else';
      return;
    }
    if (trimmed === END) {
      if (state === 'keep') throw new Error(`${where}: ${END} without ${BEGIN}`);
      state = 'keep';
      return;
    }
    if (trimmed.startsWith('// exercise:')) throw new Error(`${where}: unknown marker ${trimmed}`);
    if (state === 'remove') return;
    if (state === 'else') {
      const indent = /^\s*/.exec(line)[0];
      const rest = line.slice(indent.length);
      if (rest === '//') out.push('');
      else if (rest.startsWith('// ')) out.push(indent + rest.slice(3));
      else throw new Error(`${where}: a line in an else branch must start with "// " or be "//"`);
      return;
    }
    out.push(line);
  });
  if (state !== 'keep') throw new Error(`${file}: the block opened at line ${openedAt} is never closed with ${END}`);
  const result = out.join('\n');
  // Removing a block leaves the blank lines that framed it; one is enough.
  return marked ? result.replace(/\n{3,}/g, '\n\n') : result;
}

function withoutDependencies(dependencies = {}, drop) {
  const kept = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (drop.includes(name)) continue;
    if (name.startsWith('@ironbird/') || String(range).startsWith('workspace:')) {
      throw new Error(`package.json: unexpected ironbird dependency ${name}; add it to the generator's dependency lists or remove it`);
    }
    kept[name] = range;
  }
  return kept;
}

export function transformPackageJson(source) {
  const pkg = JSON.parse(source);
  const scripts = {};
  for (const name of KEPT_SCRIPTS) {
    if (pkg.scripts?.[name] === undefined) throw new Error(`package.json: the exercise needs the script ${name}`);
    scripts[name] = pkg.scripts[name];
  }
  scripts.typecheck = 'tsc --noEmit -p tsconfig.json';
  const devDependencies = { ...withoutDependencies(pkg.devDependencies, IRONBIRD_DEV_DEPENDENCIES), typescript: TYPESCRIPT_RANGE };
  const result = {
    name: 'bare-redux',
    version: pkg.version,
    private: true,
    scripts,
    dependencies: withoutDependencies(pkg.dependencies, IRONBIRD_DEPENDENCIES),
    devDependencies: Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    engines: pkg.engines,
  };
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** Lines that still mention ironbird, in any case, or an exercise marker, as `file:line: text`. */
export function findLeaks(files) {
  const leaks = [];
  for (const { file, text } of files) {
    text.split('\n').forEach((line, index) => {
      if (/ironbird|exercise:/i.test(line)) leaks.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return leaks;
}

/** Files under `dir` that git tracks or would track (ignored files left out), relative to `dir`, sorted. */
export function listExampleFiles(dir) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output
    .split('\0')
    .filter((file) => file !== '' && existsSync(path.join(dir, file)))
    .sort();
}

/** Every file under `dir`, relative to it with forward slashes, sorted. */
export async function walkFiles(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full, base)));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

export async function generateExercise({ exampleDir, outDir }) {
  const written = [];
  const put = async (relative, content, mode) => {
    const target = path.join(outDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    await chmod(target, mode);
    written.push(relative);
  };

  for (const file of listExampleFiles(exampleDir).filter(isIncluded)) {
    const source = path.join(exampleDir, file);
    const mode = (await stat(source)).mode & 0o777;
    const bytes = await readFile(source);
    if (file === 'package.json') await put(file, transformPackageJson(bytes.toString('utf8')), mode);
    else if (TRANSFORMED.has(path.extname(file))) await put(file, transformSource(bytes.toString('utf8'), file), mode);
    else await put(file, bytes, mode);
  }
  for (const [from, to] of Object.entries(OVERLAY_FILES)) {
    const source = path.join(exampleDir, from);
    await put(to, await readFile(source), (await stat(source)).mode & 0o777);
  }

  const exempt = new Set(MATERIAL_FILES);
  const texts = [];
  for (const file of written) {
    if (exempt.has(file)) continue;
    const bytes = await readFile(path.join(outDir, file));
    if (!bytes.subarray(0, 8_000).includes(0)) texts.push({ file, text: bytes.toString('utf8') });
  }
  const leaks = findLeaks(texts);
  if (leaks.length > 0) throw new Error(`The exercise copy still mentions ironbird or an exercise marker:\n${leaks.join('\n')}`);
  return { files: written.sort() };
}

/** Content hash and executable bit of each file, keyed by its relative path. */
export async function snapshotTree(dir, files) {
  const tree = new Map();
  for (const file of files) {
    const full = path.join(dir, file);
    const hash = createHash('sha256').update(await readFile(full)).digest('hex');
    tree.set(file, { hash, executable: ((await stat(full)).mode & 0o111) !== 0 });
  }
  return tree;
}

/** What differs between the committed copy and a fresh one, one line per path, sorted by path. */
export function diffTrees(committed, generated) {
  const problems = [];
  for (const file of [...new Set([...committed.keys(), ...generated.keys()])].sort()) {
    const before = committed.get(file);
    const after = generated.get(file);
    if (!after) problems.push(`${file}: missing from the generated copy`);
    else if (!before) problems.push(`${file}: not in the committed copy`);
    else if (before.hash !== after.hash) problems.push(`${file}: content differs`);
    else if (before.executable !== after.executable) problems.push(`${file}: executable bit differs`);
  }
  return problems;
}
```

Create `examples/bare-redux/scripts/make-exercise.mjs`:

```js
#!/usr/bin/env node
// Regenerates integration-exercise/ from this app and the material in exercise/ (M5 design D7). Run
// it after any change to either, then commit the result: scripts/lib/exercise.test.mjs fails while
// the committed copy is stale. It replaces the whole copy, so a hand edit there is lost by design.
// It generates into a temporary directory first, so a leak or a bad marker never half-writes the copy.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateExercise } from './lib/exercise.mjs';

const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(exampleDir, 'integration-exercise');

const trial = await mkdtemp(path.join(os.tmpdir(), 'ironbird-exercise-'));
try {
  await generateExercise({ exampleDir, outDir: trial });
} finally {
  await rm(trial, { recursive: true, force: true });
}
await rm(outDir, { recursive: true, force: true });
const { files } = await generateExercise({ exampleDir, outDir });
console.log(`Wrote ${files.length} files to ${path.relative(process.cwd(), outDir) || '.'}`);
```

- [ ] **Step 4: Write the exercise material**

These five files in `exercise/` are the material's single source. The generator copies them into `integration-exercise/`; plan 5's Task 7 later rewrites `TASK.md`, `CHECKLIST.md`, `RESULTS.md`, and `acceptance.yaml` here and reruns `make:exercise`.

Create `examples/bare-redux/exercise/README.md`:

````md
# Bare Redux to-dos

A bare React Native 0.87 app: a to-do list on Redux Toolkit. Every change is saved to a sync server, simulated in `src/sync/server.ts`, which acknowledges saves after 300 ms or 100 ms, alternating, so acknowledgements can arrive out of order. Each to-do shows "Saving…" until the server has acknowledged its latest revision.

## Layout

| Path | What it holds |
|---|---|
| `App.tsx` | The screen |
| `src/store/todos.ts` | The state, the action creators (`added`, `toggled`, `renamed`, and the sync actions), and the reducers |
| `src/store/middleware.ts` | Saves every change through the sync port and reports each acknowledgement |
| `src/store/store.ts` | `createAppStore(ports, options)` |
| `src/sync/port.ts`, `src/sync/server.ts` | The sync port and the simulated server |
| `src/app/instance.ts` | The store the screen renders |

## Run

```sh
npm install
cd ios && pod install && cd ..     # set LANG=en_US.UTF-8 if CocoaPods warns about the encoding
npm start                          # Metro, in its own terminal
npm run ios                        # build and launch; add `-- --udid <udid>` to pick a simulator
npm run typecheck
```
````

Create `examples/bare-redux/exercise/TASK.md`:

```md
# Integration exercise: add ironbird to a bare React Native app

This folder is a bare React Native 0.87 app: a to-do list on Redux Toolkit whose changes are saved to a simulated sync server. It has no ironbird in it. Your task is to add ironbird using **only the ironbird documentation you were given**: the README and the `docs/` pages. Don't read ironbird's source code, its tests, or the examples in its repository.

Write your start time in RESULTS.md before you begin, and your end time when every check in CHECKLIST.md passes or when you stop.

## Setup

1. Copy this folder somewhere outside the ironbird repository and run `npm install` in the copy.
2. Install the ironbird packages and Zod 4. Until 0.1.0 is on npm, install them from the tarballs you were given (the maintainer makes them with `node scripts/pack-packages.mjs <dir> core react-native redux cli` in the ironbird repository):

       npm install <dir>/ironbird-core-*.tgz <dir>/ironbird-react-native-*.tgz <dir>/ironbird-redux-*.tgz zod@^4.2.0
       npm install --save-dev <dir>/ironbird-cli-*.tgz

   Once 0.1.0 is published, `npm install @ironbird/core @ironbird/react-native @ironbird/redux zod` and `npm install --save-dev @ironbird/cli` do the same.

## What to build

- An ironbird config for the app id `com.example.bareredux`, with a headless entry, so `npx ironbird serve` runs the app in Node without a simulator.
- Three commands, served through the Redux adapter, each dispatching the app's existing action:

  | Command | Payload | Dispatches |
  |---|---|---|
  | `todos.add` | `{ title }`, a non-empty string | `added` |
  | `todos.toggle` | `{ id }`, such as `t1` | `toggled` |
  | `todos.rename` | `{ id, title }` | `renamed` |

- The target's state is the store's root state, not a projection: the acceptance scenario reads `todos.items` and `sync.inFlight`.
- In the headless entry the simulated sync server runs on ironbird's clock, so the scenario's `clock` step decides when saves are acknowledged.
- The in-app bridge, started in development builds only, so the app can be driven on a simulator and release bundles don't contain it.

You may add files and restructure as you see fit, but don't change what the app does.

## Done when

Every check in CHECKLIST.md passes. Running the app on a simulator is optional and isn't scored.
```

Create `examples/bare-redux/exercise/CHECKLIST.md`:

````md
# Checklist

Run each check from the root of your copy, after `npm install`. A check passes only as written.

1. **The daemon loads the headless entry.** In one terminal run `npx ironbird serve`. In another, `npx ironbird status` exits 0 and its `targets` include `{ "id": "headless", "appId": "com.example.bareredux" }`.
2. **The commands are declared.** `npx ironbird commands` exits 0 and lists exactly `todos.add`, `todos.rename`, and `todos.toggle`.
3. **The acceptance scenario passes headlessly.** With the daemon running, `npx ironbird scenario run acceptance.yaml` exits 0.
4. **The bridge is in development builds.** The code that calls `startBridge` runs only when `__DEV__` is true, and

   ```sh
   mkdir -p build
   npx react-native bundle --platform ios --dev true --entry-file index.js --bundle-output build/dev.jsbundle
   npx ironbird verify-bundle build/dev.jsbundle
   ```

   exits 1: the bridge marker is found.
5. **The bridge is not in release builds.**

   ```sh
   npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output build/release.jsbundle
   npx ironbird verify-bundle build/release.jsbundle
   ```

   exits 0.
````

Create `examples/bare-redux/exercise/RESULTS.md`:

```md
# Results

| | |
|---|---|
| Participant | |
| Date | |
| Ironbird version or commit of the tarballs | |
| Started (local time) | |
| Finished (local time) | |
| Breaks (total minutes) | |
| Elapsed, excluding breaks (hours:minutes) | |
| Checks passed (of 5) | |

## Where the docs fell short

One line per gap: what you needed, where you looked, and what you did instead.

## Notes
```

Create `examples/bare-redux/exercise/acceptance.yaml`:

```yaml
name: Acceptance - add, rename, and sync
description: The wiring check for the integration exercise. A to-do is added and renamed at once; the sync server acknowledges the rename first, and once both acknowledgements arrive nothing is in flight and the to-do is saved at its latest revision.
target: headless   # the clock step needs ironbird's manual clock
steps:
  - send: todos.add
    payload: { title: Buy milk }
  - expect: sync.inFlight
    equals: 1
  - send: todos.rename
    payload: { id: t1, title: Buy oat milk }
  - expect: sync.inFlight
    equals: 2
  - clock: 300ms
  - expect: sync.inFlight
    equals: 0
  - expect: todos.items.0.title
    equals: Buy oat milk
  - expect: todos.items.0.syncedRev
    equals: 2
```

- [ ] **Step 5: Prove the acceptance scenario passes on the wired app**

Append to the `describe` block in `examples/bare-redux/src/ironbird/scenarios.test.ts`:

```ts
  it('passes the integration exercise acceptance scenario', async () => {
    const result = await runScenario(path.resolve(__dirname, '../../exercise/acceptance.yaml'), { headless });
    expect(result.failedStep).toBeUndefined();
    expect(result.passed).toBe(true);
  });
```

Run: `pnpm exec vitest run --project unit examples/bare-redux/src/ironbird/scenarios.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Add the scripts, generate the copy, and run the generator tests**

In `examples/bare-redux/package.json`, add `"make:exercise": "node scripts/make-exercise.mjs"` after `bundle:release`, and change `typecheck` to:

```json
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p integration-exercise/tsconfig.json",
```

The third `tsc` typechecks the committed exercise as a standalone app; its `extends` and imports resolve through this app's `node_modules`, one directory up.

Run:

```sh
pnpm --filter @ironbird-examples/bare-redux make:exercise
pnpm exec vitest run --project unit examples/bare-redux/scripts/lib/exercise.test.mjs
pnpm --filter @ironbird-examples/bare-redux typecheck
git status --short examples/bare-redux/integration-exercise | head -5
```

Expected: `Wrote <n> files to integration-exercise`; 32 tests pass (`transformSource` 10, `transformPackageJson` 2, `isIncluded` 16, `findLeaks` 1, `diffTrees` 1, `generateExercise` 2); typecheck prints nothing; `git status` lists the new exercise files. If generation fails with a leak, the message names the file and line: fix the app file (move the line inside markers, or reword an app comment that mentions ironbird), never the leak check. If the exercise's typecheck reports `Cannot find name 'setTimeout'` in `src/sync/real-timers.ts`, React Native's global declarations didn't load with `types: []`: add `"types": ["react-native"]` to `examples/bare-redux/tsconfig.json` (the exercise copies it), regenerate, and re-run.

- [ ] **Step 7: Write the failing pack test**

Create `scripts/pack-packages.test.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packPackages } from './pack-packages.mjs';

describe('packPackages', () => {
  it('refuses a name that is not a published ironbird package, before packing anything', () => {
    expect(() => packPackages(['core', 'checkout'], path.join(os.tmpdir(), 'ironbird-never-created'))).toThrow(
      'Unknown package checkout; expected one of core, react-native, redux, xstate, cli, testing',
    );
  });

  it('packs the bridge with real versions in place of workspace ranges', async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'ironbird-pack-'));
    try {
      const [tarball, ...rest] = packPackages(['react-native'], out);
      expect(rest).toEqual([]);
      expect(path.basename(tarball)).toMatch(/^ironbird-react-native-\d+\.\d+\.\d+\.tgz$/);
      const manifest = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout;
      expect(JSON.parse(manifest)).toMatchObject({ name: '@ironbird/react-native' });
      expect(manifest).not.toContain('workspace:');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);
});
```

Run: `pnpm exec vitest run --project unit scripts/pack-packages.test.mjs`
Expected: FAIL, cannot resolve `./pack-packages.mjs`.

- [ ] **Step 8: Write the pack script**

Create `scripts/pack-packages.mjs`:

```js
#!/usr/bin/env node
// Packs named @ironbird packages with `pnpm pack`, which turns workspace ranges into the versions on
// this branch, for installing outside the workspace: the compat legs (M5 design §8) and the
// integration exercise (examples/bare-redux/exercise/TASK.md). Run `pnpm build` first.
// Usage: node scripts/pack-packages.mjs <out-dir> <name...>, names from PACKABLE.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKABLE = ['core', 'react-native', 'redux', 'xstate', 'cli', 'testing'];

/** Packs each named package into `outDir` and returns the tarball paths, in the order of `names`. */
export function packPackages(names, outDir) {
  for (const name of names) {
    if (!PACKABLE.includes(name)) throw new Error(`Unknown package ${name}; expected one of ${PACKABLE.join(', ')}`);
  }
  mkdirSync(outDir, { recursive: true });
  return names.map((name) => {
    if (!existsSync(path.join(repo, 'packages', name, 'dist'))) throw new Error(`packages/${name}/dist is missing: run pnpm build first`);
    const result = spawnSync('pnpm', ['--filter', `@ironbird/${name}`, 'pack', '--pack-destination', outDir], { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`pnpm pack for @ironbird/${name} failed:\n${result.stdout}${result.stderr}`);
    const pattern = new RegExp(`^ironbird-${name}-\\d+\\.\\d+\\.\\d+.*\\.tgz$`);
    const tarball = readdirSync(outDir).find((file) => pattern.test(file));
    if (!tarball) throw new Error(`pnpm pack for @ironbird/${name} wrote no tarball to ${outDir}`);
    return path.join(outDir, tarball);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [outDir, ...names] = process.argv.slice(2);
  if (!outDir || names.length === 0) {
    console.error('Usage: node scripts/pack-packages.mjs <out-dir> <name...>');
    process.exit(2);
  }
  console.log(JSON.stringify({ tarballs: packPackages(names, path.resolve(outDir)) }, null, 2));
}
```

Run: `pnpm exec vitest run --project unit scripts/pack-packages.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 9: Lint and commit**

Run: `pnpm exec eslint examples/bare-redux scripts vitest.config.ts`
Expected: no output.

```sh
git add examples/bare-redux scripts/pack-packages.mjs scripts/pack-packages.test.mjs vitest.config.ts
git commit -m "Generate the bare-redux integration exercise with its task sheet and checklist"
```

---
### Task 5: The `compat` CI job

**Files:**
- Create: `scripts/compat/lib.mjs`, `scripts/compat/lib.test.mjs`, `scripts/compat/proc.mjs`, `scripts/compat/bare-leg.mjs`, `scripts/compat/expo-leg.mjs`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/evals/m5-compat-and-ios.md`

**Interfaces:**
- Consumes: `packPackages(names, outDir)` (Task 4); `packages/cli/dist/bin.js verify-bundle <path> --json` (exit 0 clean, 1 marker found); `examples/checkout`'s `EXPO_PUBLIC_FORCE_BRIDGE` switch in its `index.js`.
- Produces:
  - `scripts/compat/lib.mjs`: `parseLegArgs(argv: string[]): { reactNative: string; cli: string }`, `assertVersion(name: string, actual: string, wanted: string): void`, `STEP_TIMEOUT_MS = { init: 600_000, install: 300_000 }` (the fetch steps' time limits; Step 6's measurement may raise them), `isFetchFailure(output: string): boolean`, `classifyFailure(result: { status: number; timedOut?: boolean; output: string }): null | 'fetch-timeout' | 'fetch' | 'other'`, `retryOnFetchFailure(attempt: (n: number) => { status: number; timedOut?: boolean; output: string }): { status; timedOut?; output }` (one retry after `fetch-timeout` or `fetch`), `WIRING_FILE = 'ironbird-wiring.ts'`, `WIRING_SOURCE: string`, `WIRING_TSCONFIG: string`, `patchIndex(source: string): string`, `checkVerify(result: { status: number; stdout: string }, expectation: 'clean' | 'marker'): string | null`, `summaryTable(title: string, rows: Array<Record<string, string | number>>): string`.
  - `scripts/compat/proc.mjs`: `run(command, args, { cwd?, env?, retry?, timeoutMs?, beforeRetry? })` (kills the command at `timeoutMs` and reports it as timed out; throws on a non-zero exit or a timeout that wasn't retried away; logs each command's duration as `[compat] <command> took <s> s`), `verifyBundle(cliBin, target): { status, stdout, output }`, `writeSummary(markdown)`.
  - CLI: `node scripts/compat/bare-leg.mjs --react-native <x.y.z> --cli <x.y.z>`; `node scripts/compat/expo-leg.mjs`.
  - CI job `compat` with legs `rn-0.86` (0.86.3, CLI 20.1.0), `rn-0.87` (0.87.1, CLI 20.2.0), `expo-57`, and a `timeout-minutes` computed from Step 6's cold-run measurement; `check` needs `[test, compat]`.

- [ ] **Step 1: Write the failing helper tests**

Create `scripts/compat/lib.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { STEP_TIMEOUT_MS, WIRING_FILE, WIRING_SOURCE, WIRING_TSCONFIG, assertVersion, checkVerify, classifyFailure, isFetchFailure, parseLegArgs, patchIndex, retryOnFetchFailure, summaryTable } from './lib.mjs';

// The 0.86.3 and 0.87.2 community templates' index.js, verbatim.
const TEMPLATE_INDEX = [
  '/**',
  ' * @format',
  ' */',
  '',
  "import { AppRegistry } from 'react-native';",
  "import App from './App';",
  "import { name as appName } from './app.json';",
  '',
  'AppRegistry.registerComponent(appName, () => App);',
  '',
].join('\n');

describe('parseLegArgs', () => {
  it('reads both pins', () => {
    expect(parseLegArgs(['--react-native', '0.87.1', '--cli', '20.2.0'])).toEqual({ reactNative: '0.87.1', cli: '20.2.0' });
  });

  it.each([
    [['--react-native', '0.87'], '--react-native needs an exact x.y.z version, got 0.87'],
    [['--cli'], '--cli needs an exact x.y.z version, got nothing'],
    [['--react-native', '0.87.1'], 'Both --react-native and --cli are required'],
    [['--rn', '0.87.1', '--cli', '20.2.0'], 'Unknown option --rn; expected --react-native <x.y.z> --cli <x.y.z>'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseLegArgs(argv)).toThrow(message);
  });
});

describe('assertVersion', () => {
  it('accepts an exact pin, a minor, and a major', () => {
    expect(() => assertVersion('react-native', '0.87.1', '0.87.1')).not.toThrow();
    expect(() => assertVersion('react-native', '0.86.3', '0.86')).not.toThrow();
    expect(() => assertVersion('expo', '57.0.23', '57')).not.toThrow();
  });

  it.each([
    ['react-native', '0.87.10', '0.87.1'],
    ['react-native', '0.86.3', '0.87'],
    ['expo', '570.0.0', '57'],
  ])('refuses %s %s for %s', (name, actual, wanted) => {
    expect(() => assertVersion(name, actual, wanted)).toThrow(`${name} resolved to ${actual}, but this leg needs ${wanted}`);
  });
});

describe('fetch failures', () => {
  it.each([
    'npm error code ETIMEDOUT',
    'npm error network request to https://registry.npmjs.org/react-native failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org',
    'npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/metro',
    'npm error code ECONNRESET',
    'Error: socket hang up',
  ])('counts %j as a fetch failure', (output) => {
    expect(isFetchFailure(output)).toBe(true);
  });

  it.each([
    "error TS2307: Cannot find module '@ironbird/core'",
    'react-native resolved to 0.86.3, but this leg needs 0.87.1',
    'npm error code ERESOLVE',
    'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@ironbird%2fnope',
    'error Unable to resolve module ./ironbird-wiring',
  ])('does not count %j', (output) => {
    expect(isFetchFailure(output)).toBe(false);
  });

  it('classifies a fetch step that hit its time limit as a fetch timeout, and registry errors as fetch failures', () => {
    expect(classifyFailure({ status: 0, output: '' })).toBeNull();
    expect(classifyFailure({ status: 1, timedOut: true, output: '[compat] npx timed out after 600000 ms' })).toBe('fetch-timeout');
    expect(classifyFailure({ status: 1, output: 'npm error code ETIMEDOUT' })).toBe('fetch');
    expect(classifyFailure({ status: 1, output: 'error TS2307' })).toBe('other');
    // The limits are finite and the install's is the shorter: init fetches the template and installs it.
    expect(STEP_TIMEOUT_MS.init).toBeGreaterThan(STEP_TIMEOUT_MS.install);
    expect(Number.isFinite(STEP_TIMEOUT_MS.init + STEP_TIMEOUT_MS.install)).toBe(true);
  });

  it('retries once after a fetch failure or a fetch timeout and never after any other failure', () => {
    const attempts = (results) => {
      const calls = [];
      const attempt = (n) => {
        calls.push(n);
        return results[n - 1];
      };
      return { calls, attempt };
    };
    const ok = { status: 0, output: '' };
    const blip = { status: 1, output: 'npm error code ETIMEDOUT' };
    const real = { status: 1, output: 'error TS2307' };

    let run = attempts([ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(ok);
    expect(run.calls).toEqual([1]);

    run = attempts([blip, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(ok);
    expect(run.calls).toEqual([1, 2]);

    run = attempts([real, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(real);
    expect(run.calls).toEqual([1]);

    run = attempts([blip, blip, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(blip);
    expect(run.calls).toEqual([1, 2]);

    const stalled = { status: 1, timedOut: true, output: '[compat] npx timed out after 600000 ms' };
    run = attempts([stalled, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(ok);
    expect(run.calls).toEqual([1, 2]);

    run = attempts([stalled, stalled, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(stalled);
    expect(run.calls).toEqual([1, 2]);
  });
});

describe('the wiring', () => {
  it('starts the bridge from index.js in dev builds only, right before the app registers', () => {
    expect(patchIndex(TEMPLATE_INDEX)).toBe(
      [
        '/**',
        ' * @format',
        ' */',
        '',
        "import { AppRegistry } from 'react-native';",
        "import App from './App';",
        "import { name as appName } from './app.json';",
        '',
        'if (__DEV__) {',
        "  require('./ironbird-wiring').startIronbird();",
        '}',
        '',
        'AppRegistry.registerComponent(appName, () => App);',
        '',
      ].join('\n'),
    );
  });

  it('refuses an index.js it already wired or cannot place the wiring in', () => {
    expect(() => patchIndex(patchIndex(TEMPLATE_INDEX))).toThrow('index.js is already wired');
    expect(() => patchIndex("import App from './App';\n")).toThrow('index.js has no AppRegistry.registerComponent call to wire before');
  });

  it('builds a target and starts the bridge, typechecked on its own', () => {
    expect(WIRING_FILE).toBe('ironbird-wiring.ts');
    expect(WIRING_SOURCE).toContain("from '@ironbird/core'");
    expect(WIRING_SOURCE).toContain('startBridge({');
    expect(WIRING_SOURCE).toContain("from 'react-native'");
    expect(JSON.parse(WIRING_TSCONFIG)).toEqual({ extends: './tsconfig.json', include: ['ironbird-wiring.ts'] });
  });
});

describe('checkVerify', () => {
  const output = (found) => JSON.stringify({ scanned: 1, found });
  it('wants exit 0 for a clean bundle and exit 1 for the marker', () => {
    expect(checkVerify({ status: 0, stdout: output([]) }, 'clean')).toBeNull();
    expect(checkVerify({ status: 1, stdout: output([{ file: 'a', offset: 1 }]) }, 'marker')).toBeNull();
    expect(checkVerify({ status: 1, stdout: output([{ file: 'a', offset: 1 }]) }, 'clean')).toBe('expected a clean bundle (exit 0), got exit 1: {"scanned":1,"found":[{"file":"a","offset":1}]}');
    expect(checkVerify({ status: 0, stdout: output([]) }, 'marker')).toBe('expected the bridge marker (exit 1), got exit 0: {"scanned":1,"found":[]}');
    expect(checkVerify({ status: 2, stdout: '' }, 'clean')).toBe('expected a clean bundle (exit 0), got exit 2: ');
  });
});

describe('summaryTable', () => {
  it('renders a Markdown table under a heading', () => {
    expect(summaryTable('compat', [{ bundle: 'ios release', exit: 0 }, { bundle: 'ios dev', exit: 1 }])).toBe(
      ['### compat', '', '| bundle | exit |', '| --- | --- |', '| ios release | 0 |', '| ios dev | 1 |', ''].join('\n'),
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit scripts/compat/lib.test.mjs`
Expected: FAIL, cannot resolve `./lib.mjs`.

- [ ] **Step 3: Write the helpers**

Create `scripts/compat/lib.mjs`:

```js
// Pure helpers for the compat job's legs (M5 design D8 and §8). bare-leg.mjs and expo-leg.mjs do the I/O.

const EXACT = /^\d+\.\d+\.\d+$/;

/** `--react-native 0.87.1 --cli 20.2.0` → `{ reactNative, cli }`. Both pins are exact versions. */
export function parseLegArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--react-native' && flag !== '--cli') throw new Error(`Unknown option ${flag}; expected --react-native <x.y.z> --cli <x.y.z>`);
    if (value === undefined || !EXACT.test(value)) throw new Error(`${flag} needs an exact x.y.z version, got ${value ?? 'nothing'}`);
    options[flag === '--cli' ? 'cli' : 'reactNative'] = value;
  }
  if (!options.reactNative || !options.cli) throw new Error('Both --react-native and --cli are required');
  return options;
}

/** Throws unless `actual` is `wanted` or lies under it: '0.87.1' is exact, '0.86' a minor, '57' a major. */
export function assertVersion(name, actual, wanted) {
  if (actual === wanted || actual.startsWith(`${wanted}.`)) return;
  throw new Error(`${name} resolved to ${actual}, but this leg needs ${wanted}`);
}

/**
 * Time limits for the fetch steps, in milliseconds. A stalled registry fetch is killed at its limit
 * and retried once, so it can't use up the job (spec §12). Task 5 Step 6 measures cold runs and
 * raises a limit that leaves less than three times the measured time.
 */
export const STEP_TIMEOUT_MS = { init: 10 * 60_000, install: 5 * 60_000 };

const FETCH_FAILURE = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|E429|E500|E502|E503|E504)\b|socket hang up|network timeout/i;

/** A registry or network failure, worth one retry (spec §12). A 404, a peer conflict, or a compile error is not. */
export const isFetchFailure = (output) => FETCH_FAILURE.test(output);

/**
 * Why a fetch step's attempt failed: null when it didn't, `fetch-timeout` when it was killed at its
 * time limit, `fetch` for a registry or network error in its output, `other` for anything else. Only
 * fetch steps (template init, npm install) are run with a limit and a retry, so a timeout there is a
 * stalled fetch.
 */
export function classifyFailure(result) {
  if (result.status === 0) return null;
  if (result.timedOut) return 'fetch-timeout';
  return isFetchFailure(result.output) ? 'fetch' : 'other';
}

/**
 * Runs `attempt(1)` and, only when it failed with a fetch failure or a fetch timeout, `attempt(2)`.
 * `attempt` returns `{ status, timedOut?, output }`; the last result is returned for the caller to judge.
 */
export function retryOnFetchFailure(attempt) {
  const first = attempt(1);
  const kind = classifyFailure(first);
  if (kind === null || kind === 'other') return first;
  return attempt(2);
}

/** The minimal wiring a user adds to a bare app (§8 step 4): a target over a counter, and the bridge. */
export const WIRING_FILE = 'ironbird-wiring.ts';
export const WIRING_SOURCE = [
  "import { createTarget, defineCommands } from '@ironbird/core';",
  "import { startBridge, type BridgeHandle } from '@ironbird/react-native';",
  "import { Platform } from 'react-native';",
  "import { z } from 'zod';",
  '',
  'const commands = defineCommands({',
  "  'counter.add': z.object({ by: z.number().int() }).describe('Add to the counter'),",
  '});',
  '',
  'let count = 0;',
  'const listeners = new Set<() => void>();',
  '',
  'export const target = createTarget({',
  '  commands,',
  '  dispatch: ({ payload }) => {',
  '    count += payload.by;',
  '    for (const listener of listeners) listener();',
  '  },',
  '  getState: () => ({ count }),',
  '  subscribe: (listener) => {',
  '    listeners.add(listener);',
  '    return () => {',
  '      listeners.delete(listener);',
  '    };',
  '  },',
  '});',
  '',
  'export function startIronbird(): BridgeHandle {',
  "  return startBridge({ target, appId: 'com.example.compat', appName: `Compat (${Platform.OS})` });",
  '}',
  '',
].join('\n');

/** Typechecks only the wiring, against the generated project's own tsconfig and TypeScript (§8 step 5). */
export const WIRING_TSCONFIG = `${JSON.stringify({ extends: './tsconfig.json', include: [WIRING_FILE] }, null, 2)}\n`;

const BRIDGE_BLOCK = ['if (__DEV__) {', `  require('./${WIRING_FILE.replace(/\.ts$/, '')}').startIronbird();`, '}', ''].join('\n');

/** Adds the dev-only bridge start to a template index.js, right before the app registers. */
export function patchIndex(source) {
  if (source.includes(WIRING_FILE.replace(/\.ts$/, ''))) throw new Error('index.js is already wired');
  const at = source.indexOf('AppRegistry.registerComponent(');
  if (at === -1) throw new Error('index.js has no AppRegistry.registerComponent call to wire before');
  return `${source.slice(0, at)}${BRIDGE_BLOCK}\n${source.slice(at)}`;
}

/** Null when verify-bundle's exit code is what the bundle needs, else why not. */
export function checkVerify(result, expectation) {
  const output = result.stdout.trim();
  if (expectation === 'clean') return result.status === 0 ? null : `expected a clean bundle (exit 0), got exit ${result.status}: ${output}`;
  return result.status === 1 ? null : `expected the bridge marker (exit 1), got exit ${result.status}: ${output}`;
}

/** A Markdown table under a heading, for the log and the GitHub step summary. */
export function summaryTable(title, rows) {
  const columns = Object.keys(rows[0] ?? {});
  return [
    `### ${title}`,
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((column) => String(row[column])).join(' | ')} |`),
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm exec vitest run --project unit scripts/compat/lib.test.mjs`
Expected: PASS, 26 tests.

- [ ] **Step 5: Write the leg scripts**

Create `scripts/compat/proc.mjs`:

```js
// I/O helpers for the compat legs: run a command with its output echoed, a time limit when asked,
// and one retry after a fetch failure or a fetch timeout when asked; run verify-bundle without
// throwing; and add a table to the step summary.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { classifyFailure, retryOnFetchFailure } from './lib.mjs';

function once(command, args, options) {
  const started = Date.now();
  // spawnSync kills the command with SIGTERM at `timeout` (npm and npx pass it on to their children)
  // and reports it as an ETIMEDOUT error, which is a result here rather than an exception.
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (result.error && !timedOut) throw result.error;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const note = timedOut ? `\n[compat] ${command} timed out after ${options.timeoutMs} ms` : '';
  console.log(`[compat] ${[command, ...args].slice(0, 4).join(' ')} took ${Math.round((Date.now() - started) / 1000)} s${timedOut ? ' (timed out)' : ''}`);
  return { status: timedOut ? 1 : (result.status ?? 1), timedOut, stdout, output: `${stdout}\n${stderr}${note}` };
}

/**
 * Runs a command and throws on a non-zero exit or a timeout. `timeoutMs` kills it at that limit.
 * `retry: true` allows one more attempt after a fetch failure or a fetch timeout (classifyFailure),
 * calling `beforeRetry()` first so a half-finished attempt can be cleared away.
 */
export function run(command, args, options = {}) {
  const attempt = (number) => {
    if (number > 1) options.beforeRetry?.();
    console.log(`\n$ ${[command, ...args].join(' ')}${number > 1 ? '   # retry after a fetch failure or timeout' : ''}`);
    return once(command, args, options);
  };
  const result = options.retry ? retryOnFetchFailure(attempt) : attempt(1);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} ${result.timedOut ? `timed out after ${options.timeoutMs} ms` : `exited with ${result.status}`} (${classifyFailure(result)})`);
  return result;
}

/** `ironbird verify-bundle <target>` from the workspace build; returns its exit status and output. */
export function verifyBundle(cliBin, target) {
  console.log(`\n$ ironbird verify-bundle ${target} --json`);
  return once(process.execPath, [cliBin, 'verify-bundle', target, '--json'], {});
}

export function writeSummary(markdown) {
  console.log(`\n${markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
```

Create `scripts/compat/bare-leg.mjs`:

```js
#!/usr/bin/env node
// One React Native leg of the compat job (M5 design D8 and §8), in a temporary directory outside the
// workspace: generate a bare project with the community CLI this leg pins, check that react-native
// resolved to the pinned version, install @ironbird/core and @ironbird/react-native from tarballs
// packed in this run, add the minimal wiring, typecheck it with the project's own TypeScript, and
// bundle for iOS and Android in release and dev mode. Release bundles must be clean; dev bundles must
// carry the bridge marker, so a clean release result isn't vacuous. This is JavaScript-bundle
// evidence, not a native build.
// Usage: node scripts/compat/bare-leg.mjs --react-native 0.87.1 --cli 20.2.0   (after pnpm build)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackages } from '../pack-packages.mjs';
import { STEP_TIMEOUT_MS, WIRING_FILE, WIRING_SOURCE, WIRING_TSCONFIG, assertVersion, checkVerify, parseLegArgs, patchIndex, summaryTable } from './lib.mjs';
import { run, verifyBundle, writeSummary } from './proc.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliBin = path.join(repo, 'packages/cli/dist/bin.js');
const { reactNative, cli } = parseLegArgs(process.argv.slice(2));
const started = Date.now();
const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `ironbird-compat-rn-${reactNative}-`));
const project = path.join(work, 'CompatApp');
const bin = (name) => path.join(project, 'node_modules', '.bin', name);
console.log(`compat leg: react-native ${reactNative}, @react-native-community/cli ${cli}, in ${work}`);

// 1. A fresh project from the template this React Native version resolves to. A stalled fetch is
// killed at its limit and retried once, after clearing the half-written project.
run('npx', ['--yes', `@react-native-community/cli@${cli}`, 'init', 'CompatApp', '--version', reactNative, '--directory', project, '--pm', 'npm', '--skip-git-init', '--install-pods', 'false'], {
  cwd: work,
  retry: true,
  timeoutMs: STEP_TIMEOUT_MS.init,
  beforeRetry: () => rmSync(project, { recursive: true, force: true }),
});

// 2. The leg is about this version, so prove that is what got installed.
const resolved = createRequire(path.join(project, 'package.json'))('react-native/package.json').version;
assertVersion('react-native', resolved, reactNative);

// 3. The packages as they would be published from this commit.
const tarballs = packPackages(['core', 'react-native'], path.join(work, 'packs'));
run('npm', ['install', '--no-audit', '--no-fund', ...tarballs, 'zod@^4.2.0'], { cwd: project, retry: true, timeoutMs: STEP_TIMEOUT_MS.install });

// 4. The wiring, started from index.js in dev builds only.
writeFileSync(path.join(project, WIRING_FILE), WIRING_SOURCE);
writeFileSync(path.join(project, 'tsconfig.ironbird.json'), WIRING_TSCONFIG);
const indexFile = path.join(project, 'index.js');
writeFileSync(indexFile, patchIndex(readFileSync(indexFile, 'utf8')));

// 5. Typecheck against this React Native version's types.
run(bin('tsc'), ['--noEmit', '-p', 'tsconfig.ironbird.json'], { cwd: project });

// 6 and 7. Release bundles must be clean; dev bundles must carry the marker.
const rows = [];
for (const platform of ['ios', 'android']) {
  for (const mode of ['release', 'dev']) {
    const out = path.join(work, 'bundles', `${platform}-${mode}.jsbundle`);
    mkdirSync(path.dirname(out), { recursive: true });
    run(bin('react-native'), ['bundle', '--platform', platform, '--dev', String(mode === 'dev'), '--entry-file', 'index.js', '--bundle-output', out], { cwd: project });
    const verify = verifyBundle(cliBin, out);
    const expectation = mode === 'dev' ? 'marker' : 'clean';
    rows.push({ bundle: `${platform} ${mode}`, 'verify-bundle exit': verify.status, expected: expectation === 'clean' ? 0 : 1 });
    const problem = checkVerify(verify, expectation);
    if (problem) throw new Error(`${platform} ${mode} bundle: ${problem}`);
  }
}

writeSummary(summaryTable(`compat: react-native ${resolved} (CLI ${cli}), typecheck passed, ${Math.round((Date.now() - started) / 1000)} s`, rows));
```

Create `scripts/compat/expo-leg.mjs`:

```js
#!/usr/bin/env node
// The Expo SDK 57 leg of the compat job (M5 design D8 and §8): the checkout example, on React Native
// 0.86 as SDK 57 pins it. Checks the resolved expo and react-native versions, exports a production
// build, and requires verify-bundle to find no bridge. It then exports again with
// EXPO_PUBLIC_FORCE_BRIDGE=1, the checkout's deliberate "broken build" switch (examples/checkout/index.js),
// and requires the marker, so the clean result isn't vacuous.
// Usage: node scripts/compat/expo-leg.mjs   (after pnpm install and pnpm build)
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVersion, checkVerify, summaryTable } from './lib.mjs';
import { run, verifyBundle, writeSummary } from './proc.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliBin = path.join(repo, 'packages/cli/dist/bin.js');
const checkout = path.join(repo, 'examples/checkout');
const started = Date.now();

const requireFromCheckout = createRequire(path.join(checkout, 'package.json'));
const expo = requireFromCheckout('expo/package.json').version;
const reactNative = requireFromCheckout('react-native/package.json').version;
assertVersion('expo', expo, '57');
assertVersion('react-native', reactNative, '0.86');

const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'ironbird-compat-expo-'));
const exports = [
  { name: 'release', env: { EXPO_PUBLIC_FORCE_BRIDGE: '0' }, expectation: 'clean' },
  { name: 'forced-bridge', env: { EXPO_PUBLIC_FORCE_BRIDGE: '1' }, expectation: 'marker' },
];
const rows = [];
for (const { name, env, expectation } of exports) {
  const out = path.join(work, name);
  run('pnpm', ['exec', 'expo', 'export', '--platform', 'all', '--output-dir', out, '--clear'], { cwd: checkout, env: { CI: '1', EXPO_NO_TELEMETRY: '1', ...env } });
  const verify = verifyBundle(cliBin, out);
  rows.push({ export: name, 'verify-bundle exit': verify.status, expected: expectation === 'clean' ? 0 : 1 });
  const problem = checkVerify(verify, expectation);
  if (problem) throw new Error(`${name} export: ${problem}`);
}

writeSummary(summaryTable(`compat: Expo SDK 57 (expo ${expo}, react-native ${reactNative}), ${Math.round((Date.now() - started) / 1000)} s`, rows));
```

- [ ] **Step 6: Run the three legs locally, and measure the bare legs cold**

These need the network and take several minutes each. Run from the repository root after `pnpm build`, one at a time. The bare legs run with an empty npm cache, so their times are cold-run times, as on a fresh CI runner; keep each one's final table, its wall time, and its `[compat] ... took <s> s` lines for `init` and `install`:

```sh
time npm_config_cache="$(mktemp -d)" node scripts/compat/bare-leg.mjs --react-native 0.86.3 --cli 20.1.0 2>&1 | tee /tmp/compat-rn-0.86.log
time npm_config_cache="$(mktemp -d)" node scripts/compat/bare-leg.mjs --react-native 0.87.1 --cli 20.2.0 2>&1 | tee /tmp/compat-rn-0.87.log
time node scripts/compat/expo-leg.mjs
grep -h '^\[compat\] .* took ' /tmp/compat-rn-0.86.log /tmp/compat-rn-0.87.log
```

Expected: each ends with its `### compat: ...` table, release rows at exit 0 and dev or forced rows at exit 1, and the process exits 0; the `grep` prints one `took` line per command, the `npx --yes @react-native-community/cli@<pin> init` and `npm install` lines among them. From these, write down three numbers for Step 7 and Step 8: **W**, the slowest bare leg's cold wall time in minutes; and the slowest cold `init` and `install` durations. Decision rules for the limits: if a measured cold `init` or `install` took more than a third of its `STEP_TIMEOUT_MS` entry, raise that entry to three times the measured time, rounded up to a whole minute, keep `init` above `install` (the test checks it), rerun `scripts/compat/lib.test.mjs`, and rerun that leg. Other decision rules:

- The 0.86 leg's typecheck fails inside an `@ironbird/*` declaration file, and the 0.87 leg's doesn't: the declarations use syntax newer than the template's TypeScript 5.8. If the fix is confined to how the package emits declarations (its `tsup.config.ts` or a type annotation, under about 20 lines), make it in that package with a changeset, rebuild, and re-run the leg. Otherwise run that leg's typecheck with the workspace's TypeScript instead (`node <repo>/node_modules/typescript/bin/tsc` in place of `bin('tsc')`, behind a `--typescript workspace` flag recorded in the matrix entry) and add "TypeScript 6 is required for type declarations" to `docs/api.md`'s installation notes and an open question row in `docs/spec.md`.
- `react-native bundle --platform ios` fails on a Linux runner with an error naming Xcode, CocoaPods, or the iOS project config, while Android succeeds: drop `ios` from the platform loop for Linux only (`process.platform === 'linux' ? ['android'] : ['ios', 'android']`) and record in the evidence file that the CI bundles are Android's.
- `init` exits non-zero twice with fetch failures: a registry outage, not a defect; re-run the leg later and record the retry.
- Anything else is a real finding: fix it (in a package, with a test and a changeset) before going on, never by loosening the leg.

- [ ] **Step 7: Add the job to CI**

In `.github/workflows/ci.yml`, insert this job between `test` and `check`:

```yaml
  # The compatibility matrix (M5 design D8 and §8): JavaScript-bundle evidence that the packed
  # packages install, typecheck, bundle, and stay out of production bundles on the two most recent
  # React Native minors, each in a freshly generated bare project, and on Expo SDK 57 through the
  # checkout example. It is not native-build evidence: bare-redux's iOS build is verified by hand.
  compat:
    name: compat (${{ matrix.leg }})
    runs-on: ubuntu-latest
    # From Task 5 Step 6's cold-run measurement: ceil(1.5 × W) + 5 + I + N minutes, where W is the
    # slowest bare leg's cold wall time, 5 covers checkout, pnpm install, and pnpm build, and I and N
    # are STEP_TIMEOUT_MS.init and .install in minutes, so a leg whose init and install each stall
    # once, are killed at their limits, and are retried still finishes inside the job's limit.
    timeout-minutes: 32
    strategy:
      fail-fast: false
      matrix:
        include:
          # Each React Native leg pins the exact patch and the community CLI that version's
          # @react-native-community/template declares (template 0.86.3: CLI 20.1.0; 0.87.2: CLI 20.2.0).
          - leg: rn-0.86
            rn: 0.86.3
            cli: 20.1.0
          - leg: rn-0.87
            rn: 0.87.1
            cli: 20.2.0
          - leg: expo-57
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - if: matrix.leg != 'expo-57'
        run: node scripts/compat/bare-leg.mjs --react-native ${{ matrix.rn }} --cli ${{ matrix.cli }}
      - if: matrix.leg == 'expo-57'
        run: node scripts/compat/expo-leg.mjs
```

Replace the `check` job with:

```yaml
  # Branch protection requires a status named `check`. The matrices report `test (node 22)`, `test (node 26)`,
  # and one `compat (...)` per leg, so this job carries the required name and passes only when every leg passed.
  check:
    if: always()
    needs: [test, compat]
    runs-on: ubuntu-latest
    steps:
      - run: test "${{ needs.test.result }}" = "success" && test "${{ needs.compat.result }}" = "success"
```

Check the file parses and has the shape the spec asks for:

```sh
pnpm --filter @ironbird/cli exec node -e "
const YAML = require('yaml');
const ci = YAML.parse(require('fs').readFileSync('../../.github/workflows/ci.yml', 'utf8'));
const legs = ci.jobs.compat.strategy.matrix.include;
console.log(JSON.stringify({ legs: legs.map((leg) => [leg.leg, leg.rn ?? null, leg.cli ?? null]), checkNeeds: ci.jobs.check.needs }));
"
```

Before running it, replace `32` in `timeout-minutes` with the value the comment's formula gives for Step 6's measured W and the final `STEP_TIMEOUT_MS` (32 is the value for W = 8 with the default limits of 10 and 5 minutes), and keep the comment.

Expected: `{"legs":[["rn-0.86","0.86.3","20.1.0"],["rn-0.87","0.87.1","20.2.0"],["expo-57",null,null]],"checkNeeds":["test","compat"]}`. The versions must print as strings; if one prints as a number, quote it in the YAML.

- [ ] **Step 8: Record the local runs**

Create `docs/evals/m5-compat-and-ios.md`, filling every cell from Step 6's output (no cell may hold a value that wasn't observed; write "not run" and the reason instead):

```md
# M5: compatibility legs and the bare-redux iOS build

Raw evidence for two M5 measurements (M5 design §1, §8, and §11), cited by the M5 evals record. The compatibility legs are **JavaScript-bundle evidence**: the packed packages install, typecheck, bundle, and stay out of production bundles on each version. They are not native-build evidence; that is the one hand-run iOS build of `examples/bare-redux`, recorded in its own section.

## Compatibility legs, run locally

<date>, <machine: `sysctl -n machdep.cpu.brand_string`>, macOS <`sw_vers -productVersion`>, Node <`node --version`>, from commit <`git rev-parse --short HEAD`>.

| Leg | Command | Resolved | Typecheck | Bundles: verify-bundle exit (expected) | Wall time |
|---|---|---|---|---|---|
| React Native 0.86 | `node scripts/compat/bare-leg.mjs --react-native 0.86.3 --cli 20.1.0` | react-native <x> | <passed/failed> | ios release <n> (0), ios dev <n> (1), android release <n> (0), android dev <n> (1) | <m:ss> |
| React Native 0.87 | `node scripts/compat/bare-leg.mjs --react-native 0.87.1 --cli 20.2.0` | react-native <x> | <passed/failed> | same four rows | <m:ss> |
| Expo SDK 57 | `node scripts/compat/expo-leg.mjs` | expo <x>, react-native <x> | n/a | release <n> (0), forced-bridge <n> (1) | <m:ss> |

Bare legs ran with an empty npm cache (cold). Slowest cold `init`: <s> s; slowest cold `install`: <s> s; `STEP_TIMEOUT_MS`: init <n> min, install <n> min. W (slowest bare leg, cold): <m:ss>, so the `compat` job's `timeout-minutes` is ceil(1.5 × W) + 5 + I + N = <n>.

Retries after fetch failures or fetch timeouts: <none, or which command and why>. Decisions taken under Task 5 Step 6's rules: <none, or which and why>.

## Compatibility legs in CI

The `compat` job on the milestone pull request runs the same three legs on `ubuntu-latest` with Node 22. Its result is recorded here, with the run's URL and each leg's duration, when that pull request's checks finish. CI runners start cold, so if the slowest leg's CI duration exceeds 1.5 × W + 5 minutes, recompute `timeout-minutes` as ceil(1.5 × that duration) + I + N, commit it with the measured durations in the message body, and note the change here.
```

- [ ] **Step 9: Lint and commit**

Run: `pnpm exec eslint scripts && pnpm exec vitest run --project unit scripts`
Expected: lint prints nothing; the unit run passes `scripts/pack-packages.test.mjs` and `scripts/compat/lib.test.mjs`.

```sh
git add scripts/compat .github/workflows/ci.yml docs/evals/m5-compat-and-ios.md
git commit -m "Add the compat CI job: React Native 0.86 and 0.87 bare projects and Expo SDK 57"
```

---
### Task 6: Build bare-redux for iOS by hand, record the evidence, and document the example

The one native-build check (spec §1, §8, §11). It runs on this Mac against the iPhone 17 simulator and is evidence, not a gate: a failure is recorded with its cause and the rest of the plan's coverage stands (§12).

**Files:**
- Modify: `docs/evals/m5-compat-and-ios.md` (iOS section)
- Create: `examples/bare-redux/README.md`
- Modify: `AGENTS.md` (repository layout line)
- Regenerate if changed: `examples/bare-redux/integration-exercise/**`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `ironbird status`, `reload`, `send`, `fake`, `state`, `scenario run`, `snapshot save|load`, `screenshot --device`, `verify-bundle`.
- Produces: the iOS evidence section; the example's README.

Evidence rules for every step below:
- Use only the iPhone 17 simulator `9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6`. Never boot, select, build for, or install on the iPhone 18 Pro or any other device, even if it is booted; pass the udid explicitly everywhere a command accepts one.
- Record each command as run, its exit code, and its duration. Keep full logs in `$EVID` (a temporary directory) and copy only short excerpts into the evidence file: the last 30 lines of a failing log, or the JSON a command printed.
- Record what was observed, never what was expected. A step that couldn't run gets "not run" and the reason.
- If a step still fails after its fallbacks, record the failing command, exit code, first error line, and the cause if found, mark the outcome "native build: failed (<cause>)", skip only the steps that depend on it, and carry on with the rest of the task.

- [ ] **Step 1: Prepare and record the environment**

```sh
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
UDID=9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6
EVID="$(mktemp -d -t ironbird-m5-ios)"; echo "$EVID"
{ date -u +%FT%TZ; sysctl -n machdep.cpu.brand_string; sw_vers; xcodebuild -version; pod --version; node --version; ruby --version; git rev-parse --short HEAD; xcrun simctl list devices | grep "$UDID"; } | tee "$EVID/environment.txt"
```

Expected: the last line shows `iPhone 17 (9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6) (Booted)`. If it shows `(Shutdown)`, run `xcrun simctl boot "$UDID" && open -a Simulator --args -CurrentDeviceUDID "$UDID"` and check again. If the udid isn't listed at all, record that and mark the iOS section "not run: the iPhone 17 simulator 9DEB1E0D-… is not installed", then skip to Step 9; do not substitute another simulator.

Run `pnpm install && pnpm build` so the build uses this branch's packages, and stop anything already on Metro's or the daemon's ports: `lsof -nP -iTCP:8081 -iTCP:4567 -iTCP:4568 -sTCP:LISTEN` must print nothing (stop the checkout example's Metro or daemon if they are running).

- [ ] **Step 2: Install the pods**

```sh
cd examples/bare-redux/ios
start=$(date +%s); pod install > "$EVID/pod-install.log" 2>&1; echo "exit $? in $(( $(date +%s) - start )) s"
tail -5 "$EVID/pod-install.log"
```

Expected: `exit 0`, and the log ends with "Pod installation complete!". Fallbacks, in order, each at most once:
1. The error names a gem or a version conflict (`Gem::`, `xcodeproj`, `activesupport`, `concurrent-ruby`): `bundle install > "$EVID/bundle-install.log" 2>&1 && bundle exec pod install > "$EVID/pod-install-bundler.log" 2>&1`.
2. The error names a path under `node_modules` or `.pnpm`, or `use_native_modules!` / `react_native_pods.rb` can't be found: the pnpm layout is the problem. Use the standalone copy in Step 2a and run every later step from it.
3. Anything else: record it as the outcome and skip to Step 8.

- [ ] **Step 2a (fallback only): A standalone copy with flat `node_modules`**

```sh
cd "$(git rev-parse --show-toplevel)"
SA="$(mktemp -d -t ironbird-bare-redux-standalone)"
rsync -a --exclude node_modules --exclude ios/Pods --exclude ios/build --exclude integration-exercise --exclude .ironbird examples/bare-redux/ "$SA/app/"
node scripts/pack-packages.mjs "$SA/packs" core react-native redux cli
node -e '
const fs = require("fs"); const path = require("path");
const [app, packs] = process.argv.slice(1);
const file = path.join(app, "package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
const tarballs = fs.readdirSync(packs);
for (const field of ["dependencies", "devDependencies"]) {
  for (const [name, range] of Object.entries(pkg[field] ?? {})) {
    if (!String(range).startsWith("workspace:")) continue;
    const short = name.replace("@ironbird/", "");
    const tarball = tarballs.find((candidate) => new RegExp(`^ironbird-${short}-\\d`).test(candidate));
    if (tarball) pkg[field][name] = `file:${path.join(packs, tarball)}`;
    else delete pkg[field][name];
  }
}
pkg.devDependencies.typescript = "^6.0.3";
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$SA/app" "$SA/packs"
cp examples/bare-redux/integration-exercise/metro.config.js "$SA/app/metro.config.js"
cd "$SA/app" && npm install --no-audit --no-fund > "$EVID/standalone-npm-install.log" 2>&1; echo "exit $?"
cd ios && pod install > "$EVID/pod-install-standalone.log" 2>&1; echo "exit $?"
```

`@ironbird/testing` has no tarball here, so it is dropped (it serves only the tests). The exercise's `metro.config.js` is the template's, which is right for a flat install. From here on, read `examples/bare-redux` as `$SA/app` and `pnpm exec`/`pnpm start` as `npx`/`npm start`, and record that the evidence came from the standalone copy and why.

- [ ] **Step 3: Build for the simulator**

From `examples/bare-redux/ios` (or `$SA/app/ios`):

```sh
start=$(date +%s)
xcodebuild -workspace BareRedux.xcworkspace -scheme BareRedux -configuration Debug -sdk iphonesimulator \
  -destination "id=$UDID" -derivedDataPath build/DerivedData build > "$EVID/xcodebuild.log" 2>&1
echo "exit $? in $(( $(date +%s) - start )) s"
grep -E "BUILD (SUCCEEDED|FAILED)" "$EVID/xcodebuild.log"; grep -m 5 -E "error:" "$EVID/xcodebuild.log"
```

Expected: `exit 0` and `** BUILD SUCCEEDED **`. Fallback, once: if the errors are compile errors inside React Native or pod sources (paths under `Pods/` or `node_modules/react-native/`), which points at Xcode 27 against source-built React Native, run `rm -rf build/DerivedData && RCT_USE_PREBUILT_RNCORE=1 RCT_USE_RN_DEP=1 pod install > "$EVID/pod-install-prebuilt.log" 2>&1` and the same `xcodebuild` again into `$EVID/xcodebuild-prebuilt.log`. If it still fails, record the outcome and skip to Step 7.

- [ ] **Step 4: Start Metro, install, and launch**

In a background shell from `examples/bare-redux`: `pnpm start > "$EVID/metro.log" 2>&1` (Metro on port 8081). Then:

```sh
xcrun simctl install "$UDID" ios/build/DerivedData/Build/Products/Debug-iphonesimulator/BareRedux.app; echo "install exit $?"
xcrun simctl launch "$UDID" com.example.bareredux; echo "launch exit $?"
```

Expected: both exit 0, Metro's log shows the bundle being served, and the simulator shows the "To-dos" screen. Take a first screenshot for the record: `xcrun simctl io "$UDID" screenshot "$EVID/launched.png"`.

- [ ] **Step 5: Connect the daemon**

In another background shell from `examples/bare-redux`: `pnpm exec ironbird serve > "$EVID/daemon.log" 2>&1`. Then:

```sh
pnpm exec ironbird status --json | tee "$EVID/status.json"
```

Expected: `targets` holds `headless` and `ios`, the `ios` entry with `appId: "com.example.bareredux"` and platform `ios`. If `ios` is missing after 20 seconds, relaunch the app (`xcrun simctl terminate "$UDID" com.example.bareredux && xcrun simctl launch "$UDID" com.example.bareredux`) once; if it is still missing, record Metro's and the daemon's last lines and the outcome "bridge did not connect".

- [ ] **Step 6: Drive the app through the bridge**

Run each command from `examples/bare-redux`, record its exit code and output into `$EVID`, and copy the JSON into the evidence file:

```sh
pnpm exec ironbird reload --target ios --json                                                    # fresh app; prints { target, rev }
pnpm exec ironbird scenario run ironbird/scenarios/add-and-sync.yaml --target ios --json         # expect passed true, skipped [2]
pnpm exec ironbird reload --target ios --json
pnpm exec ironbird scenario run ironbird/scenarios/ack-reorder.yaml --target ios --json          # expect passed true: fake controls on the device
pnpm exec ironbird reload --target ios --json
pnpm exec ironbird send todos.add '{"title":"Recorded on the iPhone 17"}' --target ios --path todos --json
pnpm exec ironbird snapshot save "$EVID/ios-snapshot.json" --target ios --json
pnpm exec ironbird send todos.toggle '{"id":"t1"}' --target ios --path todos.items.0 --json
pnpm exec ironbird snapshot load "$EVID/ios-snapshot.json" --target ios --json
pnpm exec ironbird state todos.items.0 --target ios --json                                       # expect done false, rev 1
pnpm exec ironbird screenshot --target ios --device "$UDID" --out "$EVID/after-restore.png" --json
pnpm exec ironbird fake sync --calls --target ios --json
```

Expected: every command exits 0; both scenarios report `"passed": true` (`add-and-sync` skips its optional clock step, index 2, because a remote settle already waited for the save); after `snapshot load` the first to-do is back to `done: false` at revision 1, which is `withIronbirdRestore` working through the bridge; the screenshot shows one to-do, unchecked. A scenario that fails here is a finding to record with its `failedStep`, not to retry until green.

- [ ] **Step 7: Check a release bundle on this Mac**

From `examples/bare-redux` (or `$SA/app`):

```sh
pnpm bundle:release > "$EVID/bundle-release.log" 2>&1; echo "bundle exit $?"
pnpm exec ironbird verify-bundle build/main.jsbundle --json; echo "verify exit $?"
```

Expected: `bundle exit 0`, then `{"scanned":1,"found":[]}` and `verify exit 0`.

- [ ] **Step 8: Stop everything and put the tree back**

Stop the daemon and Metro (end the background shells), then from the repository root:

```sh
rm -rf examples/bare-redux/build
git checkout -- examples/bare-redux/ios/BareRedux.xcodeproj
git status --short examples/bare-redux
pnpm --filter @ironbird-examples/bare-redux make:exercise && git status --short examples/bare-redux/integration-exercise
```

Expected: both `git status` commands print nothing. `ios/Pods`, `ios/build`, `ios/Podfile.lock`, and `ios/BareRedux.xcworkspace` are ignored; the `pod install` edits to the Xcode project hold machine-specific paths into `node_modules/.pnpm`, so they are discarded and the committed project stays the template's. If `git status` shows any other change under `examples/bare-redux`, find what wrote it and either ignore it in `examples/bare-redux/.gitignore` (then regenerate the exercise, since the `.gitignore` is copied) or discard it.

- [ ] **Step 9: Write the iOS evidence**

Append to `docs/evals/m5-compat-and-ios.md`, filled from `$EVID`:

```md
## bare-redux iOS build (hand run)

<date>. <machine>, macOS <version>, Xcode <version (build)>, CocoaPods <version>, Ruby <version>, Node <version>, commit <sha>. Simulator: iPhone 17, `9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6`, iOS <runtime>. Built from: <the workspace (pnpm) | a standalone copy with npm, because <cause>>.

**Outcome: native build <passed | failed (<cause>)>.**

| Step | Command | Exit | Time | Notes |
|---|---|---|---|---|
| Pods | `pod install` | | | <fallback used, if any> |
| Build | `xcodebuild ... -destination id=9DEB1E0D-... build` | | | `** BUILD SUCCEEDED **` or the first error |
| Install and launch | `xcrun simctl install` / `launch` | | | |
| Bridge | `ironbird status` | | | the `ios` target entry |
| Scenario | `scenario run add-and-sync.yaml --target ios` | | | passed, skipped |
| Scenario | `scenario run ack-reorder.yaml --target ios` | | | passed |
| Restore | `snapshot save` → `send todos.toggle` → `snapshot load` → `state todos.items.0` | | | the state after load |
| Release bundle | `bundle:release` + `verify-bundle build/main.jsbundle` | | | found |

<The JSON each bridge command printed, in a fenced block, trimmed to the fields above.>

<Fallbacks taken and why, or "none".>
```

- [ ] **Step 10: Document the example**

Create `examples/bare-redux/README.md`:

````md
# bare-redux example

A bare React Native 0.87 app made from the community template: a to-do list on Redux Toolkit whose every change is saved to a sync API. The sync API acknowledges saves after 300 ms or 100 ms, alternating, so a quick second edit is acknowledged first, and the app carries a planted bug in how it applies acknowledgements. ironbird drives it through `@ironbird/redux`: headlessly in Node through `src/ironbird/headless.ts`, and on a simulator through the bridge that `index.js` starts in dev builds.

It is the M5 example (docs/roadmap.md) and the source of `integration-exercise/`, the same app without ironbird, for the "wire ironbird in using only the docs" trial.

## Layout

| Path | What it holds |
|---|---|
| `src/store/`, `src/sync/`, `App.tsx` | The app: state and reducers, the sync middleware, the simulated sync server, the screen |
| `src/app/instance.ts` | The device store; the ironbird wiring sits between `exercise:` markers |
| `src/ironbird/commands.ts` | `todos.add { title }`, `todos.toggle { id }`, `todos.rename { id, title }` |
| `src/ironbird/target.ts` | `fromStore` with `toAction` mapping each command to the app's action creator, and `restore` |
| `src/ironbird/schema.ts` | The root-state schema that `snapshot load` validates against |
| `src/ironbird/fakes/sync.ts` | The `sync` fake: the alternating timer, plus `setAcks` and `release` controls |
| `src/ironbird/headless.ts`, `src/ironbird/device.ts` | The headless entry and the bridge |
| `ironbird/scenarios/` | `add-and-sync` (both targets), `ack-reorder` (both targets, fake controls), `auto-reorder` (headless) |
| `exercise/`, `scripts/` | The exercise material and the generator |

## Headless

Run `pnpm build` from the repository root first: this example resolves the ironbird packages through `packages/*/dist`.

```sh
cd examples/bare-redux
pnpm exec ironbird serve                                   # in its own terminal
pnpm exec ironbird commands
pnpm exec ironbird send todos.add '{"title":"Buy milk"}' --path todos
pnpm exec ironbird clock advance 300ms --path sync
pnpm exec ironbird scenario run ironbird/scenarios
```

## The planted bug

With the bug planted, an acknowledgement sets a to-do's `syncedRev` to its own revision even when a newer one was already acknowledged, so after a quick second edit the to-do shows "Saving…" for good with nothing in flight. Headlessly, the daemon reads `PLANT_BUG`:

```sh
PLANT_BUG=1 pnpm exec ironbird serve
pnpm exec ironbird scenario run ironbird/scenarios    # ack-reorder and auto-reorder fail at their last step with syncedRev 1
```

The device build never plants it.

## Snapshots

`ironbird snapshot save <file>` stores the store's root state. `ironbird snapshot load <file>` validates it against `src/ironbird/schema.ts` first, then replaces the state through the root reducer wrapped with `withIronbirdRestore`; a snapshot that fails the schema changes nothing.

## iOS

The device build has no backend: the `sync` fake stands in for it on the real clock, so `ironbird fake sync ...` works against the running app.

```sh
export LANG=en_US.UTF-8                       # CocoaPods needs a UTF-8 locale
cd examples/bare-redux/ios && pod install && cd ..
pnpm start                                    # Metro, in its own terminal
pnpm ios --udid <simulator udid>              # build, install, and launch
pnpm exec ironbird serve                      # then `pnpm exec ironbird status` lists the ios target
```

On a remote target `scenario run` doesn't reset, so run `pnpm exec ironbird reload --target ios` before each scenario. `pod install` writes `ios/Podfile.lock` and `ios/BareRedux.xcworkspace`, which are git-ignored, and edits the Xcode project with paths into this monorepo's `node_modules/.pnpm`; don't commit those edits (`git checkout -- ios/BareRedux.xcodeproj`). The hand-run build of record is in docs/evals/m5-compat-and-ios.md.

`metro.config.js` watches the workspace's `node_modules` and `packages`, and resolves `react` and `react-native` from this app only: `@ironbird/react-native`'s development install links React Native 0.86.3 for the checkout example, and two copies in one bundle break the app. `test/bundle.test.ts` checks that the dev bundle holds only 0.87.1.

## Release bundles

```sh
pnpm bundle:release
pnpm exec ironbird verify-bundle build/main.jsbundle   # exit 0: no bridge
```

`test/bundle.test.ts` runs the same check in `pnpm test`, together with a dev bundle that must contain the bridge.

## Integration exercise

`integration-exercise/` is generated from this app by `pnpm make:exercise`. It leaves out `src/ironbird/`, `ironbird/`, `ironbird.config.ts`, `test/`, `scripts/`, every test file, and the ironbird dependencies; removes every line between `// exercise:begin-remove` and `// exercise:end`; writes each `// exercise:else` branch uncommented instead; and copies in `exercise/`'s README, TASK.md, CHECKLIST.md, RESULTS.md, and acceptance.yaml, whose single source is `exercise/`. Never edit `integration-exercise/` by hand, the material copies included: after any change to the app or to `exercise/`, run `pnpm make:exercise` and commit the result, or `scripts/lib/exercise.test.mjs` fails.

To run the trial, copy `integration-exercise/` outside the repository, make the tarballs from the repository root with `node scripts/pack-packages.mjs <dir> core react-native redux cli`, and give the participant the copy, the tarballs, and the documentation. They follow TASK.md and record their time in RESULTS.md.

## Monorepo note

Build scripts allowed for this app in `pnpm-workspace.yaml`: none.
````

If Task 1 Step 5 added `allowBuilds` entries for this app, list them in the last line instead of "none".

In `AGENTS.md`, replace the line `  bare-redux/     Bare React Native app using Redux (M5)` with:

```text
  bare-redux/     Bare React Native 0.87 app on Redux Toolkit: to-dos, a sync fake that reorders acknowledgements, planted bug behind a flag; generates integration-exercise/
```

- [ ] **Step 11: Verify everything, on both Node versions**

Run: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`
Expected: the build verifies every package; lint and typecheck print nothing; every unit and serial test passes, including `examples/bare-redux`'s. Then run `pnpm test` again under Node 26 (switch with your version manager, for example `fnm use 26` or `nvm use 26`), as CI's matrix does, and confirm the same result. If `test/bundle.test.ts` takes longer than half its timeout on either version, double the timeout.

- [ ] **Step 12: Commit**

```sh
git add docs/evals/m5-compat-and-ios.md examples/bare-redux/README.md AGENTS.md examples/bare-redux/integration-exercise
git commit -m "Record the bare-redux iOS build and compat runs, and document the example"
```

- [ ] **Step 13: Carry the notes into the milestone PR**

The milestone PR description (one open PR for M5) must include, verbatim:

```markdown
**bare-redux and compatibility (M5 plan 4).** `examples/bare-redux` is a bare React Native 0.87.1 app from the community template, on Redux Toolkit, wired with `@ironbird/redux` (restore included), a headless entry, the bridge, and three scenarios; its planted bug (`PLANT_BUG=1`) lets an older sync acknowledgement overwrite a newer one. `integration-exercise/` is generated from it by `pnpm --filter @ironbird-examples/bare-redux make:exercise` and checked byte for byte by a unit test. The new `compat` job generates a fresh bare project for React Native 0.86.3 (CLI 20.1.0) and 0.87.1 (CLI 20.2.0), installs the packed `@ironbird/core` and `@ironbird/react-native`, typechecks a minimal wiring, and requires clean release bundles and marker-bearing dev bundles; its Expo SDK 57 leg exports the checkout example clean and, with `EXPO_PUBLIC_FORCE_BRIDGE=1`, with the marker. `check` now requires `compat`. This is JavaScript-bundle evidence; the native build is the one hand-run iOS build recorded in docs/evals/m5-compat-and-ios.md.

Dependencies: new ones land only in the private example (`@reduxjs/toolkit`, `react-redux`, `react-native` 0.87.1 and its template's tooling), so no ADR or CLI justification applies. No published package changes, so there is no changeset from this part.

Exit criteria: this moves "CI passes on the two most recent React Native minor versions and the current Expo SDK" (measured by the `compat` job's three legs, run locally in docs/evals/m5-compat-and-ios.md and on this PR), and prepares the material for "a developer other than the author wires ironbird into a copy of `examples/bare-redux`" (the exercise and its checklist), which stays unticked pending the human trial.
```

---

## Spec discrepancies and decisions

The spec, the contract, and the repository agree except where noted. Each point is decided here rather than silently.

| # | Spec or contract says | This plan does | Why |
|---|---|---|---|
| 1 | D7: "made from the community template" | Generates it with CLI 20.2.0 from template 0.87.2 (React Native 0.87.1), keeps `ios/`, `android/`, Gemfile, Babel config, and the entry, but drops the template's Jest, ESLint 8, Prettier, and `NewAppScreen`, and rewrites `tsconfig.json` and `metro.config.js` | The monorepo lints with ESLint 10 and tests with Vitest (AGENTS.md); an ESLint 8 dev install would conflict, and the screen is the to-do UI |
| 2 | D7: "a fake sync API reorders acknowledgements" | The fake reorders by default (alternating 300 ms and 100 ms acknowledgements, shared with the app's own simulated server) and also offers `setAcks { mode: manual }` and `release { order: oldest \| newest }` for deterministic reordering on either target | Default reordering makes the bug reachable in normal use; manual control makes it scriptable on a device, where there is no manual clock |
| 3 | D7: the planted bug, unspecified | `plantBug` makes an acknowledgement overwrite `syncedRev` instead of keeping the maximum; headless `PLANT_BUG=1` plants it; the device build never does | Mirrors the checkout's env flag; a bare app has no `EXPO_PUBLIC_*` inlining, and the device run needs only the wiring |
| 4 | D7: "every ironbird file and line removed" | Also removes the monorepo-only Metro block, every test file (they run on the monorepo's Vitest, which the standalone copy doesn't have), `tsconfig.test.json`, and the README (replaced by `exercise/README.md`); `exercise:else` branches supply the ironbird-free replacements (the template Metro config, and a real-clock adapter in `src/sync/real-timers.ts` that the device store injects into the simulated server, the exercise's only platform-timer call) | A standalone copy must build and typecheck on its own; the else branches keep "generated, cannot drift" while giving the copy working code |
| 5 | D7 is silent on whether the copy is committed | It is committed; a unit test regenerates it and compares bytes and executable bits; `typecheck` also typechecks it as a standalone app | "Cannot drift" needs a check in CI, and the human trial and plan 5's proxy need a fixed copy |
| 6 | Not in the spec | `createAppStore` keeps a generic `wrapReducer` option in the exercise copy | It is how the wired app adds `withIronbirdRestore` without an ironbird line in the store; it reads as an ordinary reducer-enhancer seam, and the exercise doesn't require restore |
| 7 | §8 step 1 pins the CLI per leg | Also pins the exact React Native patch (0.86.3, 0.87.1) and asserts the exact version, which implies the minor | A moving "latest 0.86" would make the leg's subject change under it; the pins are bumped deliberately |
| 8 | §8 steps 6–7 don't name a platform | Bundles iOS and Android, release and dev (four bundles per leg) | The production-bundle claim matters for both platforms; it is cheap. A Linux-only fallback to Android is a recorded decision rule |
| 9 | §8 Expo leg: release export must be clean | Adds a second export with `EXPO_PUBLIC_FORCE_BRIDGE=1` that must contain the marker | The same non-vacuity argument §8 step 7 makes for the bare legs |
| 10 | §11: "Unit and headless scenario tests in the unit and serial projects" | Adds a serial Metro test that bundles bare-redux in release and dev mode and checks `verify-bundle` and a single `react-native` copy | D11's grader checks `verify-bundle` on this app; the monorepo's duplicate React Native (fact table) is a real hazard only a bundle shows |
| 11 | Contract: plan 5 produces the M5 evals record | This plan writes its raw evidence to `docs/evals/m5-compat-and-ios.md`, for the M5 record to cite; the CI result of the `compat` job is added when the milestone PR runs | Keeps the contract's file ownership; the iOS run and local legs happen in this plan |
| 12 | §1: iOS build "verified once, by hand" | `ios/Podfile.lock` and the `.xcworkspace` are git-ignored, and `pod install`'s Xcode project edits are discarded after the run | Under pnpm they hold machine-specific `.pnpm` paths that would also leak into the exercise copy |
| 13 | Not in the spec | `scripts/pack-packages.mjs` at the root packs named packages; the compat legs, the exercise's task sheet, and plan 5's proxy use it | One way to make the tarballs §8 step 3 and the trial need |
| 14 | The trial uses "only the docs" | This plan writes no bare React Native guide; TASK.md points at the README and `docs/` | Plan 5 owns the 0.1 README; it should make sure the docs cover wiring a bare React Native + Redux app (index.js under `__DEV__`, `fromStore`, a headless entry), since the trial measures exactly that |
| 15 | Not in the spec | `exercise/` holds the single source of the exercise material (`README.md`, `TASK.md`, `CHECKLIST.md`, `RESULTS.md`, `acceptance.yaml`); the generator copies it and the drift test covers the copies; plan 5 edits the sources and reruns `make:exercise` | One owner per file: a generated copy that another plan also edited would either lose those edits on regeneration or fail the drift test (codex plan review, finding 1) |
| 16 | §12: "A fetch failure is retried once" | The fetch steps run under `STEP_TIMEOUT_MS` limits, a step killed at its limit counts as a `fetch-timeout` and gets the one retry, and the job's `timeout-minutes` comes from a measured cold run | Without step limits a stalled fetch would use the whole job before the retry could run (codex plan review, finding 6) |

## Self-Review

**Spec coverage.** D7 (bare React Native 0.87 from the community template, Redux Toolkit, to-do domain, planted bug with a fake sync API that reorders acknowledgements, `@ironbird/redux` with `restore`, headless entry, bridge, scenarios; the exercise generated by a script; stays on 0.87): Tasks 1 (template, domain, planted bug), 2 (adapter with `restore: { schema }` and `withIronbirdRestore`, fake, headless entry, scenarios), 3 (bridge), 4 (generator, drift test, material). D8 and §8 (three legs; fresh project per minor with the pinned CLI; version assertion; tarballs from `pnpm pack`; wiring imported from `index.js`; typecheck; clean release bundle; marker in the dev bundle; Expo SDK 57 through the checkout with version assertions, `expo export`, clean `verify-bundle`; `check` requires `compat`; retry a fetch failure once; projects outside the workspace): Task 5. §8 "Evidence" (JavaScript-bundle evidence reported as such, native evidence separate): Task 5 Step 8 and Task 6 Step 9. §1 criterion 1 material (copy without ironbird, task sheet, scoring checklist, place for elapsed time): Task 4. §1 out-of-scope items (no device runs or native builds in CI, no Android build): Global Constraints and Task 6. §11 bare-redux rows (unit and headless scenario tests in unit and serial; the compat job; one device run on the iPhone 17 with evidence): Tasks 1–3 (unit and serial tests), 5, 6. §12 risks (iOS build failure recorded with cause; pinned CLI, generated projects outside the workspace, one retry): Task 6's evidence rules and fallbacks, Task 5. Plan 5 owns Q8, changesets for 0.1.0, the README, the proxy eval, the M5 record, and roadmap ticks.

**Placeholder scan.** Every code step carries the complete file or an exact insertion with its anchor; every run step carries the command and its expected result. The evidence templates in Task 5 Step 8 and Task 6 Step 9 hold angle-bracket slots on purpose: they are filled from observed output under the stated evidence rules, and the rules forbid writing a value that wasn't observed. No step says "similar to" or "handle errors".

**Type consistency.** `SavedTodo`, `SyncAck`, `SyncPort`, `Timers`, `createSimulatedServer`, `SLOW_ACK_MS`, `FAST_ACK_MS` (Task 1) are what `fakeSync` (Task 2) imports. `AppState`, `initialState`, `added`, `toggled`, `renamed`, `createAppStore`, `AppStore`, `AppStoreOptions.wrapReducer` (Task 1) are what `target.ts`, `headless.ts`, `schema.test.ts` (Task 2) and `instance.ts` (Task 3) use. `toTarget`, `fakeSync`, and `commands` (Task 2) are what `device.ts` and `instance.ts` (Task 3) import; `instance.ts` exports `clock`, `tracker`, `recorder`, `fakes`, `store`, exactly what `device.ts` imports. Command names (`todos.add`, `todos.toggle`, `todos.rename`), fake controls (`setAcks`, `release`), state paths (`todos.items.0.syncedRev`, `sync.inFlight`), and the app id `com.example.bareredux` are the same in the code, the scenarios, the CLI tests, the acceptance scenario, TASK.md, and CHECKLIST.md. `packPackages(names, outDir)` (Task 4) is what `bare-leg.mjs` (Task 5) and Task 6 Step 2a call. `checkVerify` takes `{ status, stdout }`, which is what `verifyBundle` returns.

**Review Focus.** Each of the five has a test in its owning task: unknown-id and below-zero acknowledgements (Task 1, "never counts below zero and ignores acknowledgements for unknown ids"; Task 2, "survives an acknowledgement for a to-do the restored state does not have"); a second `react-native` in the bundle (Task 3, "ships the bridge in the dev bundle with exactly one react-native"); malformed markers and leaks (Task 4, the seven `transformSource` failure cases and `findLeaks`, plus the leak check inside `generateExercise`); near-miss snapshots (Task 2, "refuses a snapshot with an extra key or a wrong type", the schema test, and the CLI test's refused load); fetch failures versus real failures (Task 5, `isFetchFailure` both ways, `classifyFailure`, and `retryOnFetchFailure`'s six cases, fetch timeouts included).
