#!/usr/bin/env node
// Grades one session on the four checks of M3 design §7.3 and writes grade.json, the final report,
// and the claims worksheet to ~/.ironbird-eval/grades/<id>/.
//
//   IRONBIRD_SIM_UDID=<iPhone 17 udid> node examples/checkout/eval/grade.mjs <id> [--skip-ios]
//
// The grader works on copies of the session's project and of the template and writes its own runs
// under those copies' .ironbird/, never to the session's agent-runs/. --skip-ios leaves the
// grader's iOS check not run (and so failed): for harness self-tests without a simulator.
import { readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { claimCandidates, claimsTable } from './lib/claims.mjs';
import { sessionEnv } from './lib/claude-args.mjs';
import { chooseReproducing, decide, evaluateAgentRuns, fixedCheck, freshIosTarget, iosVerdict, reproduces, summarizeRun } from './lib/grading.mjs';
import { assertBooted, ironbird, openExpoGo, readState, runScenarioFile, startMetro, startServe, terminateExpoGo, waitForIos } from './lib/ironbird.mjs';
import { BRIDGE_PORT, DAEMON_PORT, gradeLayout, HELD_BACK, layout, METRO_PORT, sessionId, sessionLayout, simUdid } from './lib/paths.mjs';
import { assertPortsFree, clone, readJson, reapPorts, run, stopGroups, writeJson } from './lib/proc.mjs';
import { addedScenarios, scenarioFiles } from './lib/tree.mjs';
import { deniedCalls, finalReport, lastEdit, outOfFolderPaths, parseTranscript, untrackedWrites } from './lib/transcript.mjs';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { 'skip-ios': { type: 'boolean' } } });
const id = sessionId(positionals[0]);
const L = layout();
const S = sessionLayout(L.home, id);
const G = gradeLayout(L.home, id);

function step(message) {
  process.stderr.write(`grade ${id}: ${message}\n`);
}

const errorText = (error) => (error instanceof Error ? error.message : String(error));

/** What teardown left behind, recorded in grade.json; anything here makes the grader exit non-zero. */
const teardown = { stopped: [], errors: [], aliveGroups: [] };

/** Stops the groups with `stopGroups` and records the outcome in `teardown`. */
async function stopAll(groups) {
  const result = await stopGroups(groups);
  teardown.stopped.push(...result.stopped);
  teardown.errors.push(...result.errors);
  teardown.aliveGroups.push(...result.aliveGroups);
}

/** The agent's run folders: each one's result.json, the bytes of its scenario copy, and its screenshots. */
async function loadAgentRuns(dir) {
  const runs = [];
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    const files = await readdir(path.join(dir, name)).catch(() => []);
    const result = await readJson(path.join(dir, name, 'result.json')).catch(() => undefined);
    const copy = files.find((file) => /\.ya?ml$/i.test(file));
    const scenarioBytes = copy === undefined ? undefined : await readFile(path.join(dir, name, copy));
    runs.push({ name, result, scenarioBytes, pngs: files.filter((file) => file.endsWith('.png')) });
  }
  return runs;
}

/** Headless runs: each candidate against the template, then candidates, held-back, and fixture scenarios against the session. */
async function headlessRuns(candidates, templateScenarios, env) {
  const serveTemplate = await startServe(G.template, { env, logFile: path.join(G.logs, 'serve-template.log'), ephemeral: true });
  try {
    for (const candidate of candidates) candidate.template = summarizeRun(await runScenarioFile(G.template, path.join(G.session, candidate.file), 'headless', { env }));
  } finally {
    await stopAll([{ name: 'daemon (template)', proc: serveTemplate }]);
  }
  const serveSession = await startServe(G.session, { env, logFile: path.join(G.logs, 'serve-session.log'), ephemeral: true });
  try {
    for (const candidate of candidates) candidate.session = summarizeRun(await runScenarioFile(G.session, path.join(G.session, candidate.file), 'headless', { env }));
    const heldBack = [];
    for (const { file, expected } of HELD_BACK) heldBack.push({ ...summarizeRun(await runScenarioFile(G.session, file, 'headless', { env })), file: path.basename(file), expected });
    const remaining = [];
    for (const file of templateScenarios) remaining.push({ ...summarizeRun(await runScenarioFile(G.session, path.join(G.template, file), 'headless', { env })), file });
    return { heldBack, remaining };
  } finally {
    await stopAll([{ name: 'daemon (session)', proc: serveSession }]);
  }
}

/**
 * Check 3: a fresh app on the session's code, then the grader's own `ironbird reload`, a fresh
 * connection of the target the reload returned, after it and in the initial state, and the
 * reproducing scenario run on that target. Any setup error fails the check rather than the grade;
 * every group it started is stopped and the ports are reaped either way.
 */
async function iosCheck(repro, env) {
  const ports = [DAEMON_PORT, BRIDGE_PORT, METRO_PORT];
  const started = [];
  try {
    const udid = simUdid();
    await assertPortsFree(ports);
    await assertBooted(udid);
    await terminateExpoGo(udid);
    const serve = await startServe(G.session, { env, logFile: path.join(G.logs, 'serve-ios.log') });
    started.push({ name: 'daemon (ios)', proc: serve });
    const metro = await startMetro(G.session, { env, logFile: path.join(G.logs, 'metro.log') });
    started.push({ name: 'metro', proc: metro });
    await openExpoGo(udid);
    const first = await waitForIos(G.session, { after: serve.launchedAt, env });
    const reloadStartedAt = Date.now();
    const reload = await ironbird(G.session, ['reload', '--target', first.id, '--timeout', '90s'], { env, timeoutMs: 120_000 });
    const returned = reload.code === 0 ? reload.lines[0]?.target : undefined;
    const reloadTarget = typeof returned === 'string' && returned !== '' ? returned : undefined;
    const freshTarget = reloadTarget ? await waitForIos(G.session, { after: reloadStartedAt, id: reloadTarget, env, timeoutMs: 90_000 }).catch(() => undefined) : undefined;
    const initialState = freshTarget ? await readState(G.session, reloadTarget, { env }) : undefined;
    const scenarioRun = freshTarget ? summarizeRun(await runScenarioFile(G.session, path.join(G.session, repro.file), reloadTarget, { env })) : undefined;
    const verdict = iosVerdict({ reloadTarget, freshTarget: freshIosTarget(freshTarget ? [freshTarget] : [], reloadStartedAt, reloadTarget), initialState, run: scenarioRun });
    return {
      ...verdict,
      scenario: repro.file,
      firstConnectedAt: first.connectedAt,
      reload: reload.lines[0] ?? { exitCode: reload.code, stderr: reload.stderr.slice(-500) },
      reloadTarget: reloadTarget ?? null,
      reloadedConnectedAt: freshTarget?.connectedAt ?? null,
      initialOrder: initialState?.order ?? null,
      run: scenarioRun ?? null,
    };
  } catch (error) {
    step(`iOS check failed: ${errorText(error)}`);
    return { pass: false, error: errorText(error), scenario: repro.file };
  } finally {
    await stopAll([...started].reverse());
    if (started.length > 0) {
      try {
        await reapPorts(ports, started.map(({ proc }) => proc.pgid));
      } catch (error) {
        teardown.errors.push(`ports: ${errorText(error)}`);
      }
    }
  }
}

async function main() {
  const session = await readJson(S.record);
  // The udid is looked up inside the iOS check, so a missing IRONBIRD_SIM_UDID fails that check, not the grade.
  const env = sessionEnv(process.env, { udid: process.env.IRONBIRD_SIM_UDID ?? '' });

  step(`copying the session and the template into ${G.dir}`);
  await rm(G.dir, { recursive: true, force: true });
  await clone(S.project, G.session);
  await clone(L.template, G.template);
  for (const dir of [G.session, G.template]) for (const cache of ['.ironbird', '.expo']) await rm(path.join(dir, cache), { recursive: true, force: true });

  const parsed = parseTranscript(await readFile(S.transcript, 'utf8').catch(() => ''));
  const roots = [S.project, await realpath(S.project)];
  const templateScenarios = await scenarioFiles(L.template);
  const candidates = addedScenarios(await scenarioFiles(S.project), templateScenarios).map((file) => ({ file }));
  step(`${candidates.length} added scenario file(s): ${candidates.map((candidate) => candidate.file).join(', ') || 'none'}`);

  step('headless runs');
  const { heldBack, remaining } = await headlessRuns(candidates, templateScenarios, env);
  step('npm test');
  const npmTest = await run('npm', ['test'], { cwd: G.session, env, timeoutMs: 10 * 60_000 });

  const edit = lastEdit(parsed.calls, roots);
  const agentRuns = await loadAgentRuns(S.agentRuns);
  for (const candidate of candidates) {
    candidate.qualifies = reproduces(candidate.template, candidate.session);
    if (candidate.qualifies) {
      const scenarioFile = path.join(S.project, candidate.file);
      candidate.agentEvidence = evaluateAgentRuns({ runs: agentRuns, scenarioBytes: await readFile(scenarioFile), scenarioFile, calls: parsed.calls, lastEditIndex: edit.index, roots });
    }
  }
  const repro = chooseReproducing(candidates);

  const checks = {};
  checks.reproduced = { pass: repro !== undefined, scenario: repro?.file ?? null, candidates };
  checks.fixed = { ...fixedCheck({ heldBack, remaining, npmTestExit: npmTest.code }), heldBack, remaining, npmTest: { exitCode: npmTest.code, tail: npmTest.stdout.slice(-1_500) } };
  checks.verifiedByAgent = repro
    ? { pass: repro.agentEvidence.headless.pass && repro.agentEvidence.ios.pass, scenario: repro.file, lastEdit: edit, ...repro.agentEvidence }
    : { pass: false, reason: 'no reproducing scenario', lastEdit: edit };
  if (options['skip-ios']) checks.iosByGrader = { pass: false, skipped: true };
  else if (!repro) checks.iosByGrader = { pass: false, reason: 'no reproducing scenario' };
  else {
    step(`iOS check with ${repro.file}`);
    checks.iosByGrader = await iosCheck(repro, env);
  }

  const report = finalReport(parsed);
  const success = decide(checks);
  const grade = {
    session: id,
    label: session.label,
    sessionValid: session.valid,
    gradedAt: new Date().toISOString(),
    success,
    checks,
    deniedToolCalls: deniedCalls(parsed),
    outOfFolderPaths: outOfFolderPaths(parsed.calls, roots, os.homedir()),
    untrackedWrites: untrackedWrites(parsed.calls).map((call) => ({ index: call.index, command: call.input.command })),
    costUsd: parsed.result?.total_cost_usd ?? null,
    durationMs: parsed.result?.duration_ms ?? null,
    numTurns: parsed.result?.num_turns ?? null,
    resultSubtype: parsed.result?.subtype ?? null,
    timedOut: session.timedOut ?? false,
    teardown,
    transcript: S.transcript,
    finalReport: G.report,
  };
  await writeFile(G.report, `${report}\n`);
  await writeFile(G.claims, claimsTable(id, claimCandidates(report), success));
  await writeJson(G.grade, grade);
  const teardownFailed = teardown.errors.length > 0 || teardown.aliveGroups.length > 0;
  if (teardownFailed) {
    step(`teardown failed: ${[...teardown.errors, ...teardown.aliveGroups.map((group) => `${group.name} (pgid ${group.pgid}) is still alive`)].join('; ')}`);
    process.exitCode = 1;
  }
  process.stdout.write(
    `${JSON.stringify({ session: id, valid: session.valid, success, checks: Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, check.pass])), costUsd: grade.costUsd, deniedToolCalls: grade.deniedToolCalls, outOfFolderPaths: grade.outOfFolderPaths.length })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`grade failed: ${errorText(error)}\n`);
  process.exitCode = 1;
});
