# M2 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| A scenario reproduces the planted race: it fails with `PLANT_RACE=1` and passes without it | met | `packages/cli/test/scenarios.integration.test.ts`, "fails at the last expect with PLANT_RACE=1 and passes without it", green in `pnpm test` on Node 22.14.0 and 26.10.0 (2026-09-26). On both targets: on iOS with the race planted in the bundle, `scenario run ... --target ios` exited 4 with `failedStep.index` 9 and `actual` 0 (transcript below) |
| The same scenario, with clock steps marked optional, reaches the same final state on the headless and iOS targets | met | `examples/checkout/test/scenarios.device.test.ts`, "reaches the same final state on a freshly reloaded iOS app and a freshly reset headless target", is a device test: it runs only with `pnpm test:device` against a booted simulator, not in CI, and passed there (2026-09-26): iOS skipped step 4, headless skipped none, and the two root states are equal, `ui` included (below) |
| 100 consecutive headless runs of every example scenario show 0 divergences | met | "runs every example scenario 100 times with no divergence": 5 scenarios × 100 runs, `reset` before each, pass/fail result, final state, and event log equal to run 1 in every run; 1.36 s on Node 26.10.0 and 1.80 s on Node 22.14.0 (below) |

## The scenarios

`examples/checkout/ironbird/scenarios/`: `checkout-saved-card`, `race-success-before-confirmation` (the gate scenario), and `duplicate-success` run on both targets and start by reducing motion; `missing-echo-times-out` and `reader-disconnect` declare `target: headless`. Together they cover the testing strategy's missing, duplicated, and reordered server events. The fakes are `defineFake` fakes with the controls the scenarios use (`reader.emit`, `api.emit`, `api.setEcho`), wired into the headless entry and the device build, with the M0 timings unchanged.

## Determinism timing (first day of plan 3, 2026-09-26)

Machine: Apple M3 Pro, macOS 27.2 (build 26B5091g). The serial test as it runs in CI, from `time pnpm exec vitest run --project serial --reporter=verbose packages/cli/test/scenarios.integration.test.ts`:

```
Node 26.10.0   determinism test 1355 ms   wall ~2.32 s
Node 22.14.0   determinism test 1803 ms   wall ~2.59 s
```

Per run (500 runs of one scenario each): 2.71 ms on Node 26, 3.61 ms on Node 22. A 300-run soak (`IRONBIRD_SOAK_RUNS=300`, 1,500 runs) took 3673 ms, 2.45 ms per run, so per-run time is flat (slightly lower than the 100-run figure, a ratio of 0.90, well inside the "flat, within about 20%" band — consistent with JIT warm-up, not accumulation).

Decision against the spec's 60-second budget: within budget on both Node versions and no accumulation; the run count stays at 100.

## Planted iOS run (2026-09-26)

Metro restarted with `EXPO_PUBLIC_PLANT_RACE=1 npx expo start --clear` (run without `--ios`, since two simulators were booted; the app was opened on the iPhone 17 by udid — see the two-simulator note below); iOS 27.0 on iPhone 17 (simulator), Expo SDK 57 in Expo Go.

```
$ ironbird scenario run ironbird/scenarios/race-success-before-confirmation.yaml --target ios --json
{"scenario":"Payment success arrives before order confirmation","file":"/Users/sunkibaek/apps/ironbird/examples/checkout/ironbird/scenarios/race-success-before-confirmation.yaml","target":"ios","passed":false,"durationMs":1089,"stepsRun":9,"failedStep":{"index":9,"step":{"expect":"order.totalCents","equals":4500},"expected":{"equals":4500},"actual":0},"skipped":[4],"artifacts":"/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/runs/2026-09-27T05-13-19-250Z-payment-success-arrives-before-order-confirmation"}
exit 4
$ ironbird state order --target ios
{"target":"ios","rev":5,"path":"order","value":{"status":"completed","totalCents":0,"paymentSucceeded":true}}
```

Artifacts: `examples/checkout/.ironbird/runs/2026-09-27T05-13-19-250Z-payment-success-arrives-before-order-confirmation`.

Unplanted confirmation, same app, Metro restarted without the flag (`npx expo start --clear`, reopened the same way): `scenario run ... --target ios --json` reported `"passed":true`, `"stepsRun":9`, `"skipped":[4]`, exit 0.

## Cross-target run (2026-09-26)

From `pnpm test:device`: 2 files, 4 tests passed (3 in `remote.device.test.ts`, 1 in `scenarios.device.test.ts`). Final root state on both targets after the race scenario, unplanted:

```json
{
  "cart": { "items": [{ "sku": "cut-45", "name": "Haircut", "qty": 1, "unitCents": 4500 }], "subtotalCents": 4500 },
  "payment": { "status": "succeeded", "method": "saved", "token": "saved-card", "paymentId": "pay_1" },
  "order": { "status": "completed", "orderId": "ord_1", "totalCents": 4500, "paymentSucceeded": true },
  "reader": { "connected": true },
  "ui": { "motion": "reduced" }
}
```

iOS ran 9 steps and skipped step 4 (the `clock` step); headless ran all 10.

## Follow-ups

- **D14 (scenario files share app state within one `scenario run`).** Found while running the example scenarios: without a reset between files, `scenario run` on a directory depends on file order and on anything done by hand before it. `scenario run` now resets a headless target before each file through an opt-in `reset` option on `runScenario`; remote apps run against their current state instead, since a remote target has no state-level reset (see the two-simulator/reload note below).
- **Two-simulator note.** With more than one booted iOS simulator, neither the reload helper (`simctl terminate`/`openurl`) nor the daemon's own capture-device resolution (`screenshot`/`step`) can pick one on their own; `IRONBIRD_SIM_UDID` pins both. `examples/checkout/ironbird.config.ts` reads it into `devices.ios` for the daemon's device resolution (a no-op when unset), and `examples/checkout/test/device-helpers.ts`'s `reloadApp` reads it for the `simctl` fallback. The planted iOS run above used the same pinning: Metro was started without `--ios` (which lets Expo choose a simulator) and the app was opened explicitly with `xcrun simctl openurl 9DEB1E0D-3DEF-4B99-ACFC-593ABDCAF6E6 exp://127.0.0.1:8081`.
- **Metro cache behavior with `EXPO_PUBLIC_PLANT_RACE`.** Expo inlines `EXPO_PUBLIC_*` variables at bundle time, so the flag only takes effect with Metro's cache cleared (`--clear`) and the app reloaded after Metro restarts; a run against a cached bundle silently keeps the previous flag value (the same effect the M1 evals record saw with `EXPO_PUBLIC_FORCE_BRIDGE`). Both the planted and the unplanted runs here used `--clear` and a fresh `simctl openurl` load, and both produced the expected result on the first try.
- **Remote targets have no `reset`.** `race-success-before-confirmation.yaml` leaves the iOS app's cart, order, and the `api` fake's echo mode changed; since `remote-target.ts` strips `reset` from a remote target's capabilities, `examples/checkout/test/scenarios.device.test.ts` restores the echo mode and reloads the app in `afterAll` (tolerating failure in both) so a later device file or manual run starts clean. The planted-run instructions above restart Metro afterward for the same reason.
- Per-scenario run times and artifact layout were as documented in `docs/cli.md`; no surprises there.
