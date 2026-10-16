---
"@ironbird/react-native": patch
---
`snapshotSave` is strict: a persisted state holding a `Map`, a `Date`, a class instance, a cycle, or another value that can't be saved losslessly fails with `INVALID_SNAPSHOT` naming its path, instead of saving a placeholder. `snapshotLoad` takes an optional `app` and refuses another app's snapshot with `APP_MISMATCH` before calling `restore`; a non-string `app` or a missing `snapshot` is `INVALID_PAYLOAD`.
