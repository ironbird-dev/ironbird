---
"@ironbird/cli": patch
---
New command `ironbird watch [--path <path>]`. It prints `{ rev, patch }` JSON lines, where `patch` is an RFC 6902 JSON Patch from the last printed value to the new one, with pointers relative to `--path`. The first line is an `add` at `""` with the current value, or `[]` when the path is missing; a path that later disappears or appears prints a `remove` or `add` at `""`. It opens the stream before its first read and waits for the daemon's initial `state` frame, keeps one read in flight, and reads again after any frame that arrived during a read, so it misses no change, including after a `reset`. State is sampled at up to 10 frames per second. SIGINT exits 0; an `error` frame or a failed read prints `{ error }` and exits with that error's code.
