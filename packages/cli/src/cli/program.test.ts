import { IronbirdError } from '@ironbird/core';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonClient } from './client';
import type { McpServerOptions } from '../mcp/server';
import { buildProgram } from './program';

interface Call {
  op: string;
  params: Record<string, unknown>;
  target: string | undefined;
}

type Responder = unknown | ((params: Record<string, unknown>) => unknown);

interface StreamFrame {
  kind: 'event' | 'state' | 'target' | 'error';
  data: unknown;
}

function harness(responses: Record<string, Responder>, options: { isTTY?: boolean; streamFrames?: StreamFrame[]; createClient?: () => DaemonClient; cwd?: string } = {}) {
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client: DaemonClient = {
    url: 'http://127.0.0.1:4567',
    async call<T>(op: string, params: Record<string, unknown> = {}, target?: string) {
      calls.push({ op, params, target });
      const responder = responses[op];
      if (responder === undefined) throw new Error(`no response for ${op}`);
      const result = typeof responder === 'function' ? (responder as (p: Record<string, unknown>) => unknown)(params) : responder;
      if (result instanceof Error) throw result;
      return (op === 'status' ? { result } : { target: target ?? 'headless', result }) as { target?: string; result: T };
    },
    async rpc(op, params, target) {
      return (await this.call(op, params, target)).result as never;
    },
    async stream({ onMessage }) {
      const frames = options.streamFrames ?? [{ kind: 'event', data: { seq: 9, name: 'streamed' } }];
      for (const frame of frames) onMessage(frame.kind, frame.data);
    },
  };
  const { run } = buildProgram({
    cwd: options.cwd ?? '/tmp/nowhere',
    env: {},
    isTTY: options.isTTY ?? false,
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    version: '0.0.0-test',
    createClient: options.createClient ?? (() => client),
    signal: AbortSignal.abort(),
  });
  return { run, calls, stdout, stderr, out: () => JSON.parse(stdout.join('')) as Record<string, unknown> };
}

const settled = { idle: true, quiescent: false, waitedMs: 1, pending: [] };
const step = (overrides: Record<string, unknown> = {}) => ({ target: 'headless', rev: 1, path: '', state: {}, events: [], settle: settled, ...overrides });

describe('buildProgram', () => {
  it('status prints the daemon status as one JSON line', async () => {
    const h = harness({ status: { version: '1', protocol: 1, uptimeMs: 5, targets: [] } });
    expect(await h.run(['status'])).toBe(0);
    expect(h.stdout).toEqual(['{"version":"1","protocol":1,"uptimeMs":5,"targets":[]}\n']);
  });

  it('send parses the payload and settle flags and exits by the settle outcome', async () => {
    const h = harness({ dispatch: step() });
    expect(await h.run(['send', 'cart.addItem', '{"sku":"cut-45","qty":1}', '--path', 'cart', '--settle-timeout', '2s', '--target', 'ios'])).toBe(0);
    expect(h.calls[0]).toEqual({ op: 'dispatch', target: 'ios', params: { name: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, path: 'cart', settle: { timeoutMs: 2_000 } } });
    expect(await h.run(['send', 'cart.clear', '--no-settle'])).toBe(0);
    expect(h.calls[1]?.params).toEqual({ name: 'cart.clear', payload: {}, path: '', settle: false });
    const unsettled = harness({ dispatch: step({ settle: { ...settled, idle: false } }) });
    expect(await unsettled.run(['send', 'payment.start', '{"method":"card"}'])).toBe(3);
    expect(await harness({}).run(['send', 'cart.addItem', '{oops'])).toBe(2);
  });

  it('state, clock now, and reset prepend the target', async () => {
    const h = harness({ getState: { rev: 2, path: 'payment', value: { status: 'idle' } }, clockNow: { now: 5 }, reset: { rev: 0, path: '', value: {} } });
    await h.run(['state', 'payment']);
    expect(h.out()).toEqual({ target: 'headless', rev: 2, path: 'payment', value: { status: 'idle' } });
    expect(h.calls[0]?.params).toEqual({ path: 'payment' });
    h.stdout.length = 0;
    await h.run(['clock', 'now']);
    expect(h.out()).toEqual({ target: 'headless', now: 5 });
    h.stdout.length = 0;
    await h.run(['reset']);
    expect(h.out()).toEqual({ target: 'headless', rev: 0, path: '', value: {} });
  });

  it('wait builds exactly one condition, parses values as JSON or strings, and maps timeouts to exit 4', async () => {
    const h = harness({ waitFor: { rev: 3, path: 'payment.status', value: 'awaitingServerEcho', waitedMs: 12 } });
    expect(await h.run(['wait', 'payment.status', '--equals', 'awaitingServerEcho', '--timeout', '2s'])).toBe(0);
    expect(h.calls[0]?.params).toEqual({ path: 'payment.status', equals: 'awaitingServerEcho', timeoutMs: 2_000 });
    await h.run(['wait', 'order.total', '--not-equals', '0']);
    expect(h.calls[1]?.params).toEqual({ path: 'order.total', notEquals: 0, timeoutMs: 5_000 });
    await h.run(['wait', 'order.id', '--exists']);
    expect(h.calls[2]?.params).toEqual({ path: 'order.id', exists: true, timeoutMs: 5_000 });
    expect(await h.run(['wait', 'a', '--equals', '1', '--exists'])).toBe(2);
    expect(await h.run(['wait', 'a'])).toBe(2);
    const timeout = harness({ waitFor: new IronbirdError('WAIT_TIMEOUT', 'nope', { path: 'a', value: 1, pending: [] }) });
    expect(await timeout.run(['wait', 'a', '--equals', '2'])).toBe(4);
    expect(timeout.out()).toEqual({ error: { code: 'WAIT_TIMEOUT', message: 'nope', details: { path: 'a', value: 1, pending: [] } } });
  });

  it('clock advance parses durations into ms and returns a step result', async () => {
    const h = harness({ clockAdvance: { ...step(), now: 30_000 } });
    expect(await h.run(['clock', 'advance', '30s', '--path', 'payment'])).toBe(0);
    expect(h.calls[0]).toEqual({ op: 'clockAdvance', target: undefined, params: { ms: 30_000, path: 'payment', settle: true } });
    expect(await h.run(['clock', 'advance', 'soon'])).toBe(2);
  });

  it('commands lists or filters the description and suggests near misses', async () => {
    const description = { app: { id: 'a', platform: 'headless' }, commands: { 'cart.addItem': { payload: {} }, 'cart.clear': { payload: {} } }, fakes: {}, capabilities: [] };
    const h = harness({ describe: description });
    await h.run(['commands']);
    expect(h.out()).toEqual(description.commands);
    h.stdout.length = 0;
    await h.run(['commands', '--name', 'cart.clear']);
    expect(h.out()).toEqual({ 'cart.clear': { payload: {} } });
    h.stdout.length = 0;
    expect(await h.run(['commands', '--name', 'cart.clean'])).toBe(1);
    expect(h.out()).toEqual({ error: { code: 'UNKNOWN_COMMAND', message: 'Unknown command cart.clean', details: { name: 'cart.clean', suggestions: ['cart.clear', 'cart.addItem'] } } });
    h.stdout.length = 0;
    await h.run(['fakes']);
    expect(h.out()).toEqual({});
  });

  it('events pages with since and limit, and --follow prints JSON lines from the stream', async () => {
    const h = harness({ events: { events: [{ seq: 4, t: 0, source: 's', name: 'a' }], nextSeq: 4, truncated: false } });
    await h.run(['events', '--since', '3', '--limit', '2']);
    expect(h.calls[0]?.params).toEqual({ since: 3, limit: 2 });
    expect(h.out()).toEqual({ target: 'headless', events: [{ seq: 4, t: 0, source: 's', name: 'a' }], nextSeq: 4, truncated: false });
    h.stdout.length = 0;
    expect(await h.run(['events', '--follow'])).toBe(0);
    expect(h.stdout).toEqual(['{"seq":4,"t":0,"source":"s","name":"a"}\n', '{"seq":9,"name":"streamed"}\n']);
  });

  it('events --follow prints an error frame then resolves with its mapped exit code', async () => {
    const h = harness(
      { events: { events: [], nextSeq: 0, truncated: false } },
      {
        streamFrames: [
          { kind: 'event', data: { seq: 9, name: 'streamed' } },
          { kind: 'error', data: { code: 'TARGET_DISCONNECTED', message: 'gone' } },
        ],
      },
    );
    expect(await h.run(['events', '--follow'])).toBe(1);
    expect(h.stdout).toEqual(['{"seq":9,"name":"streamed"}\n', '{"error":{"code":"TARGET_DISCONNECTED","message":"gone"}}\n']);
  });

  it('events --follow reports a malformed error frame as INTERNAL and exits 1', async () => {
    const h = harness({ events: { events: [], nextSeq: 0, truncated: false } }, { streamFrames: [{ kind: 'error', data: 'nope' }] });
    expect(await h.run(['events', '--follow'])).toBe(1);
    expect(h.stdout).toEqual(['{"error":{"code":"INTERNAL","message":"Malformed error frame from daemon"}}\n']);
  });

  it('events --follow with TTY outputs error frame as JSON lines', async () => {
    const h = harness(
      { events: { events: [{ seq: 4, t: 0, source: 's', name: 'a' }], nextSeq: 4, truncated: false } },
      {
        isTTY: true,
        streamFrames: [
          { kind: 'event', data: { seq: 9, name: 'streamed' } },
          { kind: 'error', data: { code: 'TARGET_DISCONNECTED', message: 'gone' } },
        ],
      },
    );
    expect(await h.run(['events', '--follow'])).toBe(1);
    expect(h.stdout).toEqual([
      '{"seq":4,"t":0,"source":"s","name":"a"}\n',
      '{"seq":9,"name":"streamed"}\n',
      '{"error":{"code":"TARGET_DISCONNECTED","message":"gone"}}\n',
    ]);
  });

  it('exits 5 when the daemon is unreachable and 2 for unknown commands', async () => {
    const down = harness({ status: new IronbirdError('NO_TARGET', 'Daemon unreachable at http://127.0.0.1:4567; run ironbird serve', { url: 'x' }) });
    expect(await down.run(['status'])).toBe(5);
    expect(down.out()).toMatchObject({ error: { code: 'NO_TARGET' } });
    const unknown = harness({});
    expect(await unknown.run(['frobnicate'])).toBe(2);
    expect(unknown.stderr.join('')).toContain("unknown command 'frobnicate'");
    expect(await unknown.run(['--help'])).toBe(0);
  });

  it('honors --json for an error raised before the client resolves', async () => {
    const h = harness(
      {},
      {
        isTTY: true,
        createClient: () => {
          throw new IronbirdError('NO_TARGET', 'Daemon unreachable at http://127.0.0.1:4567; run ironbird serve', { url: 'x' });
        },
      },
    );
    expect(await h.run(['status', '--json'])).toBe(5);
    expect(h.stdout).toEqual(['{"error":{"code":"NO_TARGET","message":"Daemon unreachable at http://127.0.0.1:4567; run ironbird serve","details":{"url":"x"}}}\n']);
  });

  it('prints readable text in a TTY unless --json is passed', async () => {
    const tty = harness({ status: { version: '1' } }, { isTTY: true });
    await tty.run(['status']);
    expect(tty.stdout).toEqual(['{\n  "version": "1"\n}\n']);
    tty.stdout.length = 0;
    await tty.run(['status', '--json']);
    expect(tty.stdout).toEqual(['{"version":"1"}\n']);
  });
});

describe('screenshot and step', () => {
  it('screenshot passes device and an absolute out path, and adds the target to the result', async () => {
    const h = harness({ screenshot: { path: '/tmp/nowhere/shot.png', device: 'SIM-1', capturedAt: 5 } });
    expect(await h.run(['screenshot', '--device', 'SIM-1', '--out', 'shot.png'])).toBe(0);
    expect(h.calls).toEqual([{ op: 'screenshot', params: { device: 'SIM-1', out: '/tmp/nowhere/shot.png' }, target: undefined }]);
    expect(h.out()).toEqual({ target: 'headless', path: '/tmp/nowhere/shot.png', device: 'SIM-1', capturedAt: 5 });
  });

  it('step sends, settles, and exits 3 when the step did not settle', async () => {
    const shot = { path: '/tmp/x.png', device: 'SIM-1', capturedAt: 5 };
    const settledStep = harness({ step: { ...step(), screenshot: shot, settledBeforeCapture: true } });
    expect(await settledStep.run(['step', 'cart.addItem', '{"sku":"cut-45","qty":1}', '--path', 'cart', '--device', 'SIM-1'])).toBe(0);
    expect(settledStep.calls).toEqual([{ op: 'step', params: { name: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, path: 'cart', settle: true, device: 'SIM-1' }, target: undefined }]);
    expect(settledStep.out()).toMatchObject({ screenshot: shot, settledBeforeCapture: true });

    const unsettled = harness({ step: { ...step({ settle: { idle: false, quiescent: false, waitedMs: 5000, pending: [{ kind: 'effect', label: 'api.load', ageMs: 5000, fake: false }] } }), screenshot: shot, settledBeforeCapture: false } });
    expect(await unsettled.run(['step', 'data.load', '--settle-timeout', '5s', '--target', 'ios'])).toBe(3);
    expect(unsettled.calls[0]).toMatchObject({ params: { settle: { timeoutMs: 5000 } }, target: 'ios' });
    expect(await harness({ step: step() }).run(['step', 'x', '--no-settle'])).toBe(0);
  });
});

describe('fake', () => {
  it('runs a control as a step and exits by the settle outcome', async () => {
    const h = harness({ fakeControl: step() });
    expect(await h.run(['fake', 'api', 'emit', '{"event":"payment.succeeded"}', '--path', 'payment', '--settle-timeout', '2s', '--target', 'ios'])).toBe(0);
    expect(h.calls[0]).toEqual({ op: 'fakeControl', target: 'ios', params: { fake: 'api', control: 'emit', payload: { event: 'payment.succeeded' }, path: 'payment', settle: { timeoutMs: 2_000 } } });
    expect(await h.run(['fake', 'reader', 'emit', '--no-settle'])).toBe(0);
    expect(h.calls[1]?.params).toEqual({ fake: 'reader', control: 'emit', payload: {}, path: '', settle: false });
    const unsettled = harness({ fakeControl: step({ settle: { ...settled, idle: false } }) });
    expect(await unsettled.run(['fake', 'api', 'emit'])).toBe(3);
    const unknown = harness({ fakeControl: new IronbirdError('UNKNOWN_FAKE', 'Unknown fake apii', { fake: 'apii', available: ['api', 'reader'], suggestions: ['api'] }) });
    expect(await unknown.run(['fake', 'apii', 'emit'])).toBe(1);
    expect(unknown.out()).toEqual({ error: { code: 'UNKNOWN_FAKE', message: 'Unknown fake apii', details: { fake: 'apii', available: ['api', 'reader'], suggestions: ['api'] } } });
  });

  it('--calls pages the fake call log and names the fake in the output', async () => {
    const call = { seq: 3, t: 0, fake: 'api', method: 'submitPayment', args: [{ amountCents: 4_500 }], outcome: 'resolved' };
    const h = harness({ fakeCalls: { calls: [call], nextSeq: 3, truncated: false } });
    expect(await h.run(['fake', 'api', '--calls', '--since', '2'])).toBe(0);
    expect(h.calls[0]).toEqual({ op: 'fakeCalls', target: undefined, params: { fake: 'api', since: 2 } });
    expect(h.out()).toEqual({ target: 'headless', fake: 'api', calls: [call], nextSeq: 3, truncated: false });
    h.stdout.length = 0;
    expect(await h.run(['fake', 'api', '--calls', '--target', 'ios'])).toBe(0);
    expect(h.calls[1]).toEqual({ op: 'fakeCalls', target: 'ios', params: { fake: 'api' } });
    expect(h.out()).toMatchObject({ target: 'ios', fake: 'api' });
  });

  it('needs a control or --calls, rejects both together, and rejects --since without --calls', async () => {
    const h = harness({});
    expect(await h.run(['fake', 'api'])).toBe(2);
    expect(h.stderr.join('')).toContain('fake needs a control or --calls');
    expect(await h.run(['fake', 'api', 'emit', '--calls'])).toBe(2);
    expect(h.stderr.join('')).toContain('not both');
    expect(await h.run(['fake', 'api', 'emit', '--since', '1'])).toBe(2);
    expect(h.stderr.join('')).toContain('--since only applies with --calls');
    expect(await h.run(['fake', 'api', 'emit', '{oops'])).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe('reload', () => {
  it('prints the target and rev, and passes --timeout in milliseconds', async () => {
    const h = harness({ reload: (params: Record<string, unknown>) => ({ rev: params['timeoutMs'] === undefined ? 0 : 4 }) });
    expect(await h.run(['reload'])).toBe(0);
    expect(h.calls[0]).toEqual({ op: 'reload', target: undefined, params: {} });
    expect(h.out()).toEqual({ target: 'headless', rev: 0 });
    h.stdout.length = 0;
    expect(await h.run(['reload', '--timeout', '90s', '--target', 'ios'])).toBe(0);
    expect(h.calls[1]).toEqual({ op: 'reload', target: 'ios', params: { timeoutMs: 90_000 } });
    expect(h.out()).toEqual({ target: 'ios', rev: 4 });
    expect(await h.run(['reload', '--timeout', 'soon'])).toBe(2);
    expect(h.calls).toHaveLength(2);
  });

  it.each([
    ['HEADLESS_LOAD_FAILED', 2],
    ['AMBIGUOUS_TARGET', 2],
    ['TARGET_DISCONNECTED', 1],
    ['UNSUPPORTED', 1],
    ['NO_TARGET', 5],
  ] as const)('exits by the error table when reload fails with %s', async (code, exit) => {
    const h = harness({ reload: new IronbirdError(code, `reload failed with ${code}`) });
    expect(await h.run(['reload'])).toBe(exit);
    expect(h.out()).toEqual({ error: { code, message: `reload failed with ${code}` } });
  });
});

describe('verify-bundle', () => {
  it('exits 0 for clean output, 1 listing files that carry the marker, and 2 for a missing path', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ironbird-verify-cli-'));
    await writeFile(path.join(temp, 'clean.js'), 'ok');
    await writeFile(path.join(temp, 'dirty.js'), ['__IRONBIRD', 'BRIDGE', 'v1__'].join('_'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { run } = buildProgram({ cwd: temp, env: {}, isTTY: false, stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t), version: '0.0.0-test', signal: AbortSignal.abort() });
    expect(await run(['verify-bundle', 'clean.js'])).toBe(0);
    expect(JSON.parse(stdout.splice(0).join(''))).toEqual({ scanned: 1, found: [] });
    expect(await run(['verify-bundle', '.'])).toBe(1);
    expect(JSON.parse(stdout.splice(0).join(''))).toEqual({ scanned: 2, found: [{ file: 'dirty.js', offset: 0 }] });
    expect(await run(['verify-bundle', 'nope'])).toBe(2);
    expect(stderr.join('')).toContain('No such file or directory');
    await rm(temp, { recursive: true, force: true });
  });
});

describe('scenario run', () => {
  let dir: string;
  const described = { app: { id: 'a', platform: 'headless' }, commands: {}, fakes: {}, capabilities: ['settle', 'events', 'clock', 'reset'] };
  // The expect step reads order.totalCents; artifact collection reads the root.
  const getState = (params: Record<string, unknown>) => (params['path'] === '' ? { rev: 1, path: '', value: {} } : { rev: 1, path: 'order.totalCents', value: 0 });
  const collection = { events: { events: [], nextSeq: 0, truncated: false }, getState, reset: () => ({ rev: 0, path: '', value: {} }) };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenario-cli-'));
    await mkdir(path.join(dir, 'scenarios'));
    await writeFile(path.join(dir, 'scenarios/b-fails.yaml'), 'name: B fails\nsteps:\n  - expect: order.totalCents\n    equals: 4500\n');
    await writeFile(path.join(dir, 'scenarios/a-passes.yml'), 'name: A passes\nsteps:\n  - send: cart.clear\n');
    await writeFile(path.join(dir, 'broken.yaml'), 'name: Broken\nsteps:\n  - send: cart.clear\n    payloads: {}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('expands a directory in name order, prints one JSON line per scenario, and exits 4 when any scenario fails', async () => {
    const h = harness({ describe: described, dispatch: step(), ...collection }, { cwd: dir });
    expect(await h.run(['scenario', 'run', 'scenarios', '--target', 'headless'])).toBe(4);
    const lines = h.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line['scenario'], line['passed'], line['file']])).toEqual([
      ['A passes', true, path.join(dir, 'scenarios/a-passes.yml')],
      ['B fails', false, path.join(dir, 'scenarios/b-fails.yaml')],
    ]);
    expect(lines[1]).toMatchObject({ target: 'headless', stepsRun: 1, failedStep: { index: 0, step: { expect: 'order.totalCents', equals: 4500 }, expected: { equals: 4500 }, actual: 0 } });
    expect(String(lines[0]?.['artifacts']).startsWith(path.join(dir, '.ironbird/runs/'))).toBe(true);
    expect(h.calls[0]).toEqual({ op: 'describe', params: {}, target: 'headless' });
    // Each file's own describe is followed by a reset, before that file's first step.
    const describeIndices = h.calls.flatMap((call, index) => (call.op === 'describe' ? [index] : []));
    expect(describeIndices).toHaveLength(2);
    for (const index of describeIndices) expect(h.calls[index + 1]).toEqual({ op: 'reset', params: {}, target: 'headless' });
  });

  it('--bail stops after the first failed scenario', async () => {
    const h = harness({ describe: described, ...collection }, { cwd: dir });
    expect(await h.run(['scenario', 'run', 'scenarios/b-fails.yaml', 'scenarios/b-fails.yaml', '--bail'])).toBe(4);
    expect(h.stdout).toHaveLength(1);
    const all = harness({ describe: described, ...collection }, { cwd: dir });
    expect(await all.run(['scenario', 'run', 'scenarios/b-fails.yaml', 'scenarios/b-fails.yaml'])).toBe(4);
    expect(all.stdout).toHaveLength(2);
  });

  it('exits 2 with INVALID_SCENARIO before running anything when any file is invalid', async () => {
    const h = harness({ describe: described }, { cwd: dir });
    expect(await h.run(['scenario', 'run', 'scenarios', 'broken.yaml'])).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.out()).toEqual({ error: { code: 'INVALID_SCENARIO', message: `Invalid scenario ${path.join(dir, 'broken.yaml')}:4: steps.0.payloads: unknown key payloads`, details: { file: path.join(dir, 'broken.yaml'), issues: [{ path: ['steps', 0, 'payloads'], message: 'unknown key payloads', line: 4 }] } } });
    const missing = harness({ describe: described }, { cwd: dir });
    expect(await missing.run(['scenario', 'run', 'nope.yaml'])).toBe(2);
    expect(missing.out()).toMatchObject({ error: { code: 'INVALID_SCENARIO' } });
  });

  it('exits with the describe error code and prints no result when the first describe fails', async () => {
    const h = harness({ describe: new IronbirdError('NO_TARGET', 'No target is connected or configured', { available: [] }) }, { cwd: dir });
    expect(await h.run(['scenario', 'run', 'scenarios/a-passes.yml'])).toBe(5);
    expect(h.stdout).toHaveLength(1);
    expect(h.out()).toEqual({ error: { code: 'NO_TARGET', message: 'No target is connected or configured', details: { available: [] } } });
    const unauthorized = harness({ describe: new IronbirdError('UNAUTHORIZED', 'Token missing or wrong') }, { cwd: dir });
    expect(await unauthorized.run(['scenario', 'run', 'scenarios/a-passes.yml'])).toBe(2);
  });

  it('prints a summary per scenario in a TTY and JSON lines with --json', async () => {
    const h = harness({ describe: described, dispatch: step(), ...collection }, { cwd: dir, isTTY: true });
    expect(await h.run(['scenario', 'run', 'scenarios'])).toBe(4);
    expect(h.stdout[0]).toMatch(/^PASS A passes {2}headless {2}1 steps {2}\d+ ms {2}\.ironbird\/runs\/\S+-a-passes\n$/);
    expect(h.stdout[1]).toMatch(/^FAIL B fails {2}headless {2}1 steps {2}\d+ ms {2}\.ironbird\/runs\/\S+-b-fails\n {2}step 0: {"expect":"order\.totalCents","equals":4500}\n {2}expected: {"equals":4500}\n {2}actual: 0\n$/);
    h.stdout.length = 0;
    expect(await h.run(['scenario', 'run', 'scenarios/a-passes.yml', '--json'])).toBe(0);
    expect(JSON.parse(h.stdout[0] ?? '')).toMatchObject({ scenario: 'A passes', passed: true });
  });
});

describe('mcp', () => {
  function mcpHarness(serve: (options: McpServerOptions) => Promise<void>) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const created: Array<{ url: string; token?: string }> = [];
    const { run } = buildProgram({
      cwd: '/tmp/nowhere',
      env: {},
      isTTY: false,
      stdout: (t) => stdout.push(t),
      stderr: (t) => stderr.push(t),
      version: '0.0.0-test',
      createClient: (options) => {
        created.push(options);
        return { url: options.url } as DaemonClient;
      },
      mcp: serve,
      signal: AbortSignal.abort(),
    });
    return { run, stdout, stderr, created };
  }

  it('serves with the package version and working directory, and resolves the daemon on every tool call, never at start', async () => {
    let served: McpServerOptions | undefined;
    const h = mcpHarness(async (options) => {
      served = options;
    });
    expect(await h.run(['mcp', '--daemon', 'http://127.0.0.1:9999', '--token', 'secret'])).toBe(0);
    expect(h.stdout).toEqual([]);
    if (!served) throw new Error('mcp was not served');
    expect(served).toMatchObject({ version: '0.0.0-test', cwd: '/tmp/nowhere' });
    expect(h.created).toEqual([]);
    const first = await served.resolve();
    await served.resolve();
    expect(h.created).toEqual([
      { url: 'http://127.0.0.1:9999', token: 'secret' },
      { url: 'http://127.0.0.1:9999', token: 'secret' },
    ]);
    expect(first.artifactsDir).toBe(path.resolve('/tmp/nowhere', '.ironbird'));
  });

  it('reports a start-up failure on stderr, never stdout, and exits 1', async () => {
    const h = mcpHarness(async () => {
      throw new Error('stdin is not readable');
    });
    expect(await h.run(['mcp'])).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join('')).toContain('ironbird mcp: stdin is not readable');
  });
});

describe('agent setup', () => {
  let dir: string;
  const packaged = path.resolve(__dirname, '../../skills/ironbird');

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-agent-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs the packaged skill and registers the server without a daemon', async () => {
    const h = harness({}, { cwd: dir });
    expect(await h.run(['agent', 'setup'])).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out()).toEqual({
      skill: { dir: path.join(dir, '.claude/skills/ironbird'), files: ['SKILL.md', 'references/scenarios.md'] },
      mcp: { file: path.join(dir, '.mcp.json'), updated: true },
    });
    expect(await readFile(path.join(dir, '.claude/skills/ironbird/SKILL.md'), 'utf8')).toBe(await readFile(path.join(packaged, 'SKILL.md'), 'utf8'));
    expect(JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { ironbird: { command: 'npx', args: ['ironbird', 'mcp'] } } });
  });

  it('takes --skills-dir', async () => {
    const h = harness({}, { cwd: dir });
    expect(await h.run(['agent', 'setup', '--skills-dir', '.agents/skills'])).toBe(0);
    expect(h.out()).toMatchObject({ skill: { dir: path.join(dir, '.agents/skills/ironbird') } });
  });

  it('exits 2 with INVALID_CONFIG and writes nothing when .mcp.json is not an object', async () => {
    await writeFile(path.join(dir, '.mcp.json'), '[]');
    const h = harness({}, { cwd: dir });
    expect(await h.run(['agent', 'setup'])).toBe(2);
    expect(h.out()).toMatchObject({ error: { code: 'INVALID_CONFIG', details: { file: path.join(dir, '.mcp.json') } } });
    await expect(stat(path.join(dir, '.claude'))).rejects.toThrow();
  });
});
