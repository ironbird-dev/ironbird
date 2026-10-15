# M5: compatibility legs and the bare-redux iOS build

Raw evidence for two M5 measurements (M5 design §1, §8, and §11), cited by the M5 evals record. The compatibility legs are **JavaScript-bundle evidence**: the packed packages install, typecheck, bundle, and stay out of production bundles on each version. They are not native-build evidence; that is the one hand-run iOS build of `examples/bare-redux`, recorded in its own section.

## Compatibility legs, run locally

2026-10-09, Apple M3 Pro, macOS 27.2, Node v26.11.0, from commit 6ee511a with this change's `scripts/compat/` files on top (not yet committed when the legs ran).

| Leg | Command | Resolved | Typecheck | Bundles: verify-bundle exit (expected) | Wall time |
|---|---|---|---|---|---|
| React Native 0.86 | `node scripts/compat/bare-leg.mjs --react-native 0.86.3 --cli 20.1.0` | react-native 0.86.3 | passed | ios release 0 (0), ios dev 1 (1), android release 0 (0), android dev 1 (1) | 0:57 |
| React Native 0.87 | `node scripts/compat/bare-leg.mjs --react-native 0.87.1 --cli 20.2.0` | react-native 0.87.1 | passed | ios release 0 (0), ios dev 1 (1), android release 0 (0), android dev 1 (1) | 1:03 |
| Expo SDK 57 | `node scripts/compat/expo-leg.mjs` | expo 57.0.23, react-native 0.86.3 | n/a | release 0 (0), forced-bridge 1 (1) | 0:29 |

Bare legs ran with an empty npm cache (cold). Slowest cold `init`: 33 s; slowest cold `install`: 1 s; `STEP_TIMEOUT_MS`: init 10 min, install 5 min. W (slowest bare leg, cold): 1:03, so the `compat` job's `timeout-minutes` is ceil(1.5 × W) + 5 + I + N = 22.

Retries after fetch failures or fetch timeouts: none. Decisions taken under Task 5 Step 6's rules: none; neither measured fetch step came near a third of its limit, so `STEP_TIMEOUT_MS` keeps its defaults.

The bare legs apply one setting beyond the minimal wiring: `metro.config.js` resolves zod to its CommonJS build (`patchMetroConfig` in `scripts/compat/lib.mjs`), the same setting [docs/api.md](../api.md) tells bare apps to add. Without it, a fresh 0.86.3 template's dev bundle fails on its first zod import with `Export namespace should be first transformed by @babel/plugin-transform-export-namespace-from`, naming `zod/v4/classic/external.js`; this was reproduced on the 0.86 leg's project by restoring the template's `metro.config.js`. The 0.86.3, 0.87.1, and 0.87.2 templates ship the same `metro.config.js`, and `patchMetroConfig` refuses any other shape, so a template change fails the leg instead of bundling unpatched. The Expo leg needs no such setting.

## Compatibility legs in CI

The `compat` job on the milestone pull request runs the same three legs on `ubuntu-latest` with Node 22. Its result is recorded here, with the run's URL and each leg's duration, when that pull request's checks finish. CI runners start cold, so if the slowest leg's CI duration exceeds 1.5 × W + 5 minutes, recompute `timeout-minutes` as ceil(1.5 × that duration) + I + N, commit it with the measured durations in the message body, and note the change here.

2026-10-15, pull request #13 at 761a502, https://github.com/ironbird-dev/ironbird/actions/runs/38742986829: all three legs passed.

| Leg | Resolved | Job duration |
|---|---|---|
| React Native 0.86 | react-native 0.86.3 (CLI 20.1.0), typecheck passed | 2:14 |
| React Native 0.87 | react-native 0.87.1 (CLI 20.2.0), typecheck passed | 1:52 |
| Expo SDK 57 | expo 57.0.23, react-native 0.86.3 | 1:18 |

Every `verify-bundle` exit matched its expected value, as in the local runs. The slowest leg, 2:14, is under 1.5 × W + 5 minutes (6:35), so `timeout-minutes` stays 22.

## bare-redux iOS build (hand run)

2026-10-10. Apple M3 Pro, macOS 27.2 (26B5101f), Xcode 27.0 (27A266a), CocoaPods 1.17.0, Ruby 4.0.7, Node v26.11.1, commit c5bff21. Simulator: iPhone 17, `9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6`, iOS 27.0 (24A434), booted for this run and shut down after it; no other simulator was booted or used. Built from: the workspace (pnpm).

**Outcome: native build passed. The first launch failed (the iOS 27 SDK requires the UIScene life cycle, which the 0.87.2 template's `AppDelegate` doesn't adopt); with the scene life cycle adopted, the app launched and every bridge step passed.**

| Step | Command | Exit | Time | Notes |
|---|---|---|---|---|
| Pods | `pod install` | 0 | 97 s | "Pod installation complete! There are 87 dependencies from the Podfile and 86 total pods installed." React Native core and its dependencies came prebuilt (`[ReactNativeCore] Prebuilt xcconfig configuration complete`). No fallback |
| Build | `xcodebuild -workspace BareRedux.xcworkspace -scheme BareRedux -configuration Debug -sdk iphonesimulator -destination id=9DEB1E0D-... -derivedDataPath build/DerivedData build` | 0 | 29 s | `** BUILD SUCCEEDED **`, no `error:` lines |
| Install and launch, template `AppDelegate` | `xcrun simctl install` / `launch` | 0 / 0 | 7 s / 2 s | The app exited at launch (SIGTRAP, crash report `BareRedux-2026-10-10-193119.ips`); UIKit logged "Application failed to launch: UIScene life cycle is required for apps built with this SDK." Metro served no bundle |
| Rebuild, scene life cycle adopted | the same `xcodebuild` | 0 | 12 s | `** BUILD SUCCEEDED **` |
| Install and launch | `xcrun simctl install` / `launch` | 0 / 0 | 1 s / 1 s | Metro served `index.js`; the simulator showed the "To-dos" screen, "All changes sent", no to-dos |
| Bridge | `ironbird status --json` | not captured | under 1 s | `targets` held `headless` and `ios`, the `ios` entry `{"platform":"ios","appId":"com.example.bareredux"}`; the daemon log printed `target ios connected (com.example.bareredux)` |
| Scenario | `scenario run ironbird/scenarios/add-and-sync.yaml --target ios` | 0 | 994 ms | `passed: true`, `stepsRun: 4`, `skipped: [2]` |
| Scenario | `scenario run ironbird/scenarios/ack-reorder.yaml --target ios` | 0 | 757 ms | `passed: true`, `stepsRun: 9`, `skipped: []` |
| Restore | `snapshot save` → `send todos.toggle` → `snapshot load` → `state todos.items.0` | 0, 0, 0, 0 | 318, 661, 276, 254 ms | after load: `done: false`, `rev: 1`, `syncedRev: 1`; the screenshot (`screenshot --device 9DEB1E0D-...`, exit 0, 933 ms) shows one unchecked to-do marked "Saved" |
| Release bundle | `bundle:release` + `verify-bundle build/main.jsbundle` | 0 + 0 | 2 s + under 1 s | `{"scanned":1,"found":[]}` |

Each `reload --target ios` before a scenario and before the restore steps exited 0 in under 1 s and printed `{"target":"ios","rev":0}`. The `status` exit code was lost: the shell that ran it reads exit codes from `pipestatus`, not `PIPESTATUS`, so the recorded line was empty. Its JSON is below.

```jsonc
// ironbird status --json
{"version":"0.0.3","protocol":1,"targets":[
  {"id":"headless","platform":"headless","appId":"com.example.bareredux","rev":0},
  {"id":"ios","platform":"ios","appId":"com.example.bareredux","rev":0}]}

// scenario run ironbird/scenarios/add-and-sync.yaml --target ios --json
{"scenario":"Add a to-do and let it sync","target":"ios","passed":true,"durationMs":582,"stepsRun":4,"skipped":[2]}

// scenario run ironbird/scenarios/ack-reorder.yaml --target ios --json
{"scenario":"Acknowledgements arrive out of order","target":"ios","passed":true,"durationMs":386,"stepsRun":9,"skipped":[]}

// send todos.add '{"title":"Recorded on the iPhone 17"}' --target ios --path todos --json
{"target":"ios","rev":3,"path":"todos","state":{"items":[{"id":"t1","title":"Recorded on the iPhone 17","done":false,"rev":1,"syncedRev":1}],"nextId":2},
 "settle":{"idle":true,"quiescent":false,"waitedMs":448,"pending":[]}}

// snapshot save <file> --target ios --json
{"target":"ios","app":"com.example.bareredux","rev":3}

// send todos.toggle '{"id":"t1"}' --target ios --path todos.items.0 --json
{"target":"ios","rev":6,"path":"todos.items.0","state":{"id":"t1","title":"Recorded on the iPhone 17","done":true,"rev":2,"syncedRev":2},
 "settle":{"idle":true,"quiescent":false,"waitedMs":360,"pending":[]}}

// snapshot load <file> --target ios --json
{"target":"ios","rev":7,"path":"","value":{"todos":{"items":[{"id":"t1","title":"Recorded on the iPhone 17","done":false,"rev":1,"syncedRev":1}],"nextId":2},"sync":{"inFlight":0,"lastError":null}}}

// state todos.items.0 --target ios --json
{"target":"ios","rev":7,"path":"todos.items.0","value":{"id":"t1","title":"Recorded on the iPhone 17","done":false,"rev":1,"syncedRev":1}}

// fake sync --calls --target ios --json
{"target":"ios","fake":"sync","calls":[
  {"seq":1,"fake":"sync","method":"save","args":[{"id":"t1","title":"Recorded on the iPhone 17","done":false,"rev":1}],"outcome":"resolved"},
  {"seq":2,"fake":"sync","method":"save","args":[{"id":"t1","title":"Recorded on the iPhone 17","done":true,"rev":2}],"outcome":"resolved"}],
 "nextSeq":2,"truncated":false}
```

Fallbacks taken: none of the brief's (no Bundler, no standalone copy, no prebuilt-core reinstall). One deviation, because none of them covers a launch failure: `ios/BareRedux/AppDelegate.swift` now creates the window in a `SceneDelegate` from its `UIWindowScene`, and `ios/BareRedux/Info.plist` names that delegate in a `UIApplicationSceneManifest` with one scene. The Xcode project is unchanged. The change is committed with this record, so the example and `integration-exercise/` launch when built with the iOS 27 SDK. React Native 0.87.1 ships no scene delegate of its own; `RCTReactNativeFactory.startReactNative(withModuleName:in:launchOptions:)` takes any window and makes it key and visible.

Other observations: Metro logged one warning on every bundle, dev and release. It names a deep import of `react-native/src/private/featureflags/ReactNativeFeatureFlags` that isn't in the package's `exports` and falls back to file resolution; no ironbird package or example source imports it, while files inside `react-native/Libraries` (for example `Lists/FlatList.js`) do, so the warning comes from React Native 0.87.1 itself. `pod install` also edited three committed files with machine-specific or order-only changes: the Xcode project, `Info.plist` (it adds `RCTNewArchEnabled`), and `PrivacyInfo.xcprivacy` (it reorders two entries). All three edits were discarded after the run, and `git status --short examples/bare-redux` was clean apart from the scene change.
