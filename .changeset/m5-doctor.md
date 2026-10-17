---
"@ironbird/cli": patch
---
New command `ironbird doctor`, which needs no daemon. It checks the Node version, `ironbird.config.ts`, that the headless entry loads (printing the import chain when it imports `react-native`), that the daemon and bridge ports are free or held by an ironbird daemon, that `.ironbird/` is gitignored, and that every installed ironbird package and the running CLI share one version; `xcrun simctl` and `adb`, with their devices, are reported for information. It prints `{ checks: [{ id, ok, required, detail, fix? }] }` and exits 0 when every required check passes and 1 otherwise. From this release on, every ironbird package is released at the same version.
