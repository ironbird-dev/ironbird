---
"@ironbird/cli": patch
---
New commands `ironbird snapshot save <file>` and `ironbird snapshot load <file>`. `save` writes `{ app, target, rev, snapshot }`, taking `app` from the target's status entry, and prints `{ target, app, rev, file }`. `load` validates the file before sending anything (`INVALID_PAYLOAD` with `{ name: 'snapshotLoad', issues }` for a file that isn't JSON or has the wrong shape), then sends `snapshotLoad` with the file's `snapshot` and `app`, so the target refuses another app's snapshot with `APP_MISMATCH`. A file that can't be read or written exits 2. `INVALID_SNAPSHOT` exits 1.
