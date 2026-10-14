import { IronbirdError, createRealClock, messageOf, type Clock } from '@ironbird/core';
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
  /**
   * Indexes into `steps` of rejected steps that changed the state or revision anyway (a dispatch
   * that mutated and then threw). The trace still leaves them out, so it may not replay faithfully.
   */
  rejectedAfterChange?: readonly number[];
}

const SLUG_MAX = 60;

/**
 * The shrunk run as a scenario file (M4 design §6.4): it drives a target into the violating state.
 * It has no `expect`, because invariants are code, so running it passes; add `wait` and `expect`
 * steps to make it a regression check. `clock` steps are plain milliseconds and not optional,
 * because the trace's timing is exact only on headless. Steps the app rejected are left out: on
 * replay their error would stop the scenario. A rejected step usually changed nothing; one that did
 * (`rejectedAfterChange`) is named in the description, because then replay may not reproduce the violation.
 */
export function traceYaml(trace: Trace): string {
  const applied = trace.steps.filter((step) => !step.rejected).map(({ rejected: _rejected, ...step }) => step);
  const changed = trace.rejectedAfterChange ?? [];
  const lines = [`modelTest seed ${trace.seed}, path ${trace.path}. A trace: it reproduces the violating state; add expect steps to make it a regression check.`];
  if (changed.length > 0) {
    lines.push(
      `Not faithfully replayable: steps ${changed.join(', ')} of details.steps were rejected after changing state; the trace leaves them out, so replay may not reproduce the violation.`,
    );
  }
  return stringify(
    {
      name: `Counterexample: ${trace.invariant}`,
      description: lines.join('\n'),
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
 * A directory or file that can't be written fails with `INTERNAL` naming the file (AGENTS.md rule 8).
 */
export async function writeTrace(dir: string, trace: Trace, clock: Pick<Clock, 'now'> = createRealClock()): Promise<string> {
  const root = path.resolve(dir);
  let file = path.join(root, `${traceSlug(trace.invariant)}.trace.yaml`);
  try {
    const stamp = new Date(clock.now()).toISOString().replace(/[:.]/g, '-');
    file = path.join(root, `${stamp}-${traceSlug(trace.invariant)}.trace.yaml`);
    const yaml = traceYaml(trace);
    await mkdir(root, { recursive: true });
    await writeFile(file, yaml);
    return file;
  } catch (error) {
    // The IronbirdError constructor takes no `cause`, so the original message goes in the details.
    throw new IronbirdError('INTERNAL', `Could not write trace ${file}: ${messageOf(error)}`, { file, message: messageOf(error) });
  }
}
