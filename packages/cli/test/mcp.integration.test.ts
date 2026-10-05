import { IronbirdError, type ScenarioResult } from '@ironbird/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import headless from '../../../examples/checkout/src/ironbird/headless';
import { createDaemonClient } from '../src/cli/client';
import { startDaemon, type Daemon } from '../src/daemon';
import type { DaemonTarget } from '../src/daemon-target';
import { createHeadlessTarget, type HeadlessTarget } from '../src/headless-target';
import { createMcpServer } from '../src/mcp/server';

// Spec §8, CLI integration: the MCP server driven by the SDK's client over an in-memory pair,
// against a daemon hosting the example headless app, plus a stand-in iOS app whose screenshots
// come from a stub capture. The last test runs the built binary over real stdio.
const example = path.resolve(__dirname, '../../../examples/checkout');
const bin = path.resolve(__dirname, '../dist/bin.js');
const CLOCK_START = '2026-01-01T00:00:00.000Z';
// A 1x1 PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/** A connected app that answers `dispatch` like a settled step; enough for `step`. */
function fakeIos(): DaemonTarget {
  return {
    id: 'ios',
    info: () => ({ id: 'ios', platform: 'ios', appId: 'com.example.checkout', connectedAt: 1, rev: 3 }),
    async run(op) {
      if (op === 'dispatch') return { target: 'ios', rev: 4, path: '', state: {}, events: [], settle: { idle: true, quiescent: false, waitedMs: 1, pending: [] } };
      throw new IronbirdError('UNSUPPORTED', `The stand-in app has no ${op}`, { op, target: 'ios' });
    },
    onEvent: () => () => {},
    onState: () => () => {},
    dispose: async () => {},
  };
}

const capture = {
  resolveDevice: async ({ platform }: { platform: 'ios' | 'android' }) => ({ platform, id: 'SIM-1' }),
  capture: async ({ outPath }: { outPath: string }) => {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, Buffer.from(PNG_BASE64, 'base64'));
  },
};

let artifacts: string;
let target: HeadlessTarget;
let daemon: Daemon;
let mcp: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await mcp.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function json<T = Record<string, unknown>>(result: ToolResult): T {
  const first = result.content[0];
  if (first?.type !== 'text' || first.text === undefined) throw new Error(`expected a text block first, got ${JSON.stringify(first)}`);
  return JSON.parse(first.text) as T;
}

beforeAll(async () => {
  artifacts = await mkdtemp(path.join(tmpdir(), 'ironbird-mcp-'));
  target = await createHeadlessTarget({
    definition: headless,
    // Plan 1: with a loader, the headless target declares `reload`.
    loadDefinition: async () => headless,
    appId: 'com.example.checkout',
    clockStart: CLOCK_START,
    settleTimeoutMs: 5_000,
    env: {},
    log: () => {},
    entryPath: path.join(example, 'src/ironbird/headless.ts'),
  });
  daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, targets: [fakeIos()], defaultTarget: 'headless', artifactsPath: artifacts, capture, log: () => {} });
  const server = createMcpServer({ version: '0.0.0-test', cwd: example, resolve: async () => ({ client: createDaemonClient({ url: daemon.url }), artifactsDir: artifacts }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: 'ironbird-mcp-test', version: '0.0.0' });
  await server.connect(serverSide);
  await mcp.connect(clientSide);
}, 30_000);

afterAll(async () => {
  await mcp.close();
  await daemon.close();
  await target.dispose();
  await rm(artifacts, { recursive: true, force: true });
});

describe('the MCP server against the example app', () => {
  it('drives the headless app through every daemon tool', async () => {
    expect(json(await call('ironbird_status'))).toMatchObject({ protocol: 1, targets: [{ id: 'headless' }, { id: 'ios' }] });
    const description = json<{ target: string; commands: Record<string, unknown>; fakes: Record<string, unknown>; capabilities: string[] }>(await call('ironbird_describe'));
    expect(description.target).toBe('headless');
    expect(Object.keys(description.commands)).toContain('cart.addItem');
    expect(Object.keys(description.fakes)).toContain('api');
    expect(description.capabilities).toEqual(expect.arrayContaining(['clock', 'reset', 'reload', 'fakes']));

    expect(json(await call('ironbird_reset'))).toMatchObject({ target: 'headless', path: '' });
    expect(json(await call('ironbird_fake', { fake: 'api', control: 'setEcho', payload: { mode: 'manual' } }))).toMatchObject({ target: 'headless' });
    expect(json(await call('ironbird_send', { command: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, path: 'cart' }))).toMatchObject({ state: { subtotalCents: 4_500 }, settle: { idle: true } });
    expect(json(await call('ironbird_send', { command: 'payment.start', payload: { method: 'saved' }, path: 'payment.status' }))).toMatchObject({ state: 'submitting' });
    expect(json(await call('ironbird_clock_advance', { ms: 300, path: 'payment.status' }))).toMatchObject({ state: 'awaitingServerEcho', now: Date.parse('2026-01-01T00:00:00.300Z') });
    expect(json(await call('ironbird_clock_now'))).toEqual({ target: 'headless', now: Date.parse('2026-01-01T00:00:00.300Z') });
    expect(json(await call('ironbird_wait', { path: 'payment.status', equals: 'awaitingServerEcho', timeoutMs: 1_000 }))).toMatchObject({ target: 'headless', value: 'awaitingServerEcho' });
    expect(json(await call('ironbird_state', { path: 'payment.status' }))).toMatchObject({ target: 'headless', path: 'payment.status', value: 'awaitingServerEcho' });
    expect(json(await call('ironbird_settle', { timeoutMs: 50 }))).toMatchObject({ target: 'headless', idle: expect.any(Boolean) });
    const calls = json<{ target: string; fake: string; calls: Array<{ method: string }> }>(await call('ironbird_fake_calls', { fake: 'api' }));
    expect(calls).toMatchObject({ target: 'headless', fake: 'api' });
    expect(calls.calls.map((c) => c.method)).toContain('submitPayment');
    expect(json<{ events: unknown[] }>(await call('ironbird_events')).events.length).toBeGreaterThan(0);

    expect(json(await call('ironbird_reload'))).toEqual({ target: 'headless', rev: expect.any(Number) });
    expect(json(await call('ironbird_state', { path: 'payment.status' }))).toMatchObject({ value: 'idle' });
  });

  it('returns device screenshots as image content', async () => {
    const stepped = await call('ironbird_step', { command: 'ui.setMotion', payload: { motion: 'reduced' }, target: 'ios' });
    expect(stepped.isError).toBeFalsy();
    const shot = json<{ target: string; screenshot: { path: string; device: string }; settledBeforeCapture: boolean }>(stepped);
    expect(shot).toMatchObject({ target: 'ios', screenshot: { device: 'SIM-1' }, settledBeforeCapture: true });
    expect(shot.screenshot.path.startsWith(path.join(artifacts, 'screenshots'))).toBe(true);
    expect(stepped.content[1]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });

    const captured = await call('ironbird_screenshot', { target: 'ios' });
    expect(json(captured)).toMatchObject({ target: 'ios', device: 'SIM-1' });
    expect(captured.content[1]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    expect((await readFile(json<{ path: string }>(captured).path)).toString('base64')).toBe(PNG_BASE64);
  });

  it('runs a scenario file and a folder, writing artifacts under the daemon artifacts directory', async () => {
    const one = json<{ results: ScenarioResult[] }>(await call('ironbird_run_scenario', { path: 'ironbird/scenarios/checkout-saved-card.yaml' }));
    expect(one.results).toHaveLength(1);
    expect(one.results[0]).toMatchObject({ scenario: 'Checkout with the saved card', target: 'headless', passed: true, file: path.join(example, 'ironbird/scenarios/checkout-saved-card.yaml') });
    expect(String(one.results[0]?.artifacts).startsWith(path.join(artifacts, 'runs'))).toBe(true);

    const all = json<{ results: ScenarioResult[] }>(await call('ironbird_run_scenario', { path: 'ironbird/scenarios' }));
    expect(all.results).toHaveLength(5);
    expect(all.results.every((result) => result.passed)).toBe(true);
  }, 60_000);

  it('returns failures as isError results holding the CLI error JSON', async () => {
    const unknown = await call('ironbird_send', { command: 'cart.nope' });
    expect(unknown.isError).toBe(true);
    expect(json(unknown)).toMatchObject({ error: { code: 'UNKNOWN_COMMAND', details: { name: 'cart.nope' } } });

    const timedOut = await call('ironbird_wait', { path: 'payment.status', equals: 'succeeded', timeoutMs: 50 });
    expect(timedOut.isError).toBe(true);
    expect(json(timedOut)).toMatchObject({ error: { code: 'WAIT_TIMEOUT', details: { path: 'payment.status' } } });

    const headlessShot = await call('ironbird_screenshot', { target: 'headless' });
    expect(json(headlessShot)).toMatchObject({ error: { code: 'UNSUPPORTED', details: { op: 'screenshot', target: 'headless' } } });

    const broken = path.join(artifacts, 'broken.yaml');
    await writeFile(broken, 'name: Broken\nsteps:\n  - send: cart.clear\n    payloads: {}\n');
    const invalid = await call('ironbird_run_scenario', { path: broken });
    expect(invalid.isError).toBe(true);
    expect(json(invalid)).toMatchObject({ error: { code: 'INVALID_SCENARIO', details: { file: broken } } });
  });
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the MCP server');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ironbird mcp over stdio', () => {
  it('starts without a daemon, writes only JSON-RPC to stdout, points at ironbird serve, and exits 0 when stdin closes', async () => {
    const port = await closedPort();
    const child = spawn('node', [bin, 'mcp', '--daemon', `http://127.0.0.1:${port}`], { cwd: example, env: { ...process.env, IRONBIRD_TOKEN: undefined }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '0.0.0' } } });
    await until(() => stdout.includes('"id":1'));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ironbird_status', arguments: {} } });
    await until(() => stdout.includes('"id":2'));
    child.stdin.end();
    expect(await exited).toBe(0);

    const messages = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { jsonrpc: string; id?: number; result?: Record<string, unknown> });
    expect(messages.every((message) => message.jsonrpc === '2.0')).toBe(true);
    expect(messages.find((message) => message.id === 1)?.result).toMatchObject({ serverInfo: { name: 'ironbird' } });
    const status = messages.find((message) => message.id === 2)?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(status.isError).toBe(true);
    expect(JSON.parse(status.content[0]?.text ?? '{}')).toMatchObject({ error: { code: 'NO_TARGET' } });
    expect(status.content[0]?.text).toContain('ironbird serve');
  }, 30_000);
});
