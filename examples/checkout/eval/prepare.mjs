#!/usr/bin/env node
// Builds the eval's session template at ~/.ironbird-eval/template/ (M3 design §7.1), checks it, and
// records the bundled-skills baseline for the D9 isolation check.
//
//   node examples/checkout/eval/prepare.mjs [--skip-build] [--skip-baseline]
//
// --skip-build reuses the packages' current dist/. --skip-baseline skips the one short claude
// start that records the baseline; run-session refuses to start without a baseline.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { claudeVersion, captureBaselineInit } from './lib/claude.mjs';
import { sessionEnv } from './lib/claude-args.mjs';
import { sandboxProfile } from './lib/sandbox.mjs';
import { copyExample, findHints, transformFixture } from './lib/fixture.mjs';
import { cleanPass, conditionFailure, mismatches, summarizeRun } from './lib/grading.mjs';
import { ironbird, runScenarioFile, startServe } from './lib/ironbird.mjs';
import { baselineFromInit, checkBaseline } from './lib/isolation.mjs';
import { FIXTURE_PINS, GITIGNORE, NPM_INSTALL_FLAGS, pickTarballs, standaloneManifest, standaloneTsconfig, VITEST_CONFIG } from './lib/manifest.mjs';
import { DUPLICATE_SCENARIO, exampleDir, HELD_BACK, layout, MODEL, RACE_SCENARIO, repoRoot } from './lib/paths.mjs';
import { clone, must, readJson, run, writeJson } from './lib/proc.mjs';
import { ancestorInstructionFiles, isInside } from './lib/tree.mjs';

const { values: options } = parseArgs({ options: { 'skip-build': { type: 'boolean' }, 'skip-baseline': { type: 'boolean' } } });
const L = layout();

function step(message) {
  process.stderr.write(`prepare: ${message}\n`);
}

async function preflight() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error(`Node ${process.versions.node}; the harness needs Node 22 or later`);
  if (isInside(L.home, repoRoot)) throw new Error(`The eval home ${L.home} is inside the repository; sessions must run outside it`);
  const instructions = await ancestorInstructionFiles(L.home);
  if (instructions.length > 0) throw new Error(`Instruction files above the eval home would load into every session: ${instructions.join(', ')}`);
}

async function buildTemplate() {
  if (!options['skip-build']) {
    step('pnpm build');
    await must('pnpm', ['build'], { cwd: repoRoot, timeoutMs: 10 * 60_000 });
  }
  step(`copying examples/checkout to ${L.template}`);
  await rm(L.template, { recursive: true, force: true });
  await mkdir(L.home, { recursive: true });
  await copyExample(exampleDir, L.template);
  await transformFixture(L.template);

  step('packing @ironbird/core, @ironbird/react-native, @ironbird/cli');
  const vendor = path.join(L.template, 'vendor');
  await mkdir(vendor);
  for (const name of ['core', 'react-native', 'cli']) await must('pnpm', ['pack', '--pack-destination', vendor], { cwd: path.join(repoRoot, 'packages', name) });
  const tarballs = pickTarballs(await readdir(vendor));

  const root = await readJson(path.join(repoRoot, 'package.json'));
  const versions = { vitest: root.devDependencies.vitest, typescript: root.devDependencies.typescript, typesNode: root.devDependencies['@types/node'] };
  await writeJson(path.join(L.template, 'package.json'), standaloneManifest(await readJson(path.join(exampleDir, 'package.json')), { tarballs, versions, pins: FIXTURE_PINS }));
  await writeJson(path.join(L.template, 'tsconfig.json'), standaloneTsconfig(await readJson(path.join(exampleDir, 'tsconfig.json')), await readJson(path.join(repoRoot, 'tsconfig.base.json'))));
  await writeFile(path.join(L.template, 'vitest.config.ts'), VITEST_CONFIG);
  await writeFile(path.join(L.template, '.gitignore'), GITIGNORE);

  step('npm install');
  await must('npm', ['install', ...NPM_INSTALL_FLAGS], { cwd: L.template, timeoutMs: 15 * 60_000 });
  await checkInstall(tarballs);
  step('ironbird agent setup');
  await must('npx', ['ironbird', 'agent', 'setup'], { cwd: L.template });

  step('git init');
  const git = (...args) => must('git', ['-c', 'user.name=Checkout', '-c', 'user.email=checkout@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: L.template });
  await git('init', '-q', '-b', 'main');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'Checkout app');

  const hashes = {};
  for (const file of Object.values(tarballs)) hashes[file] = createHash('sha256').update(await readFile(path.join(vendor, file))).digest('hex');
  return { tarballs: hashes, versions, pins: FIXTURE_PINS, npmInstallFlags: NPM_INSTALL_FLAGS };
}

/** The packed packages, not a registry copy, are what got installed, once each, and the CLI has this milestone's commands. */
async function checkInstall(tarballs) {
  const modules = path.join(L.template, 'node_modules', '@ironbird');
  const lock = await readJson(path.join(L.template, 'package-lock.json'));
  for (const [key, name] of [['core', 'core'], ['reactNative', 'react-native'], ['cli', 'cli']]) {
    const entry = lock.packages?.[`node_modules/@ironbird/${name}`];
    if (!String(entry?.resolved ?? '').includes(tarballs[key])) throw new Error(`@ironbird/${name} was not installed from vendor/${tarballs[key]} (resolved: ${entry?.resolved})`);
  }
  const nested = Object.keys(lock.packages ?? {}).filter((key) => /node_modules\/@ironbird\/[^/]+\/node_modules\/@ironbird\//.test(key));
  if (nested.length > 0) throw new Error(`Nested ironbird packages were installed: ${nested.join(', ')}`);
  const help = await run(path.join(L.template, 'node_modules', '.bin', 'ironbird'), ['--help'], { cwd: L.template });
  for (const command of ['reload', 'mcp', 'agent']) {
    if (!new RegExp(`^\\s+${command}\\b`, 'm').test(help.stdout)) throw new Error(`The packed CLI lists no \`${command}\` command; build the packages from this branch`);
  }
  await readFile(path.join(modules, 'cli', 'skills', 'ironbird', 'SKILL.md'));
}

/**
 * The leak audit (D7): every text surface a session can see, after install and pack. The fixture
 * itself with its installed skill (`.claude/`) and lockfile, the installed ironbird packages, and
 * the contents of each vendored tarball, extracted. Any hit that no HINT_ALLOWED entry explains
 * fails prepare, which runs again whenever the skill changes.
 */
async function auditHints() {
  const hits = [...(await findHints(L.template)), ...(await findHints(path.join(L.template, 'node_modules', '@ironbird'), { prefix: 'node_modules/@ironbird/', skip: new Set(['node_modules']) }))];
  const vendorFiles = {};
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-vendor-'));
  try {
    for (const tarball of (await readdir(path.join(L.template, 'vendor'))).filter((file) => file.endsWith('.tgz'))) {
      const source = path.join(L.template, 'vendor', tarball);
      vendorFiles[tarball] = (await must('tar', ['-tzf', source])).stdout.trim().split('\n');
      const into = path.join(scratch, tarball);
      await mkdir(into);
      await must('tar', ['-xzf', source, '-C', into]);
      hits.push(...(await findHints(into, { prefix: `vendor/${tarball}/`, skip: new Set() })));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (hits.length > 0) {
    throw new Error(`Session-visible text names the race or its ordering (add a HINT_ALLOWED entry with a reason only if the hit gives nothing away):\n${hits.map((hit) => `  ${hit.file}:${hit.line} [${hit.term}] ${hit.excerpt}`).join('\n')}`);
  }
  return { hits: [], vendorFiles };
}

/** Spec §7.1's checks, on a clone so the template stays exactly as committed. */
async function checkTemplate() {
  const checks = {};
  step('check: leak audit of every session-visible surface');
  checks.leakAudit = await auditHints();

  await rm(L.templateCheck, { recursive: true, force: true });
  await clone(L.template, L.templateCheck);
  const dir = L.templateCheck;
  try {
    step('check: npm test');
    const tests = await run('npm', ['test'], { cwd: dir, timeoutMs: 10 * 60_000 });
    if (tests.code !== 0) throw new Error(`npm test failed in the fixture:\n${tests.stdout.slice(-3_000)}`);
    checks.npmTest = 'passed';

    step('check: ironbird serve, status, scenarios');
    const serve = await startServe(dir, { logFile: path.join(L.logs, 'prepare-serve.log'), ephemeral: true });
    try {
      const status = await ironbird(dir, ['status']);
      if (!status.lines[0]?.targets?.some((target) => target.id === 'headless')) throw new Error(`ironbird status lists no headless target: ${status.stdout}`);
      const remaining = await ironbird(dir, ['scenario', 'run', 'ironbird/scenarios', '--target', 'headless']);
      const results = remaining.lines.filter((line) => typeof line.passed === 'boolean');
      if (remaining.code !== 0 || results.length !== 3 || results.some((result) => !result.passed)) throw new Error(`The fixture's scenarios do not all pass:\n${remaining.stdout}`);
      checks.remainingScenarios = results.map((result) => result.scenario);
      const race = await runScenarioFile(dir, RACE_SCENARIO, 'headless');
      // The same rule the grader applies to an agent's reproducing scenario (conditionFailure).
      if (!conditionFailure(summarizeRun(race))) throw new Error(`The held-back race scenario does not fail with the bug state on the fixture: ${JSON.stringify(race.result ?? race.error)}`);
      checks.raceFailsHeadless = { failedStep: race.result.failedStep, order: race.state.order };
      const duplicate = await runScenarioFile(dir, DUPLICATE_SCENARIO, 'headless');
      // The duplicate scenario passes on the fixture: a clean pass with the final values its `expect` steps assert.
      const duplicateRun = summarizeRun(duplicate);
      const duplicateExpected = HELD_BACK.find((entry) => entry.file === DUPLICATE_SCENARIO).expected;
      if (!cleanPass(duplicateRun) || mismatches(duplicateRun, duplicateExpected).length > 0) {
        throw new Error(`The held-back duplicate scenario does not pass cleanly on the fixture: ${JSON.stringify(duplicate.result ?? duplicate.error)} ${mismatches(duplicateRun, duplicateExpected).join(', ')}`);
      }
      checks.duplicateOnFixture = true;
    } finally {
      await serve.stop();
    }

    step('check: expo export --platform ios');
    const out = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-export-'));
    try {
      await must('npx', ['expo', 'export', '--platform', 'ios', '--output-dir', out], { cwd: dir, timeoutMs: 10 * 60_000 });
      checks.expoExport = 'bundled';
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  } finally {
    await rm(L.templateCheck, { recursive: true, force: true });
  }
  return checks;
}

async function recordBaseline() {
  step('baseline: one claude start in an empty folder, stopped at its init event');
  await rm(L.baselineDir, { recursive: true, force: true });
  await mkdir(L.baselineDir, { recursive: true });
  const version = await claudeVersion();
  const home = await realpath(L.home);
  const profile = sandboxProfile({ denied: [await realpath(repoRoot), home], allowed: [path.join(home, path.relative(L.home, L.baselineDir))] });
  const init = await captureBaselineInit({
    cwd: L.baselineDir,
    profile,
    env: sessionEnv(process.env, { udid: process.env.IRONBIRD_SIM_UDID ?? '' }),
    transcriptFile: path.join(L.home, 'baseline-transcript.jsonl'),
    stderrFile: path.join(L.home, 'baseline-stderr.log'),
  });
  const baseline = baselineFromInit(init, version);
  const problems = checkBaseline(baseline, MODEL);
  if (problems.length > 0) throw new Error(`The baseline is unusable:\n  ${problems.join('\n  ')}`);
  await writeJson(L.baselineFile, baseline);
  return baseline;
}

async function main() {
  await preflight();
  const head = (await must('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  const dirty = (await run('git', ['status', '--porcelain'], { cwd: repoRoot })).stdout.trimEnd().split('\n').filter(Boolean);
  const built = await buildTemplate();
  const checks = await checkTemplate();
  const baseline = options['skip-baseline'] ? null : await recordBaseline();
  const record = { preparedAt: new Date().toISOString(), repo: { head, dirty }, node: process.versions.node, ...built, checks, baseline: baseline ? { claudeVersion: baseline.claudeVersion, skills: baseline.skills } : null };
  await writeJson(L.prepareFile, record);
  process.stdout.write(`${JSON.stringify({ template: L.template, preparedAt: record.preparedAt, tarballs: Object.keys(built.tarballs), checks: Object.keys(checks), baseline: record.baseline })}\n`);
}

main().catch((error) => {
  process.stderr.write(`prepare failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
