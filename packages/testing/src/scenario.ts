import { IronbirdError, type HeadlessDefinition, type ScenarioResult } from '@ironbird/core';
import { loadScenarioFiles, runScenario as runScenarioOnClient } from '@ironbird/cli/runner';
import path from 'node:path';
import { createTestTarget } from './target';

export interface RunScenarioFileOptions {
  headless: HeadlessDefinition;
  /** What the definition's factory sees as `env`; default `{}`. */
  env?: Record<string, string | undefined>;
  /** Artifacts root for the run directory (`<root>/runs/<stamp>-<slug>/`), or `false`, the default, to write nothing. */
  artifacts?: string | false;
}

/**
 * Runs one scenario file headless and in process, the way `ironbird scenario run` does (M4 design
 * §5): validated first, on a fresh target reset before the first step, disposed afterwards. A
 * failing scenario returns `passed: false`, so a test asserts on it and sees `failedStep`.
 */
export async function runScenario(file: string, options: RunScenarioFileOptions): Promise<ScenarioResult> {
  const resolved = path.resolve(file);
  const loaded = await loadScenarioFiles([resolved], process.cwd());
  const only = loaded[0];
  // loadScenarioFiles expands a directory; a test names one file, so a directory is an authoring error.
  if (loaded.length !== 1 || only === undefined || only.file !== resolved) {
    throw new IronbirdError('INVALID_SCENARIO', `runScenario takes one scenario file; ${resolved} is a directory`, {
      file: resolved,
      issues: [{ path: [], message: 'expected a scenario file, got a directory' }],
    });
  }
  const target = await createTestTarget({ headless: options.headless, env: options.env ?? {} });
  try {
    // `target: 'headless'` overrides the scenario's own target, like `--target headless`.
    return await runScenarioOnClient(target.client, only.scenario, { file: only.file, target: 'headless', artifacts: options.artifacts ?? false, reset: true });
  } finally {
    await target.dispose();
  }
}
