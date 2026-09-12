---
"@ironbird/core": patch
"@ironbird/cli": patch
"ironbird": patch
---

Pre-merge fixes for the M0 headless loop.

- `EventRecorder` gains `lastSeq()`, an O(1) read of the latest sequence number.
- The headless target bounds its factory with `bootTimeoutMs` (default 30 s) and reports every boot failure as `HEADLESS_LOAD_FAILED`, so a hanging or throwing factory can no longer wedge `run`, `reset`, or `dispose`. A read-only `settle` now fails promptly when a reset or dispose abandons it.
- The daemon bounds each target operation with `requestTimeoutMs` (default 30 s), refuses requests that carry an `Origin` header or a foreign `Host` with 403, and answers unknown routes with `UNSUPPORTED`.
- A config file that fails to load reports `INVALID_CONFIG` with `{ file, issues }`, and an unknown top-level key in `ironbird.config.ts` is now an error rather than being ignored.
- A `serve` that fails to bind no longer deletes a running daemon's `.ironbird/daemon.json`.
- `@ironbird/cli` no longer re-exports the unused `MUTATING_OPS`.
- `createHeadlessTarget` accepts `entryPath`, reported as `details.entry` on boot failures; the daemon's request bound follows the operation's own timeout.
