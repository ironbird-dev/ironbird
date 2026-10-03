#!/usr/bin/env node
// Prints one markdown table row per session whose id starts with <prefix>, for the per-batch tables
// in docs/evals/m3-agent-interface.md.
//
//   node examples/checkout/eval/summarize.mjs g1-
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import { CHECKS } from './lib/grading.mjs';
import { gradeLayout, layout, sessionLayout } from './lib/paths.mjs';
import { readJson } from './lib/proc.mjs';

const prefix = process.argv[2] ?? '';
const L = layout();
const tilde = (file) => file.replace(os.homedir(), '~');
const money = (value) => (typeof value === 'number' ? value.toFixed(2) : 'n/a');
const minutes = (ms) => (typeof ms === 'number' ? `${(ms / 60_000).toFixed(1)} min` : 'n/a');

async function main() {
  const ids = (await readdir(L.sessions).catch(() => [])).filter((id) => id.startsWith(prefix)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const lines = [
    '| Session | Valid | Success | Reproduced | Fixed | iOS (grader) | Verified (agent) | Cost (USD) | Duration | Turns | Denied calls | Out-of-folder paths | Transcript |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const id of ids) {
    const S = sessionLayout(L.home, id);
    const session = await readJson(S.record).catch(() => undefined);
    if (!session) continue;
    const grade = await readJson(gradeLayout(L.home, id).grade).catch(() => undefined);
    const checks = CHECKS.map((name) => (grade ? (grade.checks[name]?.pass ? 'pass' : 'fail') : 'not graded'));
    lines.push(
      `| ${[
        id,
        session.valid ? 'yes' : `no: ${session.invalidReasons.join('; ')}`,
        grade ? (grade.success ? 'yes' : 'no') : 'not graded',
        ...checks,
        money(grade?.costUsd ?? session.result?.costUsd),
        minutes(grade?.durationMs ?? session.result?.durationMs),
        grade?.numTurns ?? session.result?.numTurns ?? 'n/a',
        grade?.deniedToolCalls ?? session.deniedToolCalls ?? 'n/a',
        grade?.outOfFolderPaths?.length ?? session.outOfFolderPaths?.length ?? 'n/a',
        `\`${tilde(S.transcript)}\``,
      ].join(' | ')} |`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`summarize failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
