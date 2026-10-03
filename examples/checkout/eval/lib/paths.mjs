// Where everything lives, and the eval's fixed settings (M3 design §7).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** examples/checkout/eval */
export const evalDir = path.resolve(here, '..');
/** examples/checkout */
export const exampleDir = path.resolve(evalDir, '..');
/** The repository root. */
export const repoRoot = path.resolve(exampleDir, '../..');

/** The held-back scenarios. They stay in the repository; the grader runs them against each session's code. */
export const RACE_SCENARIO = path.join(exampleDir, 'ironbird/scenarios/race-success-before-confirmation.yaml');
export const DUPLICATE_SCENARIO = path.join(exampleDir, 'ironbird/scenarios/duplicate-success.yaml');
/** Each held-back scenario with the final values its `expect` steps assert; the grader requires exactly these. */
export const HELD_BACK = [
  { file: RACE_SCENARIO, expected: { 'order.status': 'completed', 'order.totalCents': 4_500 } },
  { file: DUPLICATE_SCENARIO, expected: { 'order.status': 'completed', 'order.totalCents': 4_500, 'payment.status': 'succeeded' } },
];

/**
 * The `--model` value: the `sonnet` alias (D8). On Claude Code 2.1.283 it resolves to
 * `claude-sonnet-5`; a full id such as `claude-sonnet-5-5` is rejected there as an unrecognized model.
 */
export const MODEL = 'sonnet';
/**
 * What the init event's `model` must match for the baseline and every session. The exact id the
 * alias resolved to is recorded in prepare.json and in each session record.
 */
export const MODEL_PATTERN = /^claude-sonnet-/;
export const BUDGET_USD = 10;
/** The whole session, from its start to the end of teardown: startup, claude, copying the runs, and stopping everything. */
export const SESSION_LIMIT_MS = 45 * 60_000;
/** Held back from claude's share of the deadline for copying the runs and the bounded teardown. */
export const TEARDOWN_RESERVE_MS = 2 * 60_000;
export const DEVICE_TIMEOUT_MS = 180_000;
export const EXPO_GO = 'host.exp.Exponent';
export const METRO_PORT = 8081;
export const METRO_URL = `exp://127.0.0.1:${METRO_PORT}`;
/** The daemon's default ports. The app dials the bridge port, so sessions and the grader's iOS check use the defaults. */
export const DAEMON_PORT = 4567;
export const BRIDGE_PORT = 4568;

/** `~/.ironbird-eval`, or IRONBIRD_EVAL_HOME. */
export function evalHome(env = process.env) {
  return path.resolve(env.IRONBIRD_EVAL_HOME ?? path.join(os.homedir(), '.ironbird-eval'));
}

export function layout(home = evalHome()) {
  return {
    home,
    template: path.join(home, 'template'),
    templateCheck: path.join(home, 'template-check'),
    baselineDir: path.join(home, 'baseline'),
    baselineFile: path.join(home, 'baseline.json'),
    prepareFile: path.join(home, 'prepare.json'),
    logs: path.join(home, 'logs'),
    sessions: path.join(home, 'sessions'),
    grades: path.join(home, 'grades'),
  };
}

/**
 * One session's folder. The agent works in `project/`; the harness keeps its own files (transcript,
 * settings, logs, the copied runs, the record) beside it, outside the agent's working tree.
 */
export function sessionLayout(home, id) {
  const dir = path.join(home, 'sessions', id);
  return {
    dir,
    project: path.join(dir, 'project'),
    transcript: path.join(dir, 'transcript.jsonl'),
    stderr: path.join(dir, 'claude-stderr.log'),
    settings: path.join(dir, 'settings.json'),
    agentRuns: path.join(dir, 'agent-runs'),
    record: path.join(dir, 'session.json'),
    logs: path.join(dir, 'logs'),
  };
}

/** One grade's folder: copies of the session's project and of the template, the grader's logs and outputs. */
export function gradeLayout(home, id) {
  const dir = path.join(home, 'grades', id);
  return {
    dir,
    session: path.join(dir, 'session'),
    template: path.join(dir, 'template'),
    grade: path.join(dir, 'grade.json'),
    report: path.join(dir, 'final-report.md'),
    claims: path.join(dir, 'claims.md'),
    logs: path.join(dir, 'logs'),
  };
}

/** Session ids: `smoke-1`, `pilot-1`, `g1-3`, and so on. */
export function sessionId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error(`Expected a session id such as pilot-1 or g1-3, got ${JSON.stringify(value)}`);
  return value;
}

export function simUdid(env = process.env) {
  const udid = env.IRONBIRD_SIM_UDID;
  if (!udid) throw new Error('Set IRONBIRD_SIM_UDID to the iPhone 17 simulator udid (examples/checkout/eval/README.md)');
  return udid;
}
