# M1 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| 300 consecutive `step`s on iOS Simulator: stale-screenshot rate ≤ 1% and p95 latency < 1.5 s | not met | `pnpm measure -- --target ios`, reduced motion: stale 0/300 (0.00%), p95 1660 ms (miss); full motion: stale 1/300 (0.33%), p95 1625 ms (miss). Stale passes in both arms; p95 misses in both arms and is not helped by reducing motion. Table below |
| The same run on an Android emulator is recorded, and an Android target is set from the result | met | `pnpm measure -- --target android`: reduced motion stale 0/300, p95 1328 ms; full motion stale 54/300, p95 1462 ms. Android target: stale ≤ 1% and p95 < 1.5 s, based on the reduced-motion run, which measured 0 nonzero diffs under the same Expo Go dev-menu overlay that was on screen for both arms; the full-motion 18% figure is a measurement floor from that overlay (see Q5 finding), not a reliable full-motion baseline |
| A Metro reload mid-session fails the in-flight request with `TARGET_DISCONNECTED`, and the next request succeeds under the same target id | met | `examples/checkout/test/remote.device.test.ts`, "a reload fails the in-flight request with TARGET_DISCONNECTED and the next request runs under the same id" passes with `pnpm test:device` (2026-09-18) |
| `verify-bundle` passes on a production `expo export` and fails on a deliberately broken build | met | `expo export --platform ios --output-dir dist --clear` then `verify-bundle dist`: exit 0, 4 files scanned, `found: []`. `EXPO_PUBLIC_FORCE_BRIDGE=1 expo export --platform ios --output-dir dist-forced --clear` then `verify-bundle dist-forced`: exit 1, marker found in `dist-forced/_expo/static/js/ios/index-bbc76142eb9a98d2c66b84414d85207a.hbc` at offset 169655. `--clear` is required on both; see Follow-ups |
| A short written finding on Q5: stale rate with animations enabled versus reduced | met | Below |

## Harness results

Machine: Apple M3 Pro, macOS 27.0 (build 26A428), Node 26.8.2, Expo SDK 57 in Expo Go, iOS 26.2 on iPhone 17 (simulator), Android API 35 on the Pixel_9_API_35 AVD.

```
target   motion    stale    unsettled   p50 ms   p95 ms   stale rate   budget
ios      full      1        0           687      1625     0.33%        MISS
ios      reduced   0        0           700      1660     0.00%        MISS
android  full      54       0           360      1462     18.00%       n/a
android  reduced   0        0           357      1328     0.00%        n/a
```

Cycle per five steps: add haircut, add shampoo, clear, add beard trim, pay with the saved card. Every step changes the screen. Status bar frozen with `simctl status_bar override` and System UI demo mode. A capture counts as stale when more than 0.1% of pixels differ by more than 32 in any channel from a second capture taken one second later. The harness's own printed `ok`/`MISS` budget column applies the iOS budget (stale ≤ 1%, p95 < 1.5 s) to every arm, including Android, for which M1 defines no budget; the table above prints `n/a` for both Android rows rather than the harness's own column, and the Android numbers should not be read as gate verdicts.

The iOS p95 miss is motion-independent, not a variance artifact: `payment.start` is 1 of the 5 cycle positions (20% of steps, comfortably past p80), and every `payment.start` sample carries the payment fake's fixed 800 ms deliberate timer (`latencyMs` 300 + `echoDelayMs` 500 in `examples/checkout/src/ironbird/fakes/api.ts`) plus roughly 545 ms of `xcrun simctl io screenshot` capture time, landing at p50 1611 ms (full) / 1649 ms (reduced) and p95 1657 ms / 1672 ms; non-`payment.start` steps sit at p95 ~741 ms in both arms. The miss decomposes as ~50% the payment fake's 800 ms timers, ~34% the ~545 ms `simctl` capture, and ~16% settle and dispatch overhead beyond those two; the same cycle and the same 800 ms fake land at p95 1462 ms (full) / 1328 ms (reduced) on Android, because `adb exec-out screencap` costs only ~190 ms (`latencyMs` minus `waitedMs`, p50 ~194 ms) against `simctl`'s ~545 ms, which localizes the iOS miss to capture cost rather than to the transport or to settle detection. Whether to change the scenario's cycle mix, the capture path, or the 1.5 s criterion itself is the maintainer's gate decision, not one this record makes.

The roadmap's "narrow if needed" clause is keyed to the iOS stale rate (above 5%), not to p95 latency, and does not apply here: stale rate passes comfortably in both arms.

## Q5 finding

With animations enabled, the only source of visible app motion was on Android: all 60/60 full-motion `payment.start` steps produced a nonzero diff, concentrated in the Payment panel where the 400 ms Reveal opacity fade was caught mid-flight, plus one `cart.addItem` step (index 0) where the header hero image swap was mid-transition. The resulting 18% (54/300) full-motion stale rate is a measurement floor, not an inflated figure: the Expo Go developer-menu overlay was left on screen for the whole Android session, and its scrim dimmed the app (~60% luminance attenuation) and covered the bottom ~30% including the Receipt Reveal, suppressing diffs that would otherwise register (an unoccluded run would show ≥20%, 60/300; seven full-arm payment steps already sit at 0.074–0.079%, just under the 0.1% threshold). iOS showed no app-level staleness in either arm (0/600): its one flagged full-motion step (index 70, `cart.addItem`) was a nondeterministic Dynamic Island artifact in the `simctl` capture itself, not an app animation. With motion reduced, both platforms recorded zero nonzero pixel diffs across all 1200 reduced-arm captures, so JS-only settle detection is sufficient to hit the 0.1% stale threshold once motion is reduced. On this evidence an optional native add-on for UI-thread animation visibility is not warranted now; it would only be worth revisiting if a future full-motion Android run, taken without the dev-menu overlay in the way, still showed meaningful app-level staleness.

## Follow-ups

- The Android dev-menu overlay sat on screen for the entire measurement session (both arms) and was never dismissed; it suppressed rather than caused the full-motion stale diffs. A future baseline run should dismiss it first so the full-motion Android number reflects the app, not the overlay.
- The `Pixel_9_API_35` AVD needed its data partition bumped from 6 GB to 12 GB and its RAM from 2 GB to 4 GB before it could complete a 300-step run without stalling or running out of storage; these are host-machine `~/.android/avd` config changes, not committed to the repository.
- On this host and Expo SDK 57: running the plain and forced exports back to back without clearing the Metro cache produced a wrong result, in the direction of whichever export ran first — a stale cached transform of `index.js` from an earlier invocation carried over, making a "plain" export wrongly include the bridge (when a forced export had run first) or a "forced" export wrongly exclude it (when a plain export had run first). Pass `--clear` on both `expo export` invocations when proving `verify-bundle` to avoid this; this is what Step 1's recorded runs did.
- iOS per-command latency is cleanly bimodal (non-`payment.start` p95 ~741 ms in both arms, `payment.start` p95 ~1660 ms) with zero overlap, which made the p95 miss easy to attribute; a harness that reported per-command percentiles alongside the pooled ones would make this diagnosis immediate without needing to read the raw `steps-*.jsonl` files.
