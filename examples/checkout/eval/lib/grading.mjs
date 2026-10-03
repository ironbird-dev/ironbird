// The four grading checks' rules (M3 design §7.3), as pure functions over what grade.mjs gathers:
// scenario runs made by the grader, the agent's run folders, and the parsed transcript.
import path from 'node:path';
import { canonicalPath, iosCaptureAfter, reportingCall } from './transcript.mjs';

/** The bug state: a final state with a completed order whose total is 0. */
export function isBugState(state) {
  return state?.order?.status === 'completed' && state?.order?.totalCents === 0;
}

/**
 * The app's state right after a fresh start (`initialState` in src/core/checkout.ts, which the app's
 * snapshot always carries in full): an empty cart with a subtotal of exactly 0, an idle payment with
 * no method, token, payment id, or error, an order with status `none`, no order id, a total of exactly
 * 0 and `paymentSucceeded` false, and a connected reader. Every field must be present with its initial
 * value; nothing is defaulted. `ui` is a user preference and is not compared.
 */
export function isInitialState(state) {
  if (state === null || typeof state !== 'object') return false;
  const { cart, payment, order, reader } = state;
  const cartEmpty = Array.isArray(cart?.items) && cart.items.length === 0 && cart.subtotalCents === 0;
  const paymentIdle = payment?.status === 'idle' && ['method', 'token', 'paymentId', 'error'].every((key) => payment[key] === undefined);
  const noOrder = order?.status === 'none' && order.orderId === undefined && order.totalCents === 0 && order.paymentSucceeded === false;
  return cartEmpty && paymentIdle && noOrder && reader?.connected === true;
}

/** The `ios` target from a `status` listing, only if it connected at or after `after` (ms since the epoch). */
export function freshIosTarget(targets, after) {
  return (Array.isArray(targets) ? targets : []).find((target) => target?.id === 'ios' && target.platform === 'ios' && typeof target.connectedAt === 'number' && target.connectedAt >= after);
}

/**
 * A grader run summarized for grade.json. `run` is what `runScenarioFile` returns:
 * `{ exitCode, result, error, state }`, where `state` is the parsed state.json or undefined.
 */
export function summarizeRun(run) {
  const state = run.state;
  return {
    exitCode: run.exitCode,
    passed: run.result?.passed ?? null,
    target: run.result?.target ?? null,
    reportedFile: run.result?.file ?? null,
    failedStep: run.result?.failedStep ?? null,
    error: run.error ?? null,
    artifacts: run.result?.artifacts ?? null,
    artifactErrors: run.result?.artifactErrors ?? [],
    stateReadable: state !== null && typeof state === 'object',
    order: state?.order ?? null,
    payment: state?.payment ?? null,
    bugState: isBugState(state),
  };
}

/** A clean pass: exit 0, `passed: true`, a readable final state.json, and no artifact errors. */
export function cleanPass(run) {
  return run.exitCode === 0 && run.passed === true && run.stateReadable && run.artifactErrors.length === 0;
}

/** The value at a dotted path in `{ order, payment }` from a summary. */
export function valueAt(run, dotted) {
  return dotted.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), { order: run.order, payment: run.payment });
}

/** The paths in `expected` whose final values differ, as `path: actual`. Empty means every value matches. */
export function mismatches(run, expected) {
  return Object.entries(expected)
    .filter(([dotted, value]) => valueAt(run, dotted) !== value)
    .map(([dotted]) => `${dotted}: ${JSON.stringify(valueAt(run, dotted))}`);
}

/**
 * The template run of a reproducing scenario: the scenario itself failed (exit 4) at a condition
 * step, an `expect` or `wait` on a path under `order` with an expected and an actual value rather
 * than an error, and the final state is the bug state. A run that failed on an error, an
 * unsupported step, or an unsettled step does not count.
 */
export function conditionFailure(run) {
  const failed = run.failedStep;
  if (run.exitCode !== 4 || run.passed !== false || !run.stateReadable || !run.bugState) return false;
  if (failed === null || typeof failed !== 'object' || 'error' in failed || !('expected' in failed) || !('actual' in failed)) return false;
  const conditionPath = failed.step?.expect ?? failed.step?.wait;
  return typeof conditionPath === 'string' && (conditionPath === 'order' || conditionPath.startsWith('order.'));
}

/** Check 1 for one candidate: a condition failure with the bug state on the template, and a clean pass without it on the session's code. */
export function reproduces(templateRun, sessionRun) {
  return Boolean(templateRun && sessionRun) && conditionFailure(templateRun) && cleanPass(sessionRun) && !sessionRun.bugState;
}

/**
 * Judges one of the agent's run folders against the reproducing scenario. `run` is
 * `{ name, result, scenarioBytes, pngs }` from the copied agent-runs/; the context holds the final
 * scenario's bytes and absolute path (under `roots[0]`, the session folder). Returns the problems
 * that disqualify it; none means it is evidence.
 */
export function judgeRun(run, { scenarioBytes, scenarioFile, calls, lastEditIndex, roots }) {
  const problems = [];
  const target = run.result?.target ?? null;
  const runPath = path.join(roots[0], '.ironbird', 'runs', run.name);
  const sameScenario = run.scenarioBytes !== undefined && Buffer.compare(run.scenarioBytes, scenarioBytes) === 0;
  if (!sameScenario) problems.push('its scenario copy differs from the final scenario file');
  if (run.result?.passed !== true) problems.push('its result.json does not say it passed');
  const reported = reportingCall(calls, runPath, roots);
  if (!reported) {
    problems.push('no ironbird_run_scenario or ironbird scenario run result in the transcript reports this folder as its artifacts');
  } else {
    if (typeof reported.result.file !== 'string' || canonicalPath(reported.result.file, roots) !== scenarioFile) problems.push(`the transcript's result names file ${reported.result.file}, not ${scenarioFile}`);
    if (reported.result.target !== target) problems.push(`the transcript's result names target ${reported.result.target}, not ${target}`);
    if (reported.result.passed !== true) problems.push("the transcript's result did not pass");
    if (reported.call.index <= lastEditIndex) problems.push("it started before the agent's last edit returned");
  }
  if (target === 'ios' && run.pngs.length === 0 && !(reported && iosCaptureAfter(calls, reported.call.resultIndex))) {
    problems.push('its folder holds no screenshot and no ironbird_screenshot or ironbird_step on ios follows it');
  }
  return { name: run.name, target, passed: run.result?.passed === true, sameScenario, reportedAt: reported?.call.index ?? null, problems };
}

/** Check 4 for one scenario: a qualifying headless run and a qualifying ios run. Only runs of the same bytes are reported. */
export function evaluateAgentRuns({ runs, ...context }) {
  const judged = runs.map((run) => judgeRun(run, context));
  const pick = (target) => {
    const good = judged.filter((entry) => entry.target === target && entry.problems.length === 0);
    return { pass: good.length > 0, run: good.at(-1)?.name ?? null };
  };
  return { headless: pick('headless'), ios: pick('ios'), runs: judged.filter((entry) => entry.sameScenario) };
}

/**
 * The reproducing scenario: among candidates that pass check 1, the first with complete agent
 * evidence, else the first by path. Undefined when none passes check 1.
 */
export function chooseReproducing(candidates) {
  const qualifying = candidates.filter((candidate) => candidate.qualifies).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return qualifying.find((candidate) => candidate.agentEvidence?.headless.pass && candidate.agentEvidence?.ios.pass) ?? qualifying[0];
}

/**
 * Check 2: each held-back run is a clean pass with exactly its expected final values, each of the
 * fixture's scenarios is a clean pass, and `npm test` exits 0. Held-back entries carry `expected`.
 */
export function fixedCheck({ heldBack, remaining, npmTestExit }) {
  const problems = [];
  if (heldBack.length !== 2) problems.push(`expected 2 held-back runs, got ${heldBack.length}`);
  for (const run of heldBack) {
    if (!cleanPass(run)) problems.push(`held-back ${run.file} is not a clean pass (exit ${run.exitCode}, passed ${run.passed}, state ${run.stateReadable ? 'readable' : 'unreadable'}, ${run.artifactErrors.length} artifact errors)`);
    const wrong = mismatches(run, run.expected);
    if (wrong.length > 0) problems.push(`held-back ${run.file} ended with ${wrong.join(', ')}`);
  }
  for (const run of remaining) if (!cleanPass(run)) problems.push(`fixture scenario ${run.file} is not a clean pass (exit ${run.exitCode}, passed ${run.passed})`);
  if (npmTestExit !== 0) problems.push(`npm test exited ${npmTestExit}`);
  return { pass: problems.length === 0, problems };
}

/**
 * Check 3: after the grader's own reload, the app came back as a fresh `ios` target in its initial
 * state, and the reproducing scenario is a clean pass on `ios` without the bug state.
 */
export function iosVerdict({ reloadTarget, freshTarget, initialState, run }) {
  const problems = [];
  if (reloadTarget !== 'ios') problems.push(`reload returned target ${reloadTarget}`);
  if (!freshTarget) problems.push('no fresh ios connection after the reload');
  if (!isInitialState(initialState)) problems.push(`the reloaded app was not in its initial state: ${JSON.stringify(initialState?.order ?? initialState)}`);
  if (!run) problems.push('the scenario did not run');
  else {
    if (!cleanPass(run)) problems.push(`the scenario is not a clean pass (exit ${run.exitCode}, passed ${run.passed})`);
    if (run.target !== 'ios') problems.push(`the scenario ran on ${run.target}`);
    if (run.bugState) problems.push('the final state is the bug state');
  }
  return { pass: problems.length === 0, problems };
}

export const CHECKS = ['reproduced', 'fixed', 'iosByGrader', 'verifiedByAgent'];

/** A session succeeds only if all four checks pass. */
export function decide(checks) {
  return CHECKS.every((name) => checks[name]?.pass === true);
}
