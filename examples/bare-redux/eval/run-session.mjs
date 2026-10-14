#!/usr/bin/env node
// Runs one integration-proxy session (M5 design D11): a `claude -p` session on Sonnet, in the M3
// sandbox, that gets integration-exercise/TASK.md and only the published docs, outside the repository.
//
//   node examples/bare-redux/eval/run-session.mjs <id> [--label proxy|smoke] [--prompt <file>] [--max-budget-usd <n>] [--print-args]
//
// <id> names <eval home>/proxy/sessions/<id>/ and must be new. --print-args prints the command line,
// the settings, the sandbox profile, and the prompt, and starts nothing.
import { cp, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { claudeVersion, startClaude } from '../../checkout/eval/lib/claude.mjs';
import { renderSettings } from '../../checkout/eval/lib/claude-args.mjs';
import { checkIsolation, userSkillNames } from '../../checkout/eval/lib/isolation.mjs';
import { assertPortsFree, clone, groupAlive, listenerOwners, must, pgidOf, readJson, reapGroup, run, writeJson } from '../../checkout/eval/lib/proc.mjs';
import { sandboxProfile } from '../../checkout/eval/lib/sandbox.mjs';
import { sessionVerdict } from '../../checkout/eval/lib/session.mjs';
import { deniedCalls, outOfFolderPaths, parseTranscript, untrackedWrites } from '../../checkout/eval/lib/transcript.mjs';
import { fillPrompt, proxyArgs, proxyEnv } from './lib/args.mjs';
import { docsRead } from './lib/docs.mjs';
import { BUDGET_USD, evalDir, evalHome, MODEL, MODEL_PATTERN, PORTS, PROXY_SOURCES, proxyLayout, proxySessionLayout, repoRoot, sessionId, SESSION_LIMIT_MS, TEARDOWN_RESERVE_MS } from './lib/paths.mjs';
import { classifyListeners, outsideProblems, pidsWithCwdUnder } from './lib/session-rules.mjs';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { label: { type: 'string', default: 'proxy' }, prompt: { type: 'string' }, 'max-budget-usd': { type: 'string' }, 'print-args': { type: 'boolean' } },
});
const id = positionals[0];
const L = proxyLayout();
const budgetUsd = Number(options['max-budget-usd'] ?? BUDGET_USD);
const exists = (file) => stat(file).then(() => true, () => false);
const step = (message) => process.stderr.write(`run-session ${id}: ${message}\n`);
const errorText = (error) => (error instanceof Error ? error.message : String(error));

/** A path with its symlinks resolved, for a path that may not exist yet: the nearest existing ancestor is resolved and the rest appended. */
async function resolvedPath(dir) {
  const absolute = path.resolve(dir);
  const real = await realpath(absolute).catch(() => undefined);
  if (real) return real;
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(await resolvedPath(parent), path.basename(absolute));
}

/** Deny rules for the repository, the template, and every other folder that holds answers or other sessions. */
async function settingsFor() {
  const template = await readJson(path.join(evalDir, 'session-settings.json'));
  const sessions = (await readdir(L.sessions).catch(() => [])).filter((name) => name !== id).map((name) => path.join(L.sessions, name));
  return renderSettings(template, { repo: repoRoot, fixture: L.template, alsoDeny: [...sessions, L.grades, L.templateCheck, L.templateGrade, L.baselineDir, L.docs] });
}

/** Repository and eval home denied; the session's project and docs allowed again. */
async function profileFor(S) {
  return sandboxProfile({ denied: [await resolvedPath(repoRoot), await resolvedPath(evalHome())], allowed: [await resolvedPath(S.project), await resolvedPath(S.docs)] });
}

/** Why the prepared template can't be used now: a source changed since it was built, or (for a proxy session) it was built from uncommitted sources. */
async function staleness(label) {
  const prepared = await readJson(L.prepareFile).catch(() => null);
  const head = prepared?.repo?.head;
  if (typeof head !== 'string' || head === '') return ['prepare.json records no commit; run prepare.mjs again'];
  const problems = [];
  const diff = await run('git', ['diff', '--name-only', head, 'HEAD', '--', ...PROXY_SOURCES], { cwd: repoRoot });
  if (diff.code !== 0) problems.push(`cannot compare the prepared commit ${head.slice(0, 7)} with HEAD; run prepare.mjs again`);
  else {
    const changed = diff.stdout.split('\n').filter(Boolean);
    if (changed.length > 0) problems.push(`the template was prepared at ${head.slice(0, 7)} and ${changed.length} file(s) it is built from changed since: ${changed.join(', ')}; run prepare.mjs again`);
  }
  if (label === 'proxy' && (prepared.repo.dirty ?? []).length > 0) problems.push(`the template was prepared with uncommitted changes (${prepared.repo.dirty.join(', ')}); commit them and run prepare.mjs again`);
  return problems;
}

/** Runs claude until it exits, fails the isolation check, is interrupted, or reaches the deadline less the teardown reserve. */
async function runAgent({ S, args, env, prompt, profile, userSkills, record, deadline }) {
  let isolation;
  let checking;
  let timedOut = false;
  let giveUp;
  const gaveUp = new Promise((resolve) => {
    giveUp = resolve;
  });
  const stop = async (graceMs) => {
    await session.stop(graceMs);
    await new Promise((resolve) => setTimeout(resolve, 5_000).unref());
    giveUp({ code: null, signal: null, unresponsive: true });
  };
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
        isolation = checkIsolation(event, { memoryEntries: memory, model: MODEL_PATTERN, userSkills, ironbird: 'absent' });
        if (!isolation.valid) {
          step(`isolation check failed, stopping: ${isolation.problems.join('; ')}`);
          void stop(2_000);
        }
      })();
    },
  });
  record.claudeGroup = session.pgid;
  const stopOnSignal = () => {
    record.invalidReasons.push('interrupted by the operator');
    void stop(2_000);
  };
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
  const limit = setTimeout(
    () => {
      timedOut = true;
      step('session deadline reached, stopping claude');
      void stop(10_000);
    },
    Math.max(0, deadline - TEARDOWN_RESERVE_MS - Date.now()),
  );
  const exit = await Promise.race([session.done, gaveUp]);
  clearTimeout(limit);
  process.off('SIGINT', stopOnSignal);
  process.off('SIGTERM', stopOnSignal);
  const reaped = await session.stop(2_000);
  await checking;
  isolation ??= checkIsolation(undefined, { memoryEntries: [], model: MODEL_PATTERN, userSkills, ironbird: 'absent' });
  return { exit, timedOut, isolation, reaped };
}

/**
 * Stops what the session left behind: every process working inside the project (the agent's daemon,
 * Metro, watchers, which may have left claude's group), then anything still on the ports. Returns the
 * groups still alive; a port held by a process that is not the session's makes the session invalid.
 */
async function teardown(record, roots, deadline) {
  const lsof = await run('lsof', ['-d', 'cwd', '-Fpn'], { timeoutMs: 30_000 });
  const sessionPids = pidsWithCwdUnder(lsof.stdout, roots).filter((pid) => pid !== process.pid);
  const groups = new Set();
  for (const pid of sessionPids) {
    const pgid = await pgidOf(pid).catch(() => undefined);
    if (pgid) groups.add(pgid);
  }
  groups.delete(await pgidOf(process.pid).catch(() => undefined));
  for (const pgid of groups) await reapGroup(pgid, { graceMs: 2_000, killMs: 2_000 });
  const owned = [record.claudeGroup, ...groups].filter((pgid) => pgid !== undefined);
  const until = Date.now() + Math.max(5_000, Math.min(30_000, deadline - Date.now()));
  for (;;) {
    const { ours, unknown } = classifyListeners(await listenerOwners(PORTS), { ownedGroups: owned, sessionPids });
    if (unknown.length > 0) {
      record.invalidReasons.push(`teardown: ${unknown.map((owner) => `port ${owner.port} is held by pid ${owner.pid}, which the session did not start`).join('; ')}`);
      break;
    }
    if (ours.length === 0) break;
    if (Date.now() > until) {
      record.invalidReasons.push(`teardown: ports still held by the session's processes: ${JSON.stringify(ours)}`);
      break;
    }
    for (const pgid of new Set(ours.map((owner) => owner.pgid))) await reapGroup(pgid, { graceMs: 2_000, killMs: 2_000 });
  }
  return owned.filter((pgid) => groupAlive(pgid)).map((pgid) => ({ name: pgid === record.claudeGroup ? 'claude' : 'session process', pgid }));
}

async function main() {
  if (!id) throw new Error('Pass a session id, such as proxy-1');
  const S = proxySessionLayout(L.home, sessionId(id));
  if (!['proxy', 'smoke'].includes(options.label)) throw new Error(`--label must be proxy or smoke, not ${options.label}`);
  if (!(budgetUsd > 0)) throw new Error(`--max-budget-usd must be a positive number, not ${options['max-budget-usd']}`);
  const promptFile = options.prompt ? path.resolve(options.prompt) : path.join(evalDir, 'prompt.md');
  const prompt = fillPrompt((await readFile(promptFile, 'utf8')).trim(), { docs: S.docs, repo: repoRoot });
  const settings = await settingsFor();
  const args = proxyArgs({ projectDir: S.project, docsDir: S.docs, settings, budgetUsd, model: MODEL });
  const profile = await profileFor(S);
  if (options['print-args']) {
    process.stdout.write(`${JSON.stringify({ cwd: S.project, command: 'sandbox-exec -p <profile> claude', args, settings, profile, prompt, stdin: 'prompt' }, null, 2)}\n`);
    return;
  }

  if (await exists(S.dir)) throw new Error(`${S.dir} exists; every session needs a new id`);
  if (!(await exists(path.join(L.template, 'package.json')))) throw new Error('No template; run prepare.mjs first');
  const baseline = await readJson(L.baselineFile).catch(() => {
    throw new Error('No baseline.json; run prepare.mjs without --skip-baseline first');
  });
  const version = await claudeVersion();
  if (version !== baseline.claudeVersion) throw new Error(`claude is ${version} but the baseline was recorded with ${baseline.claudeVersion}; run prepare.mjs again`);
  const stale = await staleness(options.label);
  if (stale.length > 0) throw new Error(`The template can't be used: ${stale.join('; ')}`);
  const head = (await must('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  const userSkills = await userSkillNames();
  await assertPortsFree(PORTS);

  const startedAt = Date.now();
  const deadline = startedAt + SESSION_LIMIT_MS;
  await mkdir(S.logs, { recursive: true });
  const record = {
    session: id,
    label: options.label,
    startedAt: new Date(startedAt).toISOString(),
    deadline: new Date(deadline).toISOString(),
    head,
    claudeVersion: version,
    model: MODEL,
    resolvedModel: null,
    budgetUsd,
    limitMinutes: SESSION_LIMIT_MS / 60_000,
    prompt,
    sandboxProfile: profile,
    userSkills,
    invalidReasons: [],
  };
  const env = proxyEnv(process.env);
  let aliveGroups = [];
  try {
    step(`cloning the template into ${S.project}, copying the docs to ${S.docs}`);
    await clone(L.template, S.project, { timeoutMs: 120_000 });
    await cp(L.docs, S.docs, { recursive: true });
    await must('chmod', ['-R', 'a-w', S.docs]);
    await writeJson(S.settings, settings);
    step('starting claude in the sandbox');
    const agent = await runAgent({ S, args, env, prompt, profile, userSkills, record, deadline });
    record.exit = agent.exit;
    record.timedOut = agent.timedOut;
    record.isolation = agent.isolation;
    record.reapedClaude = agent.reaped;
  } catch (error) {
    record.invalidReasons.push(`startup: ${errorText(error)}`);
  } finally {
    const roots = [S.project, await realpath(S.project).catch(() => S.project)];
    const docsRoots = [S.docs, await realpath(S.docs).catch(() => S.docs)];
    try {
      aliveGroups = await teardown(record, roots, deadline);
    } catch (error) {
      record.invalidReasons.push(`teardown: ${errorText(error)}`);
    }
    if (await exists(S.transcript)) {
      const parsed = parseTranscript(await readFile(S.transcript, 'utf8'));
      record.result = parsed.result
        ? { subtype: parsed.result.subtype, isError: parsed.result.is_error, costUsd: parsed.result.total_cost_usd, durationMs: parsed.result.duration_ms, numTurns: parsed.result.num_turns }
        : null;
      record.deniedToolCalls = deniedCalls(parsed);
      record.outOfFolderPaths = outOfFolderPaths(parsed.calls, [...roots, ...docsRoots], os.homedir());
      const invalidating = outsideProblems(record.outOfFolderPaths);
      if (invalidating.length > 0) record.invalidReasons.push(`outside-folder access: ${invalidating.map((hit) => `${hit.tool} ${hit.path}`).join('; ')}`);
      record.untrackedWrites = untrackedWrites(parsed.calls).map((call) => ({ index: call.index, command: call.input.command }));
      record.docsRead = docsRead(parsed.calls, docsRoots);
    }
    const finishedAt = Date.now();
    const verdict = sessionVerdict({ reasons: record.invalidReasons, isolation: record.isolation, deadline, finishedAt, aliveGroups });
    record.finishedAt = new Date(finishedAt).toISOString();
    record.aliveGroups = aliveGroups;
    record.invalidReasons = verdict.invalidReasons;
    record.valid = verdict.valid;
    await writeJson(S.record, record);
    process.stdout.write(`${JSON.stringify({ session: id, label: record.label, valid: record.valid, invalidReasons: record.invalidReasons, timedOut: record.timedOut ?? false, model: record.resolvedModel, result: record.result ?? null, deniedToolCalls: record.deniedToolCalls ?? null, docsRead: record.docsRead?.read.length ?? null })}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`run-session failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
