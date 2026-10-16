---
"@ironbird/cli": patch
---
The headless target serves `snapshotSave` and `snapshotLoad` when the app's `Target` implements `persist` and `restore`. A save is strict (`INVALID_SNAPSHOT` naming the first value that can't be saved losslessly); a load takes an optional `app`, refused with `APP_MISMATCH` when it isn't this target's app id, and runs in the mutating queue. After a successful `reset` or `reload`, the headless target notifies state listeners, so a stream sees a `state` frame with the new session's revision.
