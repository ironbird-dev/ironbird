---
"@ironbird/cli": patch
---

`ironbird watch` no longer exits 0 when the daemon closes the stream without an `error` frame, as when it shuts down or the connection drops. It lets a read in flight print, then prints `{ "error": { "code": "TARGET_DISCONNECTED", ... } }` with `{ target, op: "stream" }` and exits 1. SIGINT still ends it with exit 0.
