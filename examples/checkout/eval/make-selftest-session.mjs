#!/usr/bin/env node
// Builds a synthetic session for checking the grader without running claude:
//
//   node examples/checkout/eval/make-selftest-session.mjs <id> --fix|--no-fix
//
// The session is a clone of the template with the held-back race scenario added as
// ironbird/scenarios/selftest-repro.yaml and, with --fix, the known fix applied. It has an empty
// transcript and no agent runs, so the grader's agent-evidence check always fails on it; the other
// three checks show whether the grader tells a fixed session from an unfixed one.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyEdits, KNOWN_FIX } from './lib/fixture.mjs';
import { layout, RACE_SCENARIO, sessionId, sessionLayout } from './lib/paths.mjs';
import { clone, writeJson } from './lib/proc.mjs';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { fix: { type: 'boolean' }, 'no-fix': { type: 'boolean' } } });

async function main() {
  const id = sessionId(positionals[0]);
  if (options.fix === options['no-fix']) throw new Error('Pass exactly one of --fix or --no-fix');
  const L = layout();
  const S = sessionLayout(L.home, id);
  if (await stat(S.dir).then(() => true, () => false)) throw new Error(`${S.dir} exists; use a new id`);
  await clone(L.template, S.project);
  await copyFile(RACE_SCENARIO, path.join(S.project, 'ironbird/scenarios/selftest-repro.yaml'));
  if (options.fix) await applyEdits(S.project, [KNOWN_FIX]);
  await writeFile(S.transcript, '');
  await mkdir(S.agentRuns, { recursive: true });
  await writeJson(S.record, { session: id, label: 'selftest', valid: true, fixed: Boolean(options.fix), invalidReasons: [] });
  process.stdout.write(`${JSON.stringify({ session: id, project: S.project, fixed: Boolean(options.fix) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`make-selftest-session failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
