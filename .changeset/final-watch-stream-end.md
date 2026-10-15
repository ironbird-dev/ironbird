---
"@ironbird/cli": patch
---

`ironbird watch` and `ironbird events --follow` no longer exit 0 when the daemon closes the stream without an `error` frame, as when it shuts down or the connection drops. `watch` lets a read in flight print first. Both then print `{ "error": { "code": "TARGET_DISCONNECTED", ... } }` with `{ target, op: "stream" }` and exit 1. SIGINT still ends them with exit 0.
