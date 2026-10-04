---
"@ironbird/core": patch
---
New error code `INVARIANT_FAILED`, raised by `@ironbird/testing`'s `modelTest` when a generated sequence of steps violates an invariant, with details `{ invariant, message, seed, path, runs, steps, scenarioFile }`. It is raised in the test process and never crosses the wire, so `PROTOCOL_VERSION` stays 1.
