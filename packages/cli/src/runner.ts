// The part of the CLI that test runners reuse: the in-process headless target and the scenario
// engine. Unlike the ESM-only main entry it is built as ESM and CommonJS, so Jest and other
// CommonJS callers can require it (M4 design D1). Nothing reachable from here may use top-level
// await or import.meta, which a CommonJS build can't express.
export { createHeadlessTarget } from './headless-target';
export type { HeadlessTarget, HeadlessTargetOptions } from './headless-target';
export { loadScenarioFiles, parseScenario } from './scenario/parse';
export type { Scenario, ScenarioStep } from './scenario/parse';
export { runScenario } from './scenario/run';
export type { RunScenarioOptions } from './scenario/run';
export type { DaemonClient } from './cli/client';
