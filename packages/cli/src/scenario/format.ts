import type { ScenarioResult } from '@ironbird/core';
import path from 'node:path';

/** The TTY rendering of one scenario result: a PASS or FAIL line, then the failed step and any artifact problems. */
export function formatScenarioResult(result: ScenarioResult, cwd: string): string {
  const skipped = result.skipped.length === 0 ? '' : `  skipped ${result.skipped.join(',')}`;
  const artifacts = result.artifacts === null ? '' : `  ${path.relative(cwd, result.artifacts) || '.'}`;
  const lines = [`${result.passed ? 'PASS' : 'FAIL'} ${result.scenario}  ${result.target}  ${result.stepsRun} steps  ${result.durationMs} ms${skipped}${artifacts}\n`];
  const failed = result.failedStep;
  if (failed) {
    const repetition = failed.repetition === undefined ? '' : ` (repetition ${failed.repetition})`;
    lines.push(`  step ${failed.index}${repetition}: ${JSON.stringify(failed.step)}\n`);
    if ('expected' in failed) lines.push(`  expected: ${JSON.stringify(failed.expected)}\n`);
    if ('actual' in failed) lines.push(`  actual: ${JSON.stringify(failed.actual)}\n`);
    if (failed.error) {
      lines.push(`  error ${failed.error.code}: ${failed.error.message}\n`);
      if (failed.error.details !== undefined) lines.push(`  ${JSON.stringify(failed.error.details)}\n`);
    }
  }
  for (const problem of result.artifactErrors ?? []) lines.push(`  artifact not written: ${problem}\n`);
  return lines.join('');
}
