import { IronbirdError } from '@ironbird/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonClient, type DaemonClient } from '../cli/client';
import { createMcpServer, type McpServerOptions } from './server';

interface Call {
  op: string;
  params: Record<string, unknown>;
  target: string | undefined;
}

type Responder = unknown | ((params: Record<string, unknown>) => unknown);

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/** A daemon client that answers from `responses` by op and records every call; an `Error` response is thrown. */
function scriptedClient(responses: Record<string, Responder>, calls: Call[]): DaemonClient {
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
      return (await client.call(op, params, target)).result as never;
    },
    async stream() {},
  };
  return client;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Connects an SDK client to a fresh server over an in-memory pair. `artifactsDir` is what `resolve` reports. */
async function connect(responses: Record<string, Responder>, options: Partial<McpServerOptions> & { artifactsDir?: string } = {}) {
  const calls: Call[] = [];
  let resolves = 0;
  const client = scriptedClient(responses, calls);
  const { artifactsDir = '/tmp/nowhere/.ironbird', ...overrides } = options;
  const server = createMcpServer({
    version: '0.0.0-test',
    cwd: '/tmp/nowhere',
    resolve: async () => {
      resolves += 1;
      return { client, artifactsDir };
    },
    ...overrides,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'ironbird-test', version: '0.0.0' });
  await server.connect(serverSide);
  await mcp.connect(clientSide);
  cleanups.push(async () => {
    await mcp.close();
    await server.close();
  });
  return {
    mcp,
    calls,
    resolves: () => resolves,
    call: async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => (await mcp.callTool({ name, arguments: args })) as unknown as ToolResult,
  };
}

/** Parses the first content block, which every tool result has, as JSON. */
function json(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== 'text' || first.text === undefined) throw new Error(`expected a text block first, got ${JSON.stringify(first)}`);
  return JSON.parse(first.text) as Record<string, unknown>;
}

const settled = { idle: true, quiescent: false, waitedMs: 1, pending: [] };
const step = (overrides: Record<string, unknown> = {}) => ({ target: 'headless', rev: 1, path: '', state: {}, events: [], settle: settled, ...overrides });

const DAEMON_TOOLS = [
  'ironbird_status',
  'ironbird_describe',
  'ironbird_send',
  'ironbird_state',
  'ironbird_wait',
  'ironbird_settle',
  'ironbird_fake',
  'ironbird_fake_calls',
  'ironbird_events',
  'ironbird_clock_advance',
  'ironbird_clock_now',
  'ironbird_reset',
  'ironbird_reload',
];

describe('createMcpServer', () => {
  it('names itself ironbird with the package version and lists the daemon tools without contacting the daemon', async () => {
    const h = await connect({});
    expect(h.mcp.getServerVersion()).toMatchObject({ name: 'ironbird', version: '0.0.0-test' });
    const { tools } = await h.mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...DAEMON_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/\S/);
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
    expect(h.resolves()).toBe(0);
  });

  it('returns one text block holding the result as JSON', async () => {
    const status = { version: '1.2.3', protocol: 1, uptimeMs: 5, targets: [] };
    const h = await connect({ status });
    const result = await h.call('ironbird_status');
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(json(result)).toEqual(status);
    expect(h.calls).toEqual([{ op: 'status', params: {}, target: undefined }]);
  });

  it('maps each daemon tool to its operation with the CLI defaults and returns what the CLI prints', async () => {
    const h = await connect({
      describe: { app: { id: 'a', platform: 'headless' }, commands: {}, fakes: {}, capabilities: ['reset'] },
      dispatch: step({ path: 'cart' }),
      getState: { rev: 2, path: 'cart', value: { items: [] } },
      settle: settled,
      fakeControl: step(),
      fakeCalls: { calls: [], nextSeq: 4, truncated: false },
      events: { events: [], nextSeq: 7, truncated: false },
      clockAdvance: { ...step(), now: 1_300 },
      clockNow: { now: 1_300 },
      reset: { rev: 0, path: '', value: {} },
      reload: { rev: 0 },
    });
    expect(json(await h.call('ironbird_describe', { target: 'headless' }))).toMatchObject({ target: 'headless', capabilities: ['reset'] });
    expect(json(await h.call('ironbird_send', { command: 'cart.addItem', payload: { sku: 'x' }, path: 'cart', settle: { timeoutMs: 200 } }))).toMatchObject({ target: 'headless', path: 'cart' });
    await h.call('ironbird_send', { command: 'cart.clear' });
    expect(json(await h.call('ironbird_state', { path: 'cart' }))).toEqual({ target: 'headless', rev: 2, path: 'cart', value: { items: [] } });
    expect(json(await h.call('ironbird_settle', { timeoutMs: 50 }))).toEqual({ target: 'headless', ...settled });
    await h.call('ironbird_fake', { fake: 'api', control: 'emit', payload: { event: 'x' }, settle: false });
    expect(json(await h.call('ironbird_fake_calls', { fake: 'api', since: 3, limit: 10 }))).toEqual({ target: 'headless', fake: 'api', calls: [], nextSeq: 4, truncated: false });
    expect(json(await h.call('ironbird_events', { since: 2 }))).toEqual({ target: 'headless', events: [], nextSeq: 7, truncated: false });
    expect(json(await h.call('ironbird_clock_advance', { ms: 300, path: 'payment' }))).toMatchObject({ target: 'headless', now: 1_300 });
    expect(json(await h.call('ironbird_clock_advance', { ms: 100, target: 'headless' }))).toMatchObject({ target: 'headless', now: 1_300 });
    expect(json(await h.call('ironbird_clock_now'))).toEqual({ target: 'headless', now: 1_300 });
    expect(json(await h.call('ironbird_clock_now', { target: 'headless' }))).toEqual({ target: 'headless', now: 1_300 });
    expect(json(await h.call('ironbird_reset', { target: 'headless' }))).toEqual({ target: 'headless', rev: 0, path: '', value: {} });
    expect(json(await h.call('ironbird_reload', { target: 'ios', timeoutMs: 90_000 }))).toEqual({ target: 'ios', rev: 0 });
    expect(h.calls).toEqual([
      { op: 'describe', params: {}, target: 'headless' },
      { op: 'dispatch', params: { name: 'cart.addItem', payload: { sku: 'x' }, path: 'cart', settle: { timeoutMs: 200 } }, target: undefined },
      { op: 'dispatch', params: { name: 'cart.clear', payload: {}, path: '', settle: true }, target: undefined },
      { op: 'getState', params: { path: 'cart' }, target: undefined },
      { op: 'settle', params: { timeoutMs: 50 }, target: undefined },
      { op: 'fakeControl', params: { fake: 'api', control: 'emit', payload: { event: 'x' }, path: '', settle: false }, target: undefined },
      { op: 'fakeCalls', params: { fake: 'api', since: 3, limit: 10 }, target: undefined },
      { op: 'events', params: { since: 2 }, target: undefined },
      { op: 'clockAdvance', params: { ms: 300, path: 'payment', settle: true }, target: undefined },
      { op: 'clockAdvance', params: { ms: 100, path: '', settle: true }, target: 'headless' },
      { op: 'clockNow', params: {}, target: undefined },
      { op: 'clockNow', params: {}, target: 'headless' },
      { op: 'reset', params: {}, target: 'headless' },
      { op: 'reload', params: { timeoutMs: 90_000 }, target: 'ios' },
    ]);
  });

  it('turns a daemon error into an isError result holding the CLI error JSON', async () => {
    const h = await connect({ dispatch: new IronbirdError('UNKNOWN_COMMAND', 'Unknown command cart.ad', { name: 'cart.ad', suggestions: ['cart.addItem'] }) });
    const result = await h.call('ironbird_send', { command: 'cart.ad' });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(json(result)).toEqual({ error: { code: 'UNKNOWN_COMMAND', message: 'Unknown command cart.ad', details: { name: 'cart.ad', suggestions: ['cart.addItem'] } } });
  });

  it('says to start ironbird serve when no daemon answers', async () => {
    const h = await connect({}, { resolve: async () => ({ client: createDaemonClient({ url: 'http://127.0.0.1:1' }), artifactsDir: '/tmp/nowhere/.ironbird' }) });
    const result = await h.call('ironbird_status');
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ error: { code: 'NO_TARGET', details: { url: 'http://127.0.0.1:1' } } });
    expect(result.content[0]?.text).toContain('ironbird serve');
  });

  it('finds the daemon again on every call, so a restarted daemon needs no MCP restart', async () => {
    const first: Call[] = [];
    const second: Call[] = [];
    const clients = [scriptedClient({ clockNow: { now: 1 } }, first), scriptedClient({ clockNow: { now: 2 } }, second)];
    let resolved = 0;
    const h = await connect({}, {
      resolve: async () => {
        const client = clients[Math.min(resolved, 1)] as DaemonClient;
        resolved += 1;
        return { client, artifactsDir: '/tmp/nowhere/.ironbird' };
      },
    });
    expect(json(await h.call('ironbird_clock_now'))).toMatchObject({ now: 1 });
    expect(json(await h.call('ironbird_clock_now'))).toMatchObject({ now: 2 });
    expect([first.length, second.length]).toEqual([1, 1]);
  });

  it('ironbird_wait sends exactly one condition, defaults the timeout to 5000 ms, and keeps null as a value', async () => {
    const h = await connect({ waitFor: { rev: 3, path: 'order.orderId', value: null, waitedMs: 0 } });
    expect(json(await h.call('ironbird_wait', { path: 'order.orderId', equals: null }))).toEqual({ target: 'headless', rev: 3, path: 'order.orderId', value: null, waitedMs: 0 });
    await h.call('ironbird_wait', { path: 'order.status', matches: '^comp', timeoutMs: 250, target: 'ios' });
    expect(h.calls).toEqual([
      { op: 'waitFor', params: { path: 'order.orderId', equals: null, timeoutMs: 5_000 }, target: undefined },
      { op: 'waitFor', params: { path: 'order.status', matches: '^comp', timeoutMs: 250 }, target: 'ios' },
    ]);
  });

  it('rejects input that fails a tool schema before looking up the daemon', async () => {
    const h = await connect({});
    const none = await h.call('ironbird_wait', { path: 'order.status' });
    const two = await h.call('ironbird_wait', { path: 'order.status', equals: 'a', exists: true });
    const badSettle = await h.call('ironbird_send', { command: 'x', settle: 'yes' });
    const noMs = await h.call('ironbird_clock_advance', {});
    const zeroReload = await h.call('ironbird_reload', { timeoutMs: 0 });
    const hugeReload = await h.call('ironbird_reload', { timeoutMs: 2_147_483_648 });
    for (const result of [none, two, badSettle, noMs, zeroReload, hugeReload]) expect(result.isError).toBe(true);
    expect(zeroReload.content[0]?.text).toContain('Input validation error');
    expect(hugeReload.content[0]?.text).toContain('Input validation error');
    expect(none.content[0]?.text).toContain('exactly one of equals, notEquals, exists, matches');
    expect(two.content[0]?.text).toContain('exactly one of equals, notEquals, exists, matches');
    expect(h.calls).toEqual([]);
    expect(h.resolves()).toBe(0);
  });
});
