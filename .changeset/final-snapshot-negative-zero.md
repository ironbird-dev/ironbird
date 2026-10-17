---
"@ironbird/core": patch
---

`serializeSnapshot` refuses `-0` with `INVALID_SNAPSHOT` and `{ path, reason: '-0' }`. JSON writes `-0` as `0`, so a saved `-0` loaded back as a different number; `snapshotSave` now fails instead of changing state on the round trip.
