import { IronbirdError, type Description } from '@ironbird/core';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonClient } from '../cli/client';
import { parseScenario, type Scenario } from './parse';
import { runScenario } from './run';

interface Call {
  op: string;
  params: Record<string, unknown>;
  target: string | undefined;
}

type Responder = (params: Record<string, unknown>, call: Call) => unknown;

const settled = { idle: true, quiescent: false, waitedMs: 1, pending: [] };
const unsettled = { idle: false, quiescent: false, waitedMs: 5_000, pending: [{ kind: 'effect', label: 'api.load', ageMs: 5_000, fake: false }] };
const stepResult = (settle: unknown = settled) => ({ target: 'headless', rev: 1, path: '', state: {}, events: [], settle });

const description = (overrides: Partial<Description> = {}): Description => ({
  app: { id: 'com.example.checkout', platform: 'headless' },
  commands: {},
  fakes: { api: { controls: {} }, reader: { controls: {} } },
  capabilities: ['settle', 'events', 'fakes', 'clock', 'reset'],
  ...overrides,
});

/** A DaemonClient whose every operation is answered from `responses`; an Error value is thrown. */
function scripted(responses: Record<string, Responder | unknown>, options: { envelopeTarget?: string } = {}) {
  const calls: Call[] = [];
  const client: DaemonClient = {
    url: 'http://127.0.0.1:4567',
    async call<T>(op: string, params: Record<string, unknown> = {}, target?: string): Promise<{ target?: string; result: T }> {
      const call: Call = { op, params, target };
      calls.push(call);
      const responder = responses[op];
      if (responder === undefined) throw new Error(`no response for ${op}`);
      const result = typeof responder === 'function' ? (responder as Responder)(params, call) : responder;
      if (result instanceof Error) throw result;
      return { target: options.envelopeTarget ?? target ?? 'headless', result: result as T };
    },
    async rpc<T>(op: string, params?: Record<string, unknown>, target?: string): Promise<T> {
      return (await client.call<T>(op, params, target)).result;
    },
    async stream() {},
  };
  return { client, calls };
}

const load = (yaml: string): Scenario => parseScenario(yaml, '/app/s.yaml');
const run = (client: DaemonClient, scenario: Scenario, target?: string) => runScenario(client, scenario, { file: '/app/s.yaml', target, artifacts: false });

describe('runScenario', () => {
  it('pins the target from the describe envelope and passes it on every later operation', async () => {
    const { client, calls } = scripted({ describe: description({ app: { id: 'a', platform: 'ios' }, capabilities: ['settle', 'events'] }), dispatch: stepResult() }, { envelopeTarget: 'ios' });
    const result = await run(client, load('name: pin\nsteps:\n  - send: cart.clear\n'));
    expect(result).toEqual({ scenario: 'pin', file: '/app/s.yaml', target: 'ios', passed: true, durationMs: expect.any(Number), stepsRun: 1, skipped: [], artifacts: null });
    expect(calls.map((call) => [call.op, call.target])).toEqual([
      ['describe', undefined],
      ['dispatch', 'ios'],
    ]);
  });

  it('sends describe to the override, else the scenario target, else no target', async () => {
    const override = scripted({ describe: description(), getState: { rev: 1, path: 'a', value: 1 } });
    await run(override.client, load('name: t\ntarget: headless\nsteps:\n  - expect: a\n    equals: 1\n'), 'ios');
    expect(override.calls[0]?.target).toBe('ios');
    const own = scripted({ describe: description(), getState: { rev: 1, path: 'a', value: 1 } });
    await run(own.client, load('name: t\ntarget: headless\nsteps:\n  - expect: a\n    equals: 1\n'));
    expect(own.calls[0]?.target).toBe('headless');
    const none = scripted({ describe: description(), getState: { rev: 1, path: 'a', value: 1 } });
    await run(none.client, load('name: t\nsteps:\n  - expect: a\n    equals: 1\n'));
    expect(none.calls[0]?.target).toBeUndefined();
  });

  it('maps every step kind to its operation with the parsed parameters', async () => {
    const { client, calls } = scripted(
      {
        describe: description({ app: { id: 'a', platform: 'ios' } }),
        dispatch: stepResult(),
        fakeControl: stepResult(),
        clockAdvance: { ...stepResult(), now: 300 },
        waitFor: { rev: 2, path: 'payment.status', value: 'awaitingServerEcho', waitedMs: 3 },
        getState: { rev: 2, path: 'order.totalCents', value: 4_500 },
        screenshot: { path: '/x.png', device: 'SIM-1', capturedAt: 1 },
        reset: { rev: 0, path: '', value: {} },
      },
      { envelopeTarget: 'ios' },
    );
    const scenario = load(
      [
        'name: every kind',
        'steps:',
        '  - send: cart.addItem',
        '    payload: { sku: cut-45, qty: 1 }',
        '  - fake: api',
        '    control: emit',
        '    payload: { event: payment.succeeded }',
        '    settle: false',
        '  - clock: 300ms',
        '  - wait: payment.status',
        '    equals: awaitingServerEcho',
        '    timeout: 2s',
        '  - expect: order.totalCents',
        '    equals: 4500',
        '  - screenshot: receipt',
        '  - reset: true',
        '',
      ].join('\n'),
    );
    const result = await run(client, scenario);
    expect(result).toMatchObject({ passed: true, stepsRun: 7, skipped: [], target: 'ios' });
    expect(calls.map((call) => [call.op, call.params])).toEqual([
      ['describe', {}],
      ['dispatch', { name: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, settle: true }],
      ['fakeControl', { fake: 'api', control: 'emit', payload: { event: 'payment.succeeded' }, settle: false }],
      ['clockAdvance', { ms: 300, settle: true }],
      ['waitFor', { path: 'payment.status', equals: 'awaitingServerEcho', timeoutMs: 2_000 }],
      ['getState', { path: 'order.totalCents' }],
      ['screenshot', {}],
      ['reset', {}],
    ]);
    expect(calls.every((call) => call.target === 'ios' || call.op === 'describe')).toBe(true);
  });

  it('fails an unsupported step with UNSUPPORTED before sending anything, and skips optional ones', async () => {
    const remote = description({ app: { id: 'a', platform: 'ios' }, fakes: {}, capabilities: ['settle', 'events'] });
    const { client, calls } = scripted({ describe: remote, dispatch: stepResult() }, { envelopeTarget: 'ios' });
    const result = await run(client, load('name: s\nsteps:\n  - clock: 1s\n    optional: true\n  - reset: true\n    optional: true\n  - fake: api\n    control: emit\n    optional: true\n  - send: cart.clear\n  - clock: 1s\n  - send: cart.clear\n'));
    expect(result).toMatchObject({ passed: false, stepsRun: 1, skipped: [0, 1, 2] });
    expect(result.failedStep).toEqual({ index: 4, step: { clock: '1s' }, error: { code: 'UNSUPPORTED', message: 'Target ios does not support clockAdvance', details: { op: 'clockAdvance', target: 'ios' } } });
    expect(calls.map((call) => call.op)).toEqual(['describe', 'dispatch']);

    const headless = scripted({ describe: description() });
    const shot = await run(headless.client, load('name: s\nsteps:\n  - screenshot: a\n    optional: true\n  - screenshot: b\n'));
    expect(shot).toMatchObject({ passed: false, stepsRun: 0, skipped: [0], failedStep: { index: 1, step: { screenshot: 'b' }, error: { code: 'UNSUPPORTED', details: { op: 'screenshot', target: 'headless' } } } });
    expect(headless.calls.map((call) => call.op)).toEqual(['describe']);
  });

  it('fails a fake step naming a fake the target lacks with UNKNOWN_FAKE and suggestions, or skips it when optional', async () => {
    const { client, calls } = scripted({ describe: description() });
    const result = await run(client, load('name: f\nsteps:\n  - fake: apii\n    control: emit\n'));
    expect(result.failedStep).toEqual({ index: 0, step: { fake: 'apii', control: 'emit' }, error: { code: 'UNKNOWN_FAKE', message: 'Target headless has no fake apii', details: { fake: 'apii', available: ['api', 'reader'], suggestions: ['api', 'reader'] } } });
    expect(calls.map((call) => call.op)).toEqual(['describe']);
    const optional = await run(client, load('name: f\nsteps:\n  - fake: apii\n    control: emit\n    optional: true\n'));
    expect(optional).toMatchObject({ passed: true, stepsRun: 0, skipped: [0] });
  });

  it('fails a send, fake, or clock step that ends neither idle nor quiescent unless settle is false', async () => {
    const responses = { describe: description(), dispatch: stepResult(unsettled), fakeControl: stepResult(unsettled), clockAdvance: { ...stepResult(unsettled), now: 5 } };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['- send: a', { send: 'a' }],
      ['- fake: api\n    control: emit', { fake: 'api', control: 'emit' }],
      ['- clock: 5ms', { clock: '5ms' }],
    ];
    for (const [yaml, raw] of cases) {
      const { client } = scripted(responses);
      const result = await run(client, load(`name: u\nsteps:\n  ${yaml}\n  - send: never\n`));
      expect(result.failedStep).toEqual({ index: 0, step: raw, actual: { settle: unsettled } });
      expect(result.stepsRun).toBe(1);
    }
    const optedOut = scripted(responses);
    const result = await run(optedOut.client, load('name: u\nsteps:\n  - send: a\n    settle: false\n  - fake: api\n    control: emit\n    settle: false\n  - clock: 5ms\n    settle: false\n'));
    expect(result.passed).toBe(true);
    expect(optedOut.calls.slice(1).map((call) => call.params['settle'])).toEqual([false, false, false]);
    const quiescent = scripted({ describe: description(), dispatch: stepResult({ ...unsettled, quiescent: true }) });
    expect((await run(quiescent.client, load('name: q\nsteps:\n  - send: a\n'))).passed).toBe(true);
  });

  it('runs a repeated step that many times and reports the repetition that failed', async () => {
    let dispatches = 0;
    const { client, calls } = scripted({
      describe: description(),
      dispatch: () => {
        dispatches += 1;
        return dispatches === 2 ? new IronbirdError('DISPATCH_FAILED', 'boom', { name: 'a', message: 'boom' }) : stepResult();
      },
    });
    const result = await run(client, load('name: r\nsteps:\n  - send: a\n    repeat: 3\n'));
    expect(result.failedStep).toEqual({ index: 0, step: { send: 'a', repeat: 3 }, repetition: 2, error: { code: 'DISPATCH_FAILED', message: 'boom', details: { name: 'a', message: 'boom' } } });
    expect(calls.filter((call) => call.op === 'dispatch')).toHaveLength(2);
    expect(result.stepsRun).toBe(1);

    const ok = scripted({ describe: description(), fakeControl: stepResult() });
    const passed = await run(ok.client, load('name: r\nsteps:\n  - fake: api\n    control: emit\n    repeat: 2\n'));
    expect(passed.passed).toBe(true);
    expect(ok.calls.filter((call) => call.op === 'fakeControl')).toHaveLength(2);

    let controls = 0;
    const unsettledThird = scripted({
      describe: description(),
      fakeControl: () => {
        controls += 1;
        return controls === 3 ? stepResult(unsettled) : stepResult();
      },
    });
    const third = await run(unsettledThird.client, load('name: r\nsteps:\n  - fake: api\n    control: emit\n    repeat: 3\n'));
    expect(third.failedStep).toEqual({ index: 0, step: { fake: 'api', control: 'emit', repeat: 3 }, repetition: 3, actual: { settle: unsettled } });
    expect(unsettledThird.calls.filter((call) => call.op === 'fakeControl')).toHaveLength(3);
  });

  it('reports a wait timeout and a failed expect with expected and actual, and any other error as its shape', async () => {
    const timeout = scripted({ describe: description(), waitFor: new IronbirdError('WAIT_TIMEOUT', 'nope', { path: 'payment.status', value: 'collecting', pending: [] }) });
    const waited = await run(timeout.client, load('name: w\nsteps:\n  - wait: payment.status\n    equals: awaitingServerEcho\n  - send: never\n'));
    expect(waited.failedStep).toEqual({ index: 0, step: { wait: 'payment.status', equals: 'awaitingServerEcho' }, expected: { equals: 'awaitingServerEcho' }, actual: 'collecting' });
    expect(waited).toMatchObject({ passed: false, stepsRun: 1 });
    expect(timeout.calls.map((call) => call.op)).toEqual(['describe', 'waitFor']);

    const mismatch = scripted({ describe: description(), getState: { rev: 3, path: 'order.totalCents', value: 0 } });
    const expected = await run(mismatch.client, load('name: e\nsteps:\n  - expect: order.totalCents\n    equals: 4500\n'));
    expect(expected.failedStep).toEqual({ index: 0, step: { expect: 'order.totalCents', equals: 4500 }, expected: { equals: 4500 }, actual: 0 });

    const invalid = scripted({ describe: description(), dispatch: new IronbirdError('INVALID_PAYLOAD', 'bad', { name: 'cart.addItem', issues: [] }) });
    const errored = await run(invalid.client, load('name: i\nsteps:\n  - send: cart.addItem\n    payload: { qty: 0 }\n'));
    expect(errored.failedStep).toEqual({ index: 0, step: { send: 'cart.addItem', payload: { qty: 0 } }, error: { code: 'INVALID_PAYLOAD', message: 'bad', details: { name: 'cart.addItem', issues: [] } } });

    const gone = scripted({ describe: description(), waitFor: new IronbirdError('TARGET_DISCONNECTED', 'gone', { target: 'headless', op: 'waitFor' }) });
    const disconnected = await run(gone.client, load('name: g\nsteps:\n  - wait: a\n    exists: true\n'));
    expect(disconnected.failedStep).toEqual({ index: 0, step: { wait: 'a', exists: true }, error: { code: 'TARGET_DISCONNECTED', message: 'gone', details: { target: 'headless', op: 'waitFor' } } });
  });

  it('rejects with the describe error itself when the initial describe fails', async () => {
    const { client } = scripted({ describe: new IronbirdError('NO_TARGET', 'No target is connected or configured', { available: [] }) });
    await expect(run(client, load('name: d\nsteps:\n  - send: a\n'))).rejects.toMatchObject({ code: 'NO_TARGET' });
  });

  it('creates the run directory under <artifacts>/runs and names screenshots by step index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ironbird-runs-'));
    try {
      const { client, calls } = scripted(
        {
          describe: description({ app: { id: 'a', platform: 'ios' }, fakes: {}, capabilities: ['settle', 'events'] }),
          screenshot: { path: '/x.png', device: 'SIM-1', capturedAt: 1 },
          events: { events: [], nextSeq: 0, truncated: false },
          getState: { rev: 0, path: '', value: {} },
        },
        { envelopeTarget: 'ios' },
      );
      const result = await runScenario(client, load('name: Shot Me!\nsteps:\n  - screenshot: receipt\n'), { file: '/app/s.yaml', artifacts: root });
      const dir = result.artifacts as string;
      expect(path.dirname(dir)).toBe(path.join(root, 'runs'));
      expect(path.basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-shot-me$/);
      expect((await stat(dir)).isDirectory()).toBe(true);
      expect(calls.find((call) => call.op === 'screenshot')).toEqual({ op: 'screenshot', params: { out: path.join(dir, '0-receipt.png') }, target: 'ios' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('runScenario artifacts', () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ironbird-artifacts-'));
    file = path.join(root, 'happy.yaml');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the result, a copy of the scenario, and the events, state, and calls recorded after the run started', async () => {
    await writeFile(file, 'name: Happy path\nsteps:\n  - send: cart.clear\n');
    const { client, calls } = scripted({
      describe: description(),
      dispatch: stepResult(),
      events: (params: Record<string, unknown>) => (params['limit'] === 0 ? { events: [], nextSeq: 7, truncated: false } : { events: [{ seq: 8, t: 1, source: 'cart', name: 'cleared' }], nextSeq: 8, truncated: false }),
      fakeCalls: (params: Record<string, unknown>) =>
        params['limit'] === 0
          ? { calls: [], nextSeq: params['fake'] === 'api' ? 3 : 0, truncated: false }
          : { calls: [{ seq: 4, t: 1, fake: params['fake'], method: 'submit', args: [], outcome: 'returned' }], nextSeq: 4, truncated: false },
      getState: { rev: 1, path: '', value: { cart: { items: [] } } },
    });
    const result = await runScenario(client, parseScenario(await readFile(file, 'utf8'), file), { file, artifacts: root });
    const dir = result.artifacts as string;
    expect(result.passed).toBe(true);
    expect(result.artifactErrors).toBeUndefined();
    expect((await readdir(dir)).sort()).toEqual(['calls', 'events.jsonl', 'happy.yaml', 'result.json', 'state.json']);
    expect(JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'))).toEqual(result);
    expect(await readFile(path.join(dir, 'happy.yaml'), 'utf8')).toBe('name: Happy path\nsteps:\n  - send: cart.clear\n');
    expect(await readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":8,"t":1,"source":"cart","name":"cleared"}\n');
    expect(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))).toEqual({ cart: { items: [] } });
    expect(JSON.parse(await readFile(path.join(dir, 'calls/api.json'), 'utf8'))).toEqual([{ seq: 4, t: 1, fake: 'api', method: 'submit', args: [], outcome: 'returned' }]);
    expect(JSON.parse(await readFile(path.join(dir, 'calls/reader.json'), 'utf8'))).toEqual([{ seq: 4, t: 1, fake: 'reader', method: 'submit', args: [], outcome: 'returned' }]);
    expect(calls.map((call) => [call.op, call.params])).toEqual([
      ['describe', {}],
      ['events', { limit: 0 }],
      ['fakeCalls', { fake: 'api', limit: 0 }],
      ['fakeCalls', { fake: 'reader', limit: 0 }],
      ['dispatch', { name: 'cart.clear', payload: {}, settle: true }],
      ['events', { since: 7 }],
      ['getState', { path: '' }],
      ['fakeCalls', { fake: 'api', since: 3 }],
      ['fakeCalls', { fake: 'reader', since: 0 }],
    ]);
    expect(calls.every((call) => call.target === 'headless' || call.op === 'describe')).toBe(true);
  });

  it('captures the cursors again after a reset step, so the logs cover only what came after it', async () => {
    await writeFile(file, 'name: Reset\nsteps:\n  - send: cart.clear\n  - reset: true\n  - send: cart.clear\n');
    let resets = 0;
    const { client, calls } = scripted({
      describe: description(),
      dispatch: stepResult(),
      reset: () => {
        resets += 1;
        return { rev: 0, path: '', value: {} };
      },
      events: (params: Record<string, unknown>) => (params['limit'] === 0 ? { events: [], nextSeq: resets === 0 ? 7 : 0, truncated: false } : { events: [], nextSeq: 0, truncated: false }),
      fakeCalls: (params: Record<string, unknown>) => (params['limit'] === 0 ? { calls: [], nextSeq: resets === 0 ? 5 : 0, truncated: false } : { calls: [], nextSeq: 0, truncated: false }),
      getState: { rev: 0, path: '', value: {} },
    });
    const result = await runScenario(client, parseScenario(await readFile(file, 'utf8'), file), { file, artifacts: root });
    expect(result).toMatchObject({ passed: true, stepsRun: 3 });
    expect(calls.filter((call) => call.op === 'events').map((call) => call.params)).toEqual([{ limit: 0 }, { limit: 0 }, { since: 0 }]);
    expect(calls.filter((call) => call.op === 'fakeCalls').map((call) => call.params)).toEqual([
      { fake: 'api', limit: 0 },
      { fake: 'reader', limit: 0 },
      { fake: 'api', limit: 0 },
      { fake: 'reader', limit: 0 },
      { fake: 'api', since: 0 },
      { fake: 'reader', since: 0 },
    ]);
    expect(calls.map((call) => call.op).slice(0, 8)).toEqual(['describe', 'events', 'fakeCalls', 'fakeCalls', 'dispatch', 'reset', 'events', 'fakeCalls']);
  });

  it('collects best effort: a file that cannot be gathered or written is named in artifactErrors and the rest is still written', async () => {
    const missing = path.join(root, 'missing.yaml');
    const { client } = scripted({
      describe: description({ fakes: {}, capabilities: ['settle', 'events', 'clock', 'reset'] }),
      dispatch: stepResult(),
      events: (params: Record<string, unknown>) => (params['limit'] === 0 ? { events: [], nextSeq: 7, truncated: false } : { events: [{ seq: 9, t: 2, source: 'cart', name: 'cleared' }], nextSeq: 9, truncated: true }),
      getState: new IronbirdError('TARGET_DISCONNECTED', 'Target headless disconnected', { target: 'headless', op: 'getState' }),
    });
    const result = await runScenario(client, load('name: Best effort\nsteps:\n  - send: cart.clear\n'), { file: missing, artifacts: root });
    const dir = result.artifacts as string;
    expect(result.passed).toBe(true);
    expect(result.artifactErrors).toEqual([
      expect.stringMatching(/^missing\.yaml: .*ENOENT/),
      'events.jsonl: the recorder dropped events before seq 7; the log is incomplete',
      'state.json: Target headless disconnected',
    ]);
    expect((await readdir(dir)).sort()).toEqual(['events.jsonl', 'result.json']);
    expect(await readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":9,"t":2,"source":"cart","name":"cleared"}\n');
    expect(JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'))).toEqual(result);
  });

  it('adds an artifactErrors entry when a fake call log was truncated, and still writes the file', async () => {
    await writeFile(file, 'name: Truncated\nsteps:\n  - send: cart.clear\n');
    const { client } = scripted({
      describe: description({ fakes: { api: { controls: {} } } }),
      dispatch: stepResult(),
      events: () => ({ events: [], nextSeq: 0, truncated: false }),
      fakeCalls: (params: Record<string, unknown>) =>
        params['limit'] === 0
          ? { calls: [], nextSeq: 3, truncated: false }
          : { calls: [{ seq: 4, t: 1, fake: 'api', method: 'submit', args: [], outcome: 'returned' }], nextSeq: 4, truncated: true },
      getState: { rev: 1, path: '', value: {} },
    });
    const result = await runScenario(client, parseScenario(await readFile(file, 'utf8'), file), { file, artifacts: root });
    const dir = result.artifacts as string;
    expect(result.passed).toBe(true);
    expect(result.artifactErrors).toEqual(['calls/api.json: the recorder dropped calls before seq 3; the log is incomplete']);
    expect(JSON.parse(await readFile(path.join(dir, 'calls/api.json'), 'utf8'))).toEqual([{ seq: 4, t: 1, fake: 'api', method: 'submit', args: [], outcome: 'returned' }]);
  });

  it('writes nothing and reports null artifacts when turned off', async () => {
    const { client, calls } = scripted({ describe: description(), dispatch: stepResult() });
    const result = await runScenario(client, load('name: Off\nsteps:\n  - send: cart.clear\n'), { file, artifacts: false });
    expect(result.artifacts).toBeNull();
    expect(calls.map((call) => call.op)).toEqual(['describe', 'dispatch']);
    expect(await readdir(root)).toEqual([]);
  });
});
