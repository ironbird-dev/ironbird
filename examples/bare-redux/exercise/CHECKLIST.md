# Scoring checklist

Run every command from the app's folder, with no other `ironbird serve` running. Each check passes only as its last column says. Record each result in RESULTS.md. The proxy eval's grader (`examples/bare-redux/eval/grade.mjs` in the ironbird repository) runs the same five checks, with the ids in brackets.

| # | Check | How | Passes when |
|---|---|---|---|
| 1 | `ironbird serve` loads the headless entry [`serve`] | `npx ironbird serve`, left running; then, in a second terminal, `npx ironbird status` | `status` lists a target with id `headless` |
| 2 | `ironbird commands` lists the declared commands [`commands`] | `npx ironbird commands` | Every command in TASK.md's Commands table is listed |
| 3 | The acceptance scenario passes headlessly [`acceptance`] | `npx ironbird scenario run acceptance.yaml --target headless --json`; then stop `serve` | Exit code 0 and `"passed": true` |
| 4 | The bridge is started in development builds only [`bridgeDevOnly`] | `npx react-native bundle --platform ios --dev true --entry-file index.js --bundle-output build/dev.ios.js --assets-dest build/assets`, then `npx ironbird verify-bundle build/dev.ios.js` | The app's source calls `startBridge` from `@ironbird/react-native`, and `verify-bundle` finds the bridge in the development bundle (exit code 1) |
| 5 | Release bundles don't contain the bridge [`releaseBundleClean`] | `npx react-native bundle --platform ios --dev false --minify true --entry-file index.js --bundle-output build/release.ios.js --assets-dest build/assets`, then `npx ironbird verify-bundle build/release.ios.js` | Exit code 0 and `found` is empty |

Checks 4 and 5 together show that the bridge runs in development builds and nowhere else. Check 5 alone also passes for an app with no bridge at all.
