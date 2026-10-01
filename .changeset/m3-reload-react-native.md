---
"@ironbird/react-native": patch
---

`startBridge` takes an optional `reload` option. The bridge declares the `reload` capability when that option or `DevSettings.reload` exists, and answers `reload` by replying and then calling the option (or `DevSettings.reload()`) on the next tick, so `ironbird reload` can restart a dev build from the bundler. Expo Go apps pass `reloadAppAsync` from `expo`, because `DevSettings.reload` leaves Expo Go without its native modules.
