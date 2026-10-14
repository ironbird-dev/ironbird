#!/usr/bin/env node
// Builds the integration proxy's template under <eval home>/proxy/ (M5 design D11): the integration
// exercise as a standalone git repository with ironbird 0.1.0 tarballs in vendor/ and its own
// dependencies installed; the published docs; a check of both; and a baseline, the init event of one
// Claude Code start in an empty folder. The template is also what a human trial participant gets.
//
//   node examples/bare-redux/eval/prepare.mjs [--skip-build] [--skip-baseline]
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { captureBaselineInit, claudeVersion } from '../../checkout/eval/lib/claude.mjs';
import { baselineFromInit, checkBaseline } from '../../checkout/eval/lib/isolation.mjs';
import { clone, must, readJson, writeJson } from '../../checkout/eval/lib/proc.mjs';
import { sandboxProfile } from '../../checkout/eval/lib/sandbox.mjs';
import { ancestorInstructionFiles, isInside, listFiles } from '../../checkout/eval/lib/tree.mjs';
import { proxyEnv } from './lib/args.mjs';
import { docsSet, mentions } from './lib/docs.mjs';
import { sourcesState } from './lib/freshness.mjs';
import { gradeProject } from './lib/grade-project.mjs';
import { ACCEPTANCE, evalHome, exerciseDir, MODEL_PATTERN, PROXY_SOURCES, proxyLayout, repoRoot } from './lib/paths.mjs';
import { ironbirdMentions, isTextFile, shouldCopy, standaloneProblems } from './lib/project.mjs';
import { INSTALL_FLAGS, installCommands, installProblems, packJson, RELEASE_VERSION, releaseManifest, tarballName, VENDORED } from './lib/vendor.mjs';

const { values: options } = parseArgs({ options: { 'skip-build': { type: 'boolean' }, 'skip-baseline': { type: 'boolean' } } });
const L = proxyLayout();
const env = proxyEnv(process.env);
const step = (message) => process.stderr.write(`prepare: ${message}\n`);
const readText = (file) => readFile(file, 'utf8').catch(() => '');
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

async function preflight() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Node ${process.versions.node}; the harness needs Node 22 or later`);
  if (isInside(L.home, repoRoot)) throw new Error(`The eval home ${L.home} is inside the repository; sessions must run outside it`);
  const instructions = await ancestorInstructionFiles(L.home);
  if (instructions.length > 0) throw new Error(`Instruction files above the eval home would load into every session: ${instructions.join(', ')}`);
}

/** The exercise, copied without dependencies or build output, and audited: standalone, and silent about ironbird outside its materials. */
async function copyExercise() {
  step(`copying ${path.relative(repoRoot, exerciseDir)} to ${L.template}`);
  await rm(L.template, { recursive: true, force: true });
  await mkdir(L.home, { recursive: true });
  await cp(exerciseDir, L.template, { recursive: true, filter: (source) => shouldCopy(path.relative(exerciseDir, source).split(path.sep).join('/')) });
  let tsconfig;
  try {
    tsconfig = JSON.parse(await readText(path.join(L.template, 'tsconfig.json')));
  } catch {
    tsconfig = null;
  }
  const problems = standaloneProblems({ manifest: await readJson(path.join(L.template, 'package.json')), tsconfig, gitignore: await readText(path.join(L.template, '.gitignore')) });
  if (problems.length > 0) throw new Error(`The exercise does not stand alone outside the monorepo; fix plan 4's generator:\n  ${problems.join('\n  ')}`);
  const files = (await listFiles(L.template, new Set(['node_modules', '.git']))).filter(isTextFile);
  const texts = await Promise.all(files.map(async (file) => ({ file, text: await readFile(path.join(L.template, file), 'utf8') })));
  const hits = ironbirdMentions(texts);
  if (hits.length > 0) throw new Error(`The exercise names ironbird outside its materials; fix plan 4's generator:\n${hits.map((hit) => `  ${hit.file}:${hit.line} ${hit.excerpt}`).join('\n')}`);
  return { files: files.length };
}

/** Each vendored package packed with pnpm, then repacked at RELEASE_VERSION with its internal ranges moved to it. */
async function vendorTarballs() {
  step(`packing ${VENDORED.map((entry) => entry.name).join(', ')} at ${RELEASE_VERSION}`);
  const internal = [];
  for (const dir of await readdir(path.join(repoRoot, 'packages'))) {
    const manifest = await readJson(path.join(repoRoot, 'packages', dir, 'package.json')).catch(() => null);
    if (manifest && manifest.private !== true) internal.push(manifest.name);
  }
  const vendor = path.join(L.template, 'vendor');
  await mkdir(vendor, { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'ironbird-proxy-pack-'));
  const tarballs = {};
  try {
    for (const { name, dir } of VENDORED) {
      const packed = packJson((await must('pnpm', ['pack', '--pack-destination', scratch, '--json'], { cwd: path.join(repoRoot, 'packages', dir) })).stdout);
      const unpacked = path.join(scratch, dir);
      await mkdir(unpacked);
      await must('tar', ['-xzf', packed.filename, '-C', unpacked]);
      const manifestFile = path.join(unpacked, 'package', 'package.json');
      await writeJson(manifestFile, releaseManifest(await readJson(manifestFile), RELEASE_VERSION, internal));
      const tarball = path.join(vendor, tarballName(name, RELEASE_VERSION));
      await must('tar', ['-czf', tarball, '-C', unpacked, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      tarballs[path.basename(tarball)] = await sha256(tarball);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return tarballs;
}

async function installAndCommit() {
  step("npm install: the app's own dependencies");
  await must('npm', ['install', ...INSTALL_FLAGS], { cwd: L.template, env, timeoutMs: 20 * 60_000 });
  step('git init');
  const git = (...args) => must('git', ['-c', 'user.name=Exercise', '-c', 'user.email=exercise@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: L.template });
  await git('init', '-q', '-b', 'main');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'Integration exercise');
}

/** The published docs (lib/docs.mjs), copied with their paths, and where they name the example. */
async function copyDocs() {
  step(`copying the published docs to ${L.docs}`);
  const listed = (await must('git', ['ls-files', '--', 'README.md', 'docs', 'packages'], { cwd: repoRoot })).stdout.split('\n').filter(Boolean);
  const files = docsSet(listed);
  await rm(L.docs, { recursive: true, force: true });
  for (const file of files) {
    await mkdir(path.dirname(path.join(L.docs, file)), { recursive: true });
    await cp(path.join(repoRoot, file), path.join(L.docs, file));
  }
  const texts = await Promise.all(files.map(async (file) => ({ file, text: await readFile(path.join(L.docs, file), 'utf8') })));
  return { files, bareReduxMentions: mentions(texts, 'bare-redux') };
}

/** On a clone: TASK.md's install commands install each tarball once from vendor/, and the grader fails the untouched app on every check but the fifth. */
async function checkTemplate() {
  step("check: TASK.md's install commands, on a clone");
  await rm(L.templateCheck, { recursive: true, force: true });
  await clone(L.template, L.templateCheck);
  const dir = L.templateCheck;
  for (const command of installCommands(RELEASE_VERSION)) await must('npm', [...command.split(' ').slice(1), ...INSTALL_FLAGS], { cwd: dir, env, timeoutMs: 15 * 60_000 });
  const install = installProblems(await readJson(path.join(dir, 'package-lock.json')), RELEASE_VERSION);
  if (install.length > 0) throw new Error(`Installing the vendored tarballs as TASK.md says went wrong:\n  ${install.join('\n  ')}`);
  await must(path.join(dir, 'node_modules', '.bin', 'ironbird'), ['--help'], { cwd: dir, env });
  step('check: the grader on the un-integrated app');
  await rm(L.templateGrade, { recursive: true, force: true });
  const graded = await gradeProject({ project: dir, acceptance: ACCEPTANCE, out: L.templateGrade, env });
  const seen = Object.fromEntries(graded.checks.map((check) => [check.id, check.pass]));
  const expected = { serve: false, commands: false, acceptance: false, bridgeDevOnly: false, releaseBundleClean: true };
  if (JSON.stringify(seen) !== JSON.stringify(expected)) throw new Error(`The grader judged the un-integrated app ${JSON.stringify(seen)}, not ${JSON.stringify(expected)}:\n${JSON.stringify(graded.checks, null, 2)}`);
  return { install: 'passed', graderOnTemplate: graded.checks };
}

async function recordBaseline() {
  step('baseline: one claude start in an empty folder, in the sandbox');
  await rm(L.baselineDir, { recursive: true, force: true });
  await mkdir(L.baselineDir, { recursive: true });
  await mkdir(L.logs, { recursive: true });
  const profile = sandboxProfile({ denied: [await realpath(repoRoot), await realpath(evalHome())], allowed: [await realpath(L.baselineDir)] });
  const init = await captureBaselineInit({ cwd: L.baselineDir, env, transcriptFile: path.join(L.logs, 'baseline.jsonl'), stderrFile: path.join(L.logs, 'baseline-stderr.log'), profile });
  const baseline = baselineFromInit(init, await claudeVersion());
  const problems = checkBaseline(baseline, MODEL_PATTERN);
  if (problems.length > 0) throw new Error(`The baseline is unusable:\n  ${problems.join('\n  ')}`);
  await writeJson(L.baselineFile, baseline);
  return baseline;
}

async function main() {
  await preflight();
  if (!options['skip-build']) {
    step('pnpm build');
    await must('pnpm', ['build'], { cwd: repoRoot, timeoutMs: 10 * 60_000 });
  }
  const head = (await must('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  const { dirty, fingerprint } = await sourcesState(repoRoot, PROXY_SOURCES);
  const exercise = await copyExercise();
  const tarballs = await vendorTarballs();
  await installAndCommit();
  const docs = await copyDocs();
  const check = await checkTemplate();
  const baseline = options['skip-baseline'] ? null : await recordBaseline();
  await writeJson(L.prepareFile, { preparedAt: new Date().toISOString(), repo: { head, dirty, fingerprint }, releaseVersion: RELEASE_VERSION, exercise, tarballs, docs, check, baseline });
  process.stdout.write(`${JSON.stringify({ template: L.template, docs: docs.files.length, bareReduxMentions: docs.bareReduxMentions.length, tarballs: Object.keys(tarballs), baseline: baseline?.claudeVersion ?? 'skipped' })}\n`);
}

main().catch((error) => {
  process.stderr.write(`prepare failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
