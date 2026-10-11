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

On a remote target `scenario run` doesn't reset, so run `pnpm exec ironbird reload --target ios` before each scenario. `pod install` writes `ios/Podfile.lock` and `ios/BareRedux.xcworkspace`, which are git-ignored. It also edits three committed files: the Xcode project, with paths into this monorepo's `node_modules/.pnpm`, plus `ios/BareRedux/Info.plist` and `ios/BareRedux/PrivacyInfo.xcprivacy`. Don't commit those edits (`git checkout -- ios/BareRedux.xcodeproj ios/BareRedux/Info.plist ios/BareRedux/PrivacyInfo.xcprivacy`). The hand-run build of record is in docs/evals/m5-compat-and-ios.md.

Unlike the 0.87 template, `ios/BareRedux/AppDelegate.swift` creates the window in a `SceneDelegate`, which `Info.plist`'s `UIApplicationSceneManifest` names. Apps built with the iOS 27 SDK must adopt the UIScene life cycle, and the template's window-in-`AppDelegate` version exits at launch.

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
