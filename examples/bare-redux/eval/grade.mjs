#!/usr/bin/env node
// Grades the integration proxy on CHECKLIST.md's five checks (M5 design D11).
//
//   node examples/bare-redux/eval/grade.mjs <session-id> [--out <dir>]    a proxy session, on a copy of its project
//   node examples/bare-redux/eval/grade.mjs --project <dir> [--out <dir>] any folder, graded in place (a human trial)
//   node examples/bare-redux/eval/grade.mjs --selftest [--out <dir>]      the wired example, in place; exits 1 unless 5/5
//
// Writes grade.json (and final-report.md for a session) and prints one JSON summary line.
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { clone, readJson, run, writeJson } from '../../checkout/eval/lib/proc.mjs';
import { parseTranscript } from '../../checkout/eval/lib/transcript.mjs';
import { proxyEnv } from './lib/args.mjs';
import { docsRead } from './lib/docs.mjs';
import { gradeProject } from './lib/grade-project.mjs';
import { ACCEPTANCE, exampleDir, proxyGradeLayout, proxyLayout, proxySessionLayout, sessionId } from './lib/paths.mjs';
import { fullReport } from './lib/session-totals.mjs';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, project: { type: 'string' }, selftest: { type: 'boolean' } } });
const L = proxyLayout();
const env = proxyEnv(process.env);
const exists = (file) => stat(file).then(() => true, () => false);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** What changed in a project that is a git repository (the template is one), as porcelain lines; null otherwise. */
async function changes(project) {
  if (!(await exists(path.join(project, '.git')))) return null;
  return (await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project })).stdout.split('\n').filter(Boolean);
}

async function main() {
  const modes = [Boolean(options.selftest), Boolean(options.project), positionals.length > 0].filter(Boolean).length;
  if (modes !== 1) throw new Error('Pass exactly one of <session-id>, --project <dir>, or --selftest');

  if (options.selftest || options.project) {
    const kind = options.selftest ? 'selftest' : 'folder';
    const project = path.resolve(options.selftest ? exampleDir : options.project);
    const out = path.resolve(options.out ?? path.join(L.grades, `${kind}-${stamp()}`));
    const graded = await gradeProject({ project, acceptance: ACCEPTANCE, out, env });
    const grade = { kind, project, gradedAt: new Date().toISOString(), ...graded, changes: await changes(project) };
    await writeJson(path.join(out, 'grade.json'), grade);
    process.stdout.write(`${JSON.stringify({ kind, project, score: grade.score, passed: grade.passed, grade: path.join(out, 'grade.json') })}\n`);
    if (options.selftest && !grade.passed) process.exitCode = 1;
    return;
  }

  const id = sessionId(positionals[0]);
  const S = proxySessionLayout(L.home, id);
  const G = proxyGradeLayout(options.out ?? L.grades, id);
  const record = await readJson(S.record).catch(() => {
    throw new Error(`No ${S.record}; run run-session.mjs ${id} first`);
  });
  await rm(G.dir, { recursive: true, force: true });
  await clone(S.project, G.session);
  const graded = await gradeProject({ project: G.session, acceptance: ACCEPTANCE, out: G.out, env });
  const parsed = parseTranscript(await readFile(S.transcript, 'utf8').catch(() => ''));
  const docs = docsRead(parsed.calls, [S.docs, await realpath(S.docs).catch(() => S.docs)]);
  await writeFile(G.report, `${fullReport(parsed)}\n`);
  const grade = { kind: 'session', session: id, gradedAt: new Date().toISOString(), valid: record.valid, invalidReasons: record.invalidReasons, result: record.result ?? null, ...graded, changes: await changes(G.session), docsRead: docs };
  await writeJson(G.grade, grade);
  process.stdout.write(`${JSON.stringify({ session: id, valid: grade.valid, score: grade.score, passed: grade.passed, docsRead: docs.read.length, grade: G.grade })}\n`);
}

main().catch((error) => {
  process.stderr.write(`grade failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
