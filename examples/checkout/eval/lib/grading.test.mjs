import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  chooseReproducing,
  cleanPass,
  conditionFailure,
  decide,
  evaluateAgentRuns,
  fixedCheck,
  freshIosTarget,
  iosVerdict,
  isBugState,
  isInitialState,
  judgeRun,
  mismatches,
  reproduces,
  strictProblems,
  summarizeRun,
} from './grading.mjs';
import { readRunFolder } from './ironbird.mjs';
import { parseTranscript } from './transcript.mjs';

const ROOT = '/Users/dev/.ironbird-eval/sessions/1/project';
const FILE = `${ROOT}/ironbird/scenarios/zero-total.yaml`;
const SCENARIO = Buffer.from('name: Zero total\nsteps: []\n');
const bug = { cart: { items: [] }, payment: { status: 'succeeded' }, order: { status: 'completed', totalCents: 0, paymentSucceeded: true } };
const good = { cart: { items: [] }, payment: { status: 'succeeded' }, order: { status: 'completed', orderId: 'ord_1', totalCents: 4_500, paymentSucceeded: true } };
const initial = { cart: { items: [], subtotalCents: 0 }, payment: { status: 'idle' }, order: { status: 'none', totalCents: 0, paymentSucceeded: false }, reader: { connected: true }, ui: { motion: 'full' } };

/** A state revision as the grader's instrumented headless entry records it, and an analytics event as the app records it. */
const stateAt = (seq, order) => ({ seq, t: 0, source: 'grader', name: 'state', data: { rev: seq, order } });
const tracked = (seq, name, data) => ({ seq, t: 0, source: 'analytics', name, data });
const cleanHistory = [stateAt(1, { status: 'none', totalCents: 0 }), tracked(2, 'order_completed', { orderId: 'ord_1', totalCents: 4_500 }), stateAt(3, good.order)];

const orderStep = { index: 9, step: { expect: 'order.totalCents', equals: 4_500 }, expected: { equals: 4_500 }, actual: 0 };
const failing = summarizeRun({ exitCode: 4, result: { passed: false, target: 'headless', failedStep: orderStep, artifacts: '/a' }, state: bug });
const passing = summarizeRun({ exitCode: 0, result: { passed: true, target: 'headless', artifacts: '/b' }, state: good, events: cleanHistory });

const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const done = (id, text, isError = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
const HEADLESS = '2026-10-01T10-00-00-000Z-zero-total';
const IOS = '2026-10-01T10-05-00-000Z-zero-total';
const runPath = (name) => `${ROOT}/.ironbird/runs/${name}`;
const mcpResult = (name, target, overrides = {}) => JSON.stringify({ results: [{ file: FILE, passed: true, target, artifacts: runPath(name), ...overrides }] });
const agentRun = (name, target, overrides = {}) => ({ name, result: { passed: true, target }, scenarioBytes: SCENARIO, pngs: [], ...overrides });

describe('states', () => {
  it('recognizes the bug state and the initial state', () => {
    expect(isBugState(bug)).toBe(true);
    expect(isBugState(good)).toBe(false);
    expect(isBugState({ order: { status: 'confirmed', totalCents: 0 } })).toBe(false);
    expect(isBugState(undefined)).toBe(false);
    expect(isInitialState(initial)).toBe(true);
    expect(isInitialState({ ...initial, ui: { motion: 'reduced' } })).toBe(true);
    expect(isInitialState({ cart: { items: [{ sku: 'cut-45' }] }, order: { status: 'none' } })).toBe(false);
    expect(isInitialState({ cart: { items: [] }, order: { status: 'completed' } })).toBe(false);
  });

  it('is not fooled by a failed payment followed by a cart clear', () => {
    const afterFailure = { cart: { items: [], subtotalCents: 0 }, payment: { status: 'failed', method: 'card', error: 'Card declined' }, order: { status: 'none', totalCents: 0, paymentSucceeded: false } };
    expect(isInitialState(afterFailure)).toBe(false);
    expect(isInitialState({ ...initial, payment: { status: 'idle', token: 't' } })).toBe(false);
    expect(isInitialState({ ...initial, cart: { items: [], subtotalCents: 900 } })).toBe(false);
    expect(isInitialState({ ...initial, order: { ...initial.order, totalCents: 4_500 } })).toBe(false);
    expect(isInitialState({ ...initial, order: { ...initial.order, paymentSucceeded: true } })).toBe(false);
    expect(isInitialState({ ...initial, order: { ...initial.order, orderId: 'ord_1' } })).toBe(false);
    expect(isInitialState({ ...initial, reader: { connected: false } })).toBe(false);
  });

  it('rejects a partial state: nothing missing is treated as its initial value', () => {
    const { reader: _reader, ...noReader } = initial;
    expect(isInitialState(noReader)).toBe(false);
    expect(isInitialState({ ...initial, reader: {} })).toBe(false);
    expect(isInitialState({ ...initial, cart: { items: [] } })).toBe(false);
    expect(isInitialState({ ...initial, order: { status: 'none', paymentSucceeded: false } })).toBe(false);
    expect(isInitialState({ ...initial, order: { status: 'none', totalCents: 0 } })).toBe(false);
    expect(isInitialState({ ...initial, payment: {} })).toBe(false);
  });

  it('only takes an ios target that connected at or after a moment', () => {
    const targets = [
      { id: 'headless', platform: 'headless', connectedAt: 2_000 },
      { id: 'ios', platform: 'ios', connectedAt: 999 },
    ];
    expect(freshIosTarget(targets, 1_000)).toBeUndefined();
    expect(freshIosTarget([{ id: 'ios', platform: 'ios', connectedAt: 1_500 }], 1_000)).toMatchObject({ connectedAt: 1_500 });
    expect(freshIosTarget([{ id: 'ios-2', platform: 'ios', connectedAt: 5_000 }], 1_000)).toBeUndefined();
    expect(freshIosTarget(undefined, 0)).toBeUndefined();
  });

  it('takes the target id to look for, still only on the ios platform', () => {
    expect(freshIosTarget([{ id: 'ios-2', platform: 'ios', connectedAt: 5_000 }], 1_000, 'ios-2')).toMatchObject({ id: 'ios-2' });
    expect(freshIosTarget([{ id: 'ios', platform: 'ios', connectedAt: 5_000 }], 1_000, 'ios-2')).toBeUndefined();
    expect(freshIosTarget([{ id: 'ios-2', platform: 'android', connectedAt: 5_000 }], 1_000, 'ios-2')).toBeUndefined();
  });
});

describe('clean passes', () => {
  it('needs exit 0, passed, a readable state, and no artifact errors', () => {
    expect(cleanPass(passing)).toBe(true);
    expect(cleanPass(summarizeRun({ exitCode: 0, result: { passed: true }, state: undefined }))).toBe(false);
    expect(cleanPass(summarizeRun({ exitCode: 0, result: { passed: true, artifactErrors: ['state.json: ECONNRESET'] }, state: good }))).toBe(false);
    expect(cleanPass(summarizeRun({ exitCode: 4, result: { passed: true }, state: good }))).toBe(false);
  });

  it('names the expected final values that differ', () => {
    expect(mismatches(passing, { 'order.status': 'completed', 'order.totalCents': 4_500, 'payment.status': 'succeeded' })).toEqual([]);
    expect(mismatches(failing, { 'order.totalCents': 4_500 })).toEqual(['order.totalCents: 0']);
  });
});

describe('check 1: reproduces', () => {
  it('needs a condition failure under order with the bug state on the template, and a clean pass without it on the session', () => {
    expect(conditionFailure(failing)).toBe(true);
    expect(reproduces(failing, passing)).toBe(true);
  });

  it('rejects error failures, conditions outside order, missing bug state, invalid files, and a session run that is not clean', () => {
    const errorStep = summarizeRun({ exitCode: 4, result: { passed: false, failedStep: { index: 3, step: { clock: '30s' }, error: { code: 'UNSUPPORTED' } } }, state: bug });
    const paymentStep = summarizeRun({ exitCode: 4, result: { passed: false, failedStep: { index: 2, step: { expect: 'payment.status', equals: 'failed' }, expected: { equals: 'failed' }, actual: 'succeeded' } }, state: bug });
    const noBug = summarizeRun({ exitCode: 4, result: { passed: false, failedStep: orderStep }, state: good });
    const unsettled = summarizeRun({ exitCode: 4, result: { passed: false, failedStep: { index: 3, step: { send: 'payment.start' }, actual: { settle: { idle: false } } } }, state: bug });
    const invalid = summarizeRun({ exitCode: 2, error: { code: 'INVALID_SCENARIO' } });
    for (const run of [errorStep, paymentStep, noBug, unsettled, invalid]) expect(conditionFailure(run)).toBe(false);
    const passingWithBug = summarizeRun({ exitCode: 0, result: { passed: true }, state: bug });
    const passingUnreadable = summarizeRun({ exitCode: 0, result: { passed: true }, state: undefined });
    expect(reproduces(failing, passingWithBug)).toBe(false);
    expect(reproduces(failing, passingUnreadable)).toBe(false);
  });

  it('accepts a failing wait on an order path', () => {
    const waitStep = summarizeRun({ exitCode: 4, result: { passed: false, failedStep: { index: 7, step: { wait: 'order.totalCents', equals: 4_500 }, expected: { equals: 4_500 }, actual: 0 } }, state: bug });
    expect(conditionFailure(waitStep)).toBe(true);
  });
});

describe('check 2: fixed', () => {
  const heldBack = (file, expected, state = good) => ({ file, expected, ...summarizeRun({ exitCode: 0, result: { passed: true }, state, events: cleanHistory }) });
  const RACE = { 'order.status': 'completed', 'order.totalCents': 4_500 };
  const DUPLICATE = { ...RACE, 'payment.status': 'succeeded' };

  it('needs both held-back scenarios clean with their exact final values, every fixture scenario clean, and npm test', () => {
    const remaining = ['a', 'b', 'c'].map((file) => ({ file, ...passing }));
    expect(fixedCheck({ heldBack: [heldBack('race', RACE), heldBack('dup', DUPLICATE)], remaining, npmTestExit: 0 })).toEqual({ pass: true, problems: [] });
  });

  it('fails on a wrong final value even when the run passed, and on unclean runs and npm test', () => {
    const result = fixedCheck({
      heldBack: [heldBack('race', RACE, { ...good, order: { ...good.order, totalCents: 9_000 } }), { ...heldBack('dup', DUPLICATE), artifactErrors: ['events.jsonl: truncated'] }],
      remaining: [{ file: 'b', ...summarizeRun({ exitCode: 4, result: { passed: false }, state: good, events: cleanHistory }) }],
      npmTestExit: 1,
    });
    expect(result.pass).toBe(false);
    expect(result.problems).toEqual([
      'held-back race ended with order.totalCents: 9000',
      'held-back dup is not a clean pass (exit 0, passed true, state readable, 1 artifact errors)',
      'fixture scenario b is not a clean pass (exit 4, passed false)',
      'npm test exited 1',
    ]);
  });
});

describe('the bug at any recorded point (the strict reading)', () => {
  const RACE = { 'order.status': 'completed', 'order.totalCents': 4_500 };
  const DUPLICATE = { ...RACE, 'payment.status': 'succeeded' };
  const folders = [];
  afterAll(() => Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true }))));

  /** A run folder as `scenario run` leaves it: state.json and events.jsonl (either may be left out). */
  async function runFolder({ state, events }) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-run-'));
    folders.push(dir);
    if (state !== undefined) await writeFile(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    if (events !== undefined) await writeFile(path.join(dir, 'events.jsonl'), events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    return dir;
  }
  /** A passing held-back run read back from its folder, as grade.mjs gathers it. */
  async function heldBackFrom(file, expected, contents) {
    const dir = await runFolder(contents);
    return { file, expected, ...summarizeRun({ exitCode: 0, result: { passed: true, target: 'headless', artifacts: dir }, ...(await readRunFolder(dir)) }) };
  }
  const duplicate = () => heldBackFrom('duplicate-success.yaml', DUPLICATE, { state: good, events: cleanHistory });

  it('passes a fix whose every recorded state and analytics event is clean', async () => {
    const race = await heldBackFrom('race.yaml', RACE, { state: good, events: cleanHistory });
    expect(race).toMatchObject({ eventsReadable: true, stateHistory: 2, bugSightings: [] });
    expect(fixedCheck({ heldBack: [race, await duplicate()], remaining: [], npmTestExit: 0 })).toEqual({ pass: true, problems: [] });
  });

  it('fails a fix that lets the order pass through completed with totalCents 0, though it ends at 4500', async () => {
    const transient = [stateAt(1, { status: 'none', totalCents: 0 }), stateAt(2, { status: 'completed', totalCents: 0 }), tracked(3, 'order_completed', { totalCents: 4_500 }), stateAt(4, good.order)];
    const race = await heldBackFrom('race.yaml', RACE, { state: good, events: transient });
    expect(race.bugState).toBe(false);
    expect(fixedCheck({ heldBack: [race, await duplicate()], remaining: [], npmTestExit: 0 })).toEqual({
      pass: false,
      problems: ['held-back race.yaml fails the strict check: the state at seq 2 has the order completed with totalCents 0'],
    });
  });

  it('fails a fix that sends order_completed analytics with totalCents 0, though no state shows it', async () => {
    const zeroSent = [stateAt(1, { status: 'none', totalCents: 0 }), tracked(2, 'order_completed', { totalCents: 0 }), stateAt(3, good.order)];
    const race = await heldBackFrom('race.yaml', RACE, { state: good, events: zeroSent });
    expect(fixedCheck({ heldBack: [race, await duplicate()], remaining: [], npmTestExit: 0 })).toEqual({
      pass: false,
      problems: ['held-back race.yaml fails the strict check: analytics order_completed at seq 2 has totalCents 0'],
    });
  });

  it('fails a fixture scenario that shows the bug, and a run with no state history or no events', async () => {
    const remaining = [{ file: 'checkout.yaml', ...summarizeRun({ exitCode: 0, result: { passed: true }, state: good, events: [...cleanHistory, tracked(9, 'order_completed', { totalCents: 0 })] }) }];
    const noHistory = await heldBackFrom('race.yaml', RACE, { state: good, events: [tracked(1, 'order_completed', { totalCents: 4_500 })] });
    const noEvents = await heldBackFrom('duplicate-success.yaml', DUPLICATE, { state: good });
    expect(noEvents.eventsReadable).toBe(false);
    expect(fixedCheck({ heldBack: [noHistory, noEvents], remaining, npmTestExit: 0 }).problems).toEqual([
      'held-back race.yaml fails the strict check: no state history was recorded',
      'held-back duplicate-success.yaml fails the strict check: its events.jsonl is missing or unreadable',
      'held-back duplicate-success.yaml fails the strict check: no state history was recorded',
      'fixture scenario checkout.yaml fails the strict check: analytics order_completed at seq 9 has totalCents 0',
    ]);
  });

  it("rejects a reproducing scenario whose session-side run passes through the bug; the template side still needs it at the end", async () => {
    const dir = await runFolder({ state: good, events: [stateAt(1, { status: 'completed', totalCents: 0 }), stateAt(2, good.order)] });
    const transient = summarizeRun({ exitCode: 0, result: { passed: true, target: 'headless', artifacts: dir }, ...(await readRunFolder(dir)) });
    expect(cleanPass(transient)).toBe(true);
    expect(reproduces(failing, transient)).toBe(false);
    expect(reproduces(failing, passing)).toBe(true);
    expect(strictProblems(passing)).toEqual([]);
    expect(strictProblems(transient)).toEqual(['the state at seq 1 has the order completed with totalCents 0']);
  });
});

describe('check 3: iOS verdict', () => {
  // A device run records the app's events (analytics included) but no state history: only the grader's headless entry records one.
  const deviceEvents = [tracked(1, 'order_completed', { orderId: 'ord_1', totalCents: 4_500 })];
  const iosRun = summarizeRun({ exitCode: 0, result: { passed: true, target: 'ios' }, state: good, events: deviceEvents });
  it('needs the reload target, a fresh connection, the initial state, and a clean ios pass without the bug', () => {
    expect(iosVerdict({ reloadTarget: 'ios', freshTarget: { id: 'ios' }, initialState: initial, run: iosRun })).toEqual({ pass: true, problems: [] });
    const bugRun = summarizeRun({ exitCode: 0, result: { passed: true, target: 'ios' }, state: bug, events: deviceEvents });
    expect(iosVerdict({ reloadTarget: 'ios', freshTarget: undefined, initialState: good, run: bugRun }).problems).toEqual([
      'no fresh ios connection after the reload',
      'the reloaded app was not in its initial state: {"status":"completed","orderId":"ord_1","totalCents":4500,"paymentSucceeded":true}',
      'the scenario fails the strict check: the final state has the order completed with totalCents 0',
    ]);
  });

  it('rejects an ios run that sent order_completed with a zero total, or whose events are unreadable, though its final state is right', () => {
    const zeroSent = summarizeRun({ exitCode: 0, result: { passed: true, target: 'ios' }, state: good, events: [tracked(4, 'order_completed', { totalCents: 0 })] });
    expect(iosVerdict({ reloadTarget: 'ios', freshTarget: { id: 'ios' }, initialState: initial, run: zeroSent }).problems).toEqual([
      'the scenario fails the strict check: analytics order_completed at seq 4 has totalCents 0',
    ]);
    const noEvents = summarizeRun({ exitCode: 0, result: { passed: true, target: 'ios' }, state: good });
    expect(iosVerdict({ reloadTarget: 'ios', freshTarget: { id: 'ios' }, initialState: initial, run: noEvents }).problems).toEqual(['the scenario fails the strict check: its events.jsonl is missing or unreadable']);
  });

  it('judges every later step against the target the reload returned, whatever its id', () => {
    const onIos2 = { ...iosRun, target: 'ios-2' };
    expect(iosVerdict({ reloadTarget: 'ios-2', freshTarget: { id: 'ios-2' }, initialState: initial, run: onIos2 })).toEqual({ pass: true, problems: [] });
    expect(iosVerdict({ reloadTarget: 'ios-2', freshTarget: { id: 'ios' }, initialState: initial, run: iosRun }).problems).toEqual([
      'no fresh ios-2 connection after the reload',
      'the scenario ran on ios, not ios-2',
    ]);
    expect(iosVerdict({ reloadTarget: undefined, freshTarget: undefined, initialState: undefined, run: undefined }).problems).toEqual([
      'the reload returned no target',
      'no fresh connection after the reload',
      'the reloaded app was not in its initial state: undefined',
      'the scenario did not run',
    ]);
  });
});

describe('check 4: agent evidence', () => {
  const transcript = parseTranscript(
    [
      use('e1', 'Edit', { file_path: `${ROOT}/src/core/checkout.ts` }),
      done('e1', 'ok'),
      use('r1', 'mcp__ironbird__ironbird_run_scenario', { path: 'ironbird/scenarios/zero-total.yaml' }),
      done('r1', mcpResult(HEADLESS, 'headless')),
      use('r2', 'Bash', { command: 'npx ironbird scenario run ironbird/scenarios/zero-total.yaml --target ios' }),
      done('r2', mcpResult(IOS, 'ios').replace('{"results":[', '').replace(/]}$/, '')),
      use('s1', 'mcp__ironbird__ironbird_screenshot', { target: 'ios' }),
      done('s1', '{"target":"ios","path":"shot.png"}'),
    ].join('\n'),
  );
  const context = { scenarioBytes: SCENARIO, scenarioFile: FILE, calls: transcript.calls, lastEditIndex: 1, roots: [ROOT] };

  it('accepts runs whose transcript result matches artifacts, file, target, and passed exactly, started after the last edit, with an ios capture after the ios run', () => {
    const evidence = evaluateAgentRuns({ runs: [agentRun(HEADLESS, 'headless'), agentRun(IOS, 'ios')], ...context });
    expect(evidence.headless).toEqual({ pass: true, run: HEADLESS });
    expect(evidence.ios).toEqual({ pass: true, run: IOS });
  });

  it('rejects a run started before the last edit returned', () => {
    expect(judgeRun(agentRun(HEADLESS, 'headless'), { ...context, lastEditIndex: 3 }).problems).toEqual(["it started before the agent's last edit returned"]);
  });

  it('rejects a different scenario copy, a failed result.json, and a folder no result reports', () => {
    expect(judgeRun(agentRun(HEADLESS, 'headless', { scenarioBytes: Buffer.from('name: Old\n') }), context).problems).toEqual(['its scenario copy differs from the final scenario file']);
    expect(judgeRun(agentRun(HEADLESS, 'headless', { result: { passed: false, target: 'headless' } }), context).problems).toEqual(['its result.json does not say it passed']);
    expect(judgeRun(agentRun('2026-10-01T09-00-00-000Z-zero-total', 'headless'), context).problems).toEqual([
      'no ironbird_run_scenario or ironbird scenario run result in the transcript reports this folder as its artifacts',
    ]);
  });

  it('rejects a transcript result for another file, another target, or a failure', () => {
    const other = parseTranscript([use('r', 'mcp__ironbird__ironbird_run_scenario', {}), done('r', mcpResult(HEADLESS, 'ios', { file: `${ROOT}/ironbird/scenarios/other.yaml`, passed: false }))].join('\n'));
    expect(judgeRun(agentRun(HEADLESS, 'headless'), { ...context, calls: other.calls, lastEditIndex: -1 }).problems).toEqual([
      `the transcript's result names file ${ROOT}/ironbird/scenarios/other.yaml, not ${FILE}`,
      "the transcript's result names target ios, not headless",
      "the transcript's result did not pass",
    ]);
  });

  it('needs ios screenshot evidence: a PNG in the run folder, or an ios capture after the run', () => {
    const headlessCapture = parseTranscript([use('r2', 'mcp__ironbird__ironbird_run_scenario', {}), done('r2', mcpResult(IOS, 'ios')), use('s', 'mcp__ironbird__ironbird_screenshot', { target: 'headless' }), done('s', '{"target":"headless"}')].join('\n'));
    const bare = { ...context, calls: headlessCapture.calls, lastEditIndex: -1 };
    expect(judgeRun(agentRun(IOS, 'ios'), bare).problems).toEqual(['its folder holds no screenshot and no ironbird_screenshot or ironbird_step on ios follows it']);
    expect(judgeRun(agentRun(IOS, 'ios', { pngs: ['9-end.png'] }), bare).problems).toEqual([]);
  });
});

describe('choosing the reproducing scenario and deciding', () => {
  it('prefers a qualifying candidate with full agent evidence, else the first qualifying one', () => {
    const evidence = (pass) => ({ headless: { pass }, ios: { pass } });
    const candidates = [
      { file: 'a.yaml', qualifies: false, agentEvidence: evidence(true) },
      { file: 'b.yaml', qualifies: true, agentEvidence: evidence(false) },
      { file: 'c.yaml', qualifies: true, agentEvidence: evidence(true) },
    ];
    expect(chooseReproducing(candidates)?.file).toBe('c.yaml');
    expect(chooseReproducing(candidates.slice(0, 2))?.file).toBe('b.yaml');
    const unsorted = [
      { file: 'z.yaml', qualifies: true, agentEvidence: evidence(false) },
      { file: 'm.yaml', qualifies: true, agentEvidence: evidence(false) },
    ];
    expect(chooseReproducing(unsorted)?.file).toBe('m.yaml');
    expect(chooseReproducing(candidates.slice(0, 1))).toBeUndefined();
  });

  it('succeeds only when all four checks pass', () => {
    const all = { reproduced: { pass: true }, fixed: { pass: true }, iosByGrader: { pass: true }, verifiedByAgent: { pass: true } };
    expect(decide(all)).toBe(true);
    expect(decide({ ...all, iosByGrader: { pass: false, skipped: true } })).toBe(false);
    expect(decide({ reproduced: { pass: true } })).toBe(false);
  });
});
