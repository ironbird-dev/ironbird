---
"@ironbird/core": patch
"@ironbird/cli": patch
---

`INVALID_SCENARIO` joins the error codes and exits 2 in the CLI. `ScenarioResult` gains `file`, `stepsRun`, `failedStep.repetition`, `failedStep.expected`, and `artifactErrors`, and `artifacts` becomes nullable. The daemon-side `scenarioRun` operation, which no daemon ever implemented, leaves the protocol docs: scenarios run in the CLI.
