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
