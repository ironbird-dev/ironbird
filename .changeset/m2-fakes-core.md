---
"@ironbird/core": patch
---

`defineFake` declares a fake port with Zod-validated controls: `create` returns the port and one handler per control, an extra handler fails instance creation with `UNKNOWN_CONTROL`, and control errors name the control as `<fake>.<control>`. Every fake port records the calls the app makes on it (`FakeInstance.calls(since, limit)` returns `{ calls, nextSeq, truncated }`, kept to 10,000 per fake) and carries the fake mark that `tracker.wrap` reads. `FakeCall.outcome` gains `threw`, and `FakeCall` gains `error` for `threw` and `rejected`. New exports: `defineFake`, `FakeContext`, `ControlHandlers`, `FakeDefinition`, `FakeFactory`, `FakeCallsResult`.
