---
"@ironbird/cli": patch
---

`ironbird watch` and `ironbird events --follow` no longer exit 0 when the daemon closes the stream without an `error` frame, as when it shuts down or the connection drops. `watch` lets a read in flight print first. Both then print `{ "error": { "code": "TARGET_DISCONNECTED", ... } }` with `{ target, op: "stream" }` and exit 1. Every other failure, such as a backlog or cursor read or a stream that fails to open, now also ends with a `{ "error": ... }` JSON line, even in a TTY, rather than human-readable text. SIGINT or SIGTERM still ends them with exit 0, and `events --follow` now honours it while the backlog is still being read.
