---
"@ironbird/cli": patch
---
New subpath `@ironbird/cli/runner`, published in ESM and CommonJS with type declarations: `createHeadlessTarget`, `loadScenarioFiles`, `parseScenario`, `runScenario`, and the `HeadlessTarget`, `HeadlessTargetOptions`, `Scenario`, `ScenarioStep`, `RunScenarioOptions`, and `DaemonClient` types. The main entry stays ESM only; the subpath lets CommonJS callers such as Jest reuse the headless target and the scenario engine, and it is how `@ironbird/testing` reaches the CLI.
