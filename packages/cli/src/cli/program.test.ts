import { IronbirdError } from '@ironbird/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DaemonClient } from './client';
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

function harness(responses: Record<string, Responder>, options: { isTTY?: boolean; streamFrames?: StreamFrame[]; createClient?: () => DaemonClient } = {}) {
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
    cwd: '/tmp/nowhere',
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
