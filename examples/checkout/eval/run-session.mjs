#!/usr/bin/env node
// Runs one eval session end to end (M3 design §7.2).
//
//   IRONBIRD_SIM_UDID=<iPhone 17 udid> node examples/checkout/eval/run-session.mjs <id> [--label gate|pilot|smoke] [--prompt <file>] [--max-budget-usd <n>] [--probe-sandbox] [--print-args]
//
// <id> names the session folder, ~/.ironbird-eval/sessions/<id>/, and must be new. --print-args
// prints the claude command line, the settings, the sandbox profile, and the prompt, and starts
// nothing. --probe-sandbox (smoke only) drops the deny rules and allows Bash `head` and Read on the
// repository and the eval home, so the smoke prompt's probes meet only the sandbox.
import { cp, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { claudeVersion, startClaude } from './lib/claude.mjs';
import { claudeArgs, fillPaths, probeAllow, renderSettings, sessionEnv } from './lib/claude-args.mjs';
import { isInitialState } from './lib/grading.mjs';
import { assertBooted, openExpoGo, readState, startMetro, startServe, terminateExpoGo, waitForIos } from './lib/ironbird.mjs';
import { checkIsolation, userSkillNames } from './lib/isolation.mjs';
import { BRIDGE_PORT, BUDGET_USD, DAEMON_PORT, DEVICE_TIMEOUT_MS, evalDir, layout, METRO_PORT, MODEL, MODEL_PATTERN, repoRoot, SESSION_LIMIT_MS, sessionId, sessionLayout, simUdid, TEARDOWN_RESERVE_MS } from './lib/paths.mjs';
import { deadlineBudget } from './lib/probes.mjs';
import { assertPortsFree, clone, must, readJson, reapPorts, run, writeJson } from './lib/proc.mjs';
import { sandboxProfile } from './lib/sandbox.mjs';
import { deniedCalls, outOfFolderPaths, parseTranscript, untrackedWrites } from './lib/transcript.mjs';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: 'string', default: 'gate' },
    prompt: { type: 'string' },
    'max-budget-usd': { type: 'string' },
    'probe-sandbox': { type: 'boolean' },
    'print-args': { type: 'boolean' },
  },
});
const id = positionals[0];
const L = layout();
const budgetUsd = Number(options['max-budget-usd'] ?? BUDGET_USD);
const exists = (file) => stat(file).then(() => true, () => false);
const PORTS = [DAEMON_PORT, BRIDGE_PORT, METRO_PORT];
/** The session's folders; set first thing in main(), once the id is known to be valid. */
let S;

function step(message) {
  process.stderr.write(`run-session ${id}: ${message}\n`);
}

/** The folders a session must not read besides the repository and the template: other sessions, the grades, the template check, the baseline. */
async function otherFolders() {
  const sessions = (await readdir(L.sessions).catch(() => [])).filter((name) => name !== id).map((name) => path.join(L.sessions, name));
  return [...sessions, L.grades, L.templateCheck, L.baselineDir];
}

async function settingsFor() {
  if (options['probe-sandbox']) return { permissions: { deny: [] } };
  const template = await readJson(path.join(evalDir, 'session-settings.json'));
  return renderSettings(template, { repo: repoRoot, fixture: L.template, alsoDeny: await otherFolders() });
}

/** The sandbox profile for this session: deny the repository and the eval home, allow the session's project folder. Paths are resolved, as the sandbox sees them. */
async function profileFor() {
  const repo = await resolvedPath(repoRoot);
  const home = await resolvedPath(L.home);
  return sandboxProfile({ denied: [repo, home], allowed: [path.join(home, path.relative(L.home, S.project))] });
}

/** A path with its symlinks resolved, for a path that may not exist yet: the nearest existing ancestor is resolved and the rest appended. */
async function resolvedPath(dir) {
  const absolute = path.resolve(dir);
  const real = await realpath(absolute).catch(() => undefined);
  if (real) return real;
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(await resolvedPath(parent), path.basename(absolute));
}

/** The repository commit, and whether the harness or the skill differ from it: gate sessions need both frozen. */
async function harnessRevision() {
  const head = (await must('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  const dirty = (await run('git', ['status', '--porcelain', '--', 'examples/checkout/eval', 'packages/cli/skills'], { cwd: repoRoot })).stdout.trimEnd().split('\n').filter(Boolean);
  return { head, dirty };
}

async function runAgent({ args, env, prompt, profile, userSkills, record, deadline }) {
  let isolation;
  let checking;
  let timedOut = false;
  const session = startClaude({
    cwd: S.project,
    args,
    env,
    prompt,
    profile,
    transcriptFile: S.transcript,
    stderrFile: S.stderr,
    onEvent: (event) => {
      if (checking || event.type !== 'system' || event.subtype !== 'init') return;
      record.resolvedModel = event.model ?? null;
      checking = (async () => {
        const memory = typeof event.memory_paths?.auto === 'string' ? await readdir(event.memory_paths.auto).catch(() => []) : [];
        isolation = checkIsolation(event, { memoryEntries: memory, model: MODEL_PATTERN, userSkills });
        if (!isolation.valid) {
          step(`isolation check failed, stopping: ${isolation.problems.join('; ')}`);
          await session.stop(2_000);
        }
      })();
    },
  });
  record.claudeGroup = session.pgid;
  const stopOnSignal = () => {
    record.invalidReasons.push('interrupted by the operator');
    void session.stop(2_000);
  };
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
  const limit = setTimeout(
    () => {
      timedOut = true;
      step('session deadline reached, stopping claude');
      void session.stop();
    },
    Math.max(0, deadline - TEARDOWN_RESERVE_MS - Date.now()),
  );
  const exit = await session.done;
  clearTimeout(limit);
  process.off('SIGINT', stopOnSignal);
  process.off('SIGTERM', stopOnSignal);
  await session.stop(2_000);
  await checking;
  isolation ??= checkIsolation(undefined, { memoryEntries: [], model: MODEL_PATTERN, userSkills });
  if (!isolation.valid) record.invalidReasons.push(...isolation.problems.map((problem) => `isolation: ${problem}`));
  return { exit, timedOut, isolation };
}

async function main() {
  S = sessionLayout(L.home, sessionId(id));
  if (!['gate', 'pilot', 'smoke'].includes(options.label)) throw new Error(`--label must be gate, pilot, or smoke, not ${options.label}`);
  if (options['probe-sandbox'] && options.label !== 'smoke') throw new Error('--probe-sandbox is only for --label smoke');
  if (!(budgetUsd > 0)) throw new Error(`--max-budget-usd must be a positive number, not ${options['max-budget-usd']}`);
  const promptFile = options.prompt ? path.resolve(options.prompt) : path.join(evalDir, 'prompt.md');
  const prompt = fillPaths((await readFile(promptFile, 'utf8')).trim(), { repo: repoRoot, fixture: L.template });
  const settings = await settingsFor();
  const extraAllow = options['probe-sandbox'] ? probeAllow({ repo: repoRoot, home: L.home }) : [];
  const args = claudeArgs({ projectDir: S.project, settings, budgetUsd, model: MODEL, extraAllow });
  const profile = await profileFor();
  if (options['print-args']) {
    process.stdout.write(`${JSON.stringify({ cwd: S.project, command: 'sandbox-exec -p <profile> claude', args, settings, profile, prompt, stdin: 'prompt' }, null, 2)}\n`);
    return;
  }

  const udid = simUdid();
  if (await exists(S.dir)) throw new Error(`${S.dir} exists; every session needs a new id`);
  if (!(await exists(path.join(L.template, 'package.json')))) throw new Error('No template; run prepare.mjs first');
  const baseline = await readJson(L.baselineFile).catch(() => {
    throw new Error('No baseline.json; run prepare.mjs without --skip-baseline first');
  });
  const version = await claudeVersion();
  if (version !== baseline.claudeVersion) throw new Error(`claude is ${version} but the baseline was recorded with ${baseline.claudeVersion}; run prepare.mjs again`);
  const harness = await harnessRevision();
  if (options.label === 'gate' && harness.dirty.length > 0) throw new Error(`Gate sessions need the harness and the skill committed: ${harness.dirty.join(', ')}`);
  // The user's own skills, read now: a session skill with one of these names leaked from the user's setup.
  const userSkills = await userSkillNames();
  await assertPortsFree(PORTS);
  await assertBooted(udid);

  // The absolute deadline covers everything from here: startup, claude, copying, and teardown.
  const startedAt = Date.now();
  const deadline = startedAt + SESSION_LIMIT_MS;
  const left = (wantedMs) => deadlineBudget(deadline - TEARDOWN_RESERVE_MS, Date.now(), wantedMs);

  step(`cloning the template into ${S.project}`);
  await mkdir(S.logs, { recursive: true });
  await clone(L.template, S.project);
  await writeJson(S.settings, settings);
  const prepared = await readJson(L.prepareFile).catch(() => null);
  const record = {
    session: id,
    label: options.label,
    startedAt: new Date(startedAt).toISOString(),
    deadline: new Date(deadline).toISOString(),
    harness,
    templatePreparedAt: prepared?.preparedAt ?? null,
    claudeVersion: version,
    model: MODEL,
    resolvedModel: null,
    budgetUsd,
    limitMinutes: SESSION_LIMIT_MS / 60_000,
    udid,
    prompt,
    sandboxProfile: profile,
    probeSandbox: Boolean(options['probe-sandbox']),
    userSkills,
    invalidReasons: [],
  };
  const env = sessionEnv(process.env, { udid });
  let serve;
  let metro;
  try {
    step('fresh device: stopping Expo Go, starting the daemon and Metro, opening the app');
    await terminateExpoGo(udid);
    serve = await startServe(S.project, { env, logFile: path.join(S.logs, 'serve.log'), timeoutMs: left(60_000) });
    metro = await startMetro(S.project, { env, logFile: path.join(S.logs, 'metro.log'), timeoutMs: left(180_000) });
    await openExpoGo(udid);
    try {
      const target = await waitForIos(S.project, { after: serve.launchedAt, env, timeoutMs: left(DEVICE_TIMEOUT_MS) });
      const initial = await readState(S.project, 'ios', { env });
      if (!isInitialState(initial)) throw new Error(`the app did not start with an empty cart and no order: ${JSON.stringify(initial)}`);
      record.device = { target, initialState: initial };
    } catch (error) {
      record.invalidReasons.push(`device: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (record.device) {
      if (left(1) === 0) record.invalidReasons.push('deadline: startup used the whole session');
      else {
        step('starting claude in the sandbox');
        Object.assign(record, await runAgent({ args, env, prompt, profile, userSkills, record, deadline }));
      }
    }
  } catch (error) {
    record.invalidReasons.push(`startup: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    step('copying .ironbird/runs to agent-runs, then stopping Metro and the daemon');
    const runs = path.join(S.project, '.ironbird', 'runs');
    // A failed copy must not skip the teardown below: it makes the session invalid instead.
    try {
      if (await exists(runs)) await cp(runs, S.agentRuns, { recursive: true });
      else await mkdir(S.agentRuns, { recursive: true });
    } catch (error) {
      record.invalidReasons.push(`copy: ${error instanceof Error ? error.message : String(error)}`);
    }
    record.reaped = { metro: (await metro?.stop()) ?? null, serve: (await serve?.stop()) ?? null };
    const owned = [metro?.pgid, serve?.pgid, record.claudeGroup].filter((pgid) => pgid !== undefined);
    try {
      await reapPorts(PORTS, owned, { boundMs: Math.max(5_000, deadline - Date.now()) });
    } catch (error) {
      record.invalidReasons.push(`teardown: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (await exists(S.transcript)) {
      const parsed = parseTranscript(await readFile(S.transcript, 'utf8'));
      const roots = [S.project, await realpath(S.project)];
      record.result = parsed.result
        ? { subtype: parsed.result.subtype, isError: parsed.result.is_error, costUsd: parsed.result.total_cost_usd, durationMs: parsed.result.duration_ms, numTurns: parsed.result.num_turns }
        : null;
      record.deniedToolCalls = deniedCalls(parsed);
      record.outOfFolderPaths = outOfFolderPaths(parsed.calls, roots, os.homedir());
      record.untrackedWrites = untrackedWrites(parsed.calls).map((call) => ({ index: call.index, command: call.input.command }));
      if (record.outOfFolderPaths.length > 0) record.invalidReasons.push(`outside-folder access: ${record.outOfFolderPaths.map((hit) => `${hit.tool} ${hit.path}`).join('; ')}`);
      if (record.untrackedWrites.length > 0) record.invalidReasons.push(`file writes outside the edit tools: ${record.untrackedWrites.map((write) => write.command).join('; ')}`);
    }
    record.finishedAt = new Date().toISOString();
    record.overran = Date.now() > deadline;
    record.valid = record.invalidReasons.length === 0 && record.isolation?.valid === true;
    await writeJson(S.record, record);
    process.stdout.write(
      `${JSON.stringify({ session: id, label: record.label, valid: record.valid, invalidReasons: record.invalidReasons, timedOut: record.timedOut ?? false, overran: record.overran, model: record.resolvedModel, result: record.result ?? null, deniedToolCalls: record.deniedToolCalls ?? null, outOfFolderPaths: record.outOfFolderPaths?.length ?? null })}\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`run-session failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
