import { createRealClock, type Clock } from '@ironbird/core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import type { RecordedStep } from './steps';

export interface Trace {
  invariant: string;
  seed: number;
  path: string;
  /** The executed prefix, rejected steps included; only the applied ones are written. */
  steps: RecordedStep[];
}

const SLUG_MAX = 60;

/**
 * The shrunk run as a scenario file (M4 design §6.4): it drives a target into the violating state.
 * It has no `expect`, because invariants are code, so running it passes; add `wait` and `expect`
 * steps to make it a regression check. `clock` steps are plain milliseconds and not optional,
 * because the trace's timing is exact only on headless. Steps the app rejected are left out: they
 * changed nothing, and on replay their error would stop the scenario.
 */
export function traceYaml(trace: Trace): string {
  const applied = trace.steps.filter((step) => !step.rejected).map(({ rejected: _rejected, ...step }) => step);
  return stringify(
    {
      name: `Counterexample: ${trace.invariant}`,
      description: `modelTest seed ${trace.seed}, path ${trace.path}. A trace: it reproduces the violating state; add expect steps to make it a regression check.`,
      steps: [{ reset: true }, ...applied],
    },
    { lineWidth: 0 },
  );
}

/** Lowercase, dashes for anything else, at most 60 characters; the same rule as scenario run directories. */
export function traceSlug(invariant: string): string {
  const slug = invariant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug === '' ? 'invariant' : slug;
}

/**
 * Writes `<dir>/<UTC stamp>-<slug>.trace.yaml`, creating `dir`, and returns the absolute path. The
 * stamp comes from the injected clock, never from `Date.now` (AGENTS.md rule 9); tests pass a fixed one.
 */
export async function writeTrace(dir: string, trace: Trace, clock: Pick<Clock, 'now'> = createRealClock()): Promise<string> {
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });
  const stamp = new Date(clock.now()).toISOString().replace(/[:.]/g, '-');
  const file = path.join(root, `${stamp}-${traceSlug(trace.invariant)}.trace.yaml`);
  await writeFile(file, traceYaml(trace));
  return file;
}
