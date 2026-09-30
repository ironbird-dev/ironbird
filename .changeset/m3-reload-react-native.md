---
"@ironbird/react-native": patch
---

The bridge declares the `reload` capability when `DevSettings.reload` exists, and answers `reload` by replying and then calling `DevSettings.reload()` on the next tick, so `ironbird reload` can restart a dev build from the bundler.
