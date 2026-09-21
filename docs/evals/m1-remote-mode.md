# M1 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| 300 consecutive `step`s on iOS Simulator: stale-screenshot rate ≤ 1% and p95 ironbird overhead per step < 1.5 s (the latency half was restated at the gate; see Gate decision) | met | `pnpm measure -- --target ios`, run `20260921-020205-ios`: full motion stale 1/300 (0.33%), overhead p95 993 ms; reduced motion stale 1/300 (0.33%), overhead p95 715 ms. Both flagged captures are host chrome, not app content. Raw step latency p95 was 1793 ms and 1742 ms. Tables below |
| The same run on an Android emulator is recorded, and an Android target is set from the result | met | `pnpm measure -- --target android`, run `20260921-023331-android`, with the Expo Go developer menu dismissed: reduced motion stale 0/300, overhead p95 360 ms; full motion stale 50/300 (16.67%), overhead p95 425 ms. Android target: with motion reduced, stale ≤ 1% and p95 overhead < 1.5 s. The full-motion stale rate is the Q5 finding, not a target |
| A Metro reload mid-session fails the in-flight request with `TARGET_DISCONNECTED`, and the next request succeeds under the same target id | met | `examples/checkout/test/remote.device.test.ts`, "a reload fails the in-flight request with TARGET_DISCONNECTED and the next request runs under the same id" passes with `pnpm test:device` (2026-09-18) |
| `verify-bundle` passes on a production `expo export` and fails on a deliberately broken build | met | `expo export --platform ios --output-dir dist --clear` then `verify-bundle dist`: exit 0, 4 files scanned, `found: []`. `EXPO_PUBLIC_FORCE_BRIDGE=1 expo export --platform ios --output-dir dist-forced --clear` then `verify-bundle dist-forced`: exit 1, marker found in `dist-forced/_expo/static/js/ios/index-bbc76142eb9a98d2c66b84414d85207a.hbc` at offset 169655. `--clear` is required on both; see Follow-ups |
| A short written finding on Q5: stale rate with animations enabled versus reduced | met | Below |

## Gate decision (2026-09-20)

The maintainer made three decisions at the M1 gate.

1. **The latency criterion is judged on ironbird's overhead per step, not on raw step latency.** Overhead is the wall time of a `step` request minus the settle wait the bridge reports, which is the time the app itself took to become idle: its own timers, promises, and renders. What remains is transport, dispatch, and the host screenshot. The first run missed the raw 1.5 s bar in both motion arms for a reason that has nothing to do with ironbird: one step in five is `payment.start`, which spends 800 ms in the example's deliberate fake-server timers (`latencyMs` 300 + `echoDelayMs` 500 in `examples/checkout/src/ironbird/fakes/api.ts`), so every percentile above p80 measured the demo's pretend backend. The criterion was written to judge the tool, so it now excludes app-controlled time. Raw latency stays in the record, and the harness reports both.
2. **ADR-0005 is accepted: pure JavaScript, no native add-on.** Agent-driven development builds run with motion reduced; see the Q5 finding.
3. **ADR-0003 is accepted: the app dials out to the daemon over WebSocket.**

One constraint carries forward: staleness and capture time are coupled, as the harness results show, so any change to the capture path must re-measure both halves of the iOS criterion together.

## Harness results

Gate run, 2026-09-20 (run directories are stamped in UTC). Machine: Apple M3 Pro, macOS 27.0 (build 26A428), Node 26.9.0, Expo SDK 57 in Expo Go, iOS 26.2 on iPhone 17 (simulator), Android API 35 on the Pixel_9_API_35 AVD. Every step settled (0 unsettled in all four arms).

```
target   motion    stale   latency p50/p95 ms   overhead p50/p95 ms   stale rate   budget
ios      full      1       830/1793             674/993               0.33%        ok
ios      reduced   1       790/1742             648/715               0.33%        ok
android  full      50      452/1533             296/425               16.67%       n/a
android  reduced   0       450/1421             282/360               0.00%        n/a
```

Per command on iOS, in ms:

```
motion    command         latency p50/p95   overhead p95   settle wait p50
full      cart.addItem    810/1156          1028           130
full      cart.clear      805/1118          991            132
full      payment.start   1728/1968         888            1066
reduced   cart.addItem    783/858           715            133
reduced   cart.clear      786/852           723            138
reduced   payment.start   1727/1760         681            1078
```

Cycle per five steps: add haircut, add shampoo, clear, add beard trim, pay with the saved card. Every step changes the screen. Status bar frozen with `simctl status_bar override` and System UI demo mode. A capture counts as stale when more than 0.1% of pixels differ by more than 32 in any channel from a second capture taken one second later. The budget column is the iOS exit criterion; M1 defines no Android budget, so the harness prints `n/a` there. `summary.json` records the thresholds and the budget it was judged against, and percentiles are nearest rank.

Overhead is flat across commands, which is the evidence that it measures the tool and not the app. On iOS it sits near 650 to 680 ms at p50 whether the app did nothing (`cart.*`, settle wait about 130 ms) or spent a second in its own timers (`payment.start`, settle wait about 1070 ms). Most of it is `xcrun simctl io screenshot`. On Android, where `adb exec-out screencap` is cheaper, overhead is about 290 ms at p50. The full-motion iOS arm ran first in the session and was noisier (overhead p95 993 ms against 715 ms, with one 2668 ms outlier); both arms clear 1.5 s with room.

Both iOS flags are host chrome. In the reduced arm, step index 186 (`cart.addItem`, 1.25% of pixels) is the simulator omitting the Dynamic Island from one capture, the same artifact the first run saw. In the full arm, step index 85 (`cart.addItem`, 0.59%) is Expo Go's floating developer-tools button missing from the first capture and present in the second. App content is identical in both pairs, so app-level staleness on iOS is 0 of 600.

Staleness and capture time are coupled. The payment and receipt Reveals animate for 400 ms on the native driver, which settle cannot see. The iOS capture takes longer than the fade, so the shutter always fires after it: none of the 60 full-motion iOS payment captures landed mid-fade. The Android capture is faster than the fade, so 50 of the 60 full-motion Android payment captures landed mid-fade. iOS passes staleness with motion on because its capture is slow. A faster iOS capture path would move iOS toward the Android result, which is why a capture change must re-measure staleness and overhead together.

The roadmap's "narrow if needed" clause is keyed to the iOS stale rate (above 5%) and does not apply: the stale rate passes in both arms.

### First run (2026-09-18)

Judged on raw latency, before the gate decision, with floor-index percentiles. Android ran with the Expo Go developer-menu sheet on screen for the whole session, dimming the app and covering the receipt.

```
target   motion    stale    unsettled   p50 ms   p95 ms   stale rate   budget
ios      full      1        0           687      1625     0.33%        MISS
ios      reduced   0        0           700      1660     0.00%        MISS
android  full      54       0           360      1462     18.00%       n/a
android  reduced   0        0           357      1328     0.00%        n/a
```

The iOS raw p95 missed 1.5 s in both arms for the reason given under Gate decision; overhead computed from the same records was 590 ms and 581 ms at p95. The Android overlay turned out not to matter much: the clean gate run measured 16.67% against this run's 18.00%.

## Q5 finding

JS-only signals cannot see native-driver animations. With motion full on Android, 50 of the 60 `payment.start` steps were captured while the payment and receipt Reveals were still fading, which is 16.67% of all steps. The other 10 happened to be captured after the 400 ms fade ended, and no `cart.*` step differed. With motion full on iOS, no app content differed in any of the 300 steps, but that is capture timing, not detection: the iOS capture is slower than the fade.

With motion reduced, no app content differed in any capture on either platform: zero nonzero pixel diffs in the 300 Android pairs, and on iOS only the Dynamic Island artifact. The first run agrees, with zero nonzero diffs in its 600 reduced-motion pairs. Reducing motion closes the blind spot completely.

Decision: no native add-on (ADR-0005 accepted). Agent-driven development builds run with motion reduced, as documented in docs/api.md under "Reduce motion in agent-driven builds". Revisit if adopters cannot reduce motion in their development builds, or if staleness appears with motion reduced.

## Follow-ups

- Expo Go puts its own UI over the app: a developer-menu sheet on first launch (Android, first run), a System UI "isn't responding" dialog right after emulator boot (gate run, dismissed with Wait), and a floating developer-tools button on iOS that was missing from one capture. Look at a screenshot before measuring, and expect an occasional host-chrome flag. A development build instead of Expo Go would remove the first and the third.
- The `Pixel_9_API_35` AVD needed its data partition bumped from 6 GB to 12 GB and its RAM from 2 GB to 4 GB before it could complete a 300-step run without stalling or running out of storage; these are host-machine `~/.android/avd` config changes, not committed to the repository.
- On this host and Expo SDK 57: running the plain and forced exports back to back without clearing the Metro cache produced a wrong result, in the direction of whichever export ran first — a stale cached transform of `index.js` from an earlier invocation carried over, making a "plain" export wrongly include the bridge (when a forced export had run first) or a "forced" export wrongly exclude it (when a plain export had run first). Pass `--clear` on both `expo export` invocations when proving `verify-bundle` to avoid this; this is what Step 1's recorded runs did.
- The harness still writes captures to the shared `.ironbird/screenshots/` directory rather than the run directory, and writes `summary.json` only after every arm finishes, so a failed arm loses the finished arms' summary.
