---
"@ironbird/cli": patch
---

The headless target runs `fakeControl` as a settled step and answers `fakeCalls` with `{ calls, nextSeq, truncated }`; an unknown fake fails with `UNKNOWN_FAKE` and `{ fake, available, suggestions }`, and an app that wires no fakes answers `UNSUPPORTED`. New command: `ironbird fake <fake> <control> [payload]` runs a control and prints a step result, and `ironbird fake <fake> --calls [--since <seq>]` prints the fake's recorded calls.
