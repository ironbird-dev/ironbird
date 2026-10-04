---
"@ironbird/core": patch
---
New error code `INVARIANT_FAILED`, raised by `@ironbird/testing`'s `modelTest` when a generated sequence of steps violates an invariant, with details `{ invariant, message, seed, path, runs, steps, scenarioFile, traceReplayable }`, where `traceReplayable` is `false` when a rejected step changed state, so the trace may not reproduce the violation. It is raised in the test process and never crosses the wire, so `PROTOCOL_VERSION` stays 1.
