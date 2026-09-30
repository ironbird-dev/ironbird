# M3 Agent Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give coding agents a stdio MCP server (`ironbird mcp`) with the sixteen tools of spec §5.1, an app-agnostic skill that teaches the reproduce, pin, fix, check, report loop, and `ironbird agent setup`, which installs the skill and registers the server in `.mcp.json`.

**Architecture:** `packages/cli/src/mcp/server.ts` builds an `McpServer` from `@modelcontextprotocol/server` 2.x. Each tool is a thin wrapper over one `DaemonClient` call, resolved lazily on every call through an injected `resolve()`, except `ironbird_run_scenario`, which runs M2's `loadScenarioFiles` and `runScenario` in process. Results are one JSON text block (the same JSON the CLI prints), plus one PNG image block for `ironbird_step` and `ironbird_screenshot`; every failure is an `isError` result holding the CLI's error JSON. `mcp/stdio.ts` serves it with `serveStdio`. The skill lives in `packages/cli/skills/ironbird/` and ships in the package; `agent/setup.ts` copies it and edits `.mcp.json`. Both commands are wired into `program.ts` and loaded on demand.

**Tech Stack:** `@modelcontextprotocol/server` ^2.2.0 (new dependency), `@modelcontextprotocol/client` ^2.2.0 (new dev dependency, tests only), `zod` 4 (already a cli dependency), `commander` 15, `yaml` 2.9 (front matter in tests), `node:fs/promises`, Vitest 5 `unit` and `serial` projects, `pnpm pack` for the packaging test.

**Spec:** [docs/superpowers/specs/2026-09-29-m3-agent-interface-design.md](../specs/2026-09-29-m3-agent-interface-design.md) §5, §6, and the matching rows of §8 (CLI unit tests for `agent setup`, the MCP integration test, the packaging test). Cross-plan names: [.superpowers/sdd/m3-contract.md](../../../.superpowers/sdd/m3-contract.md) (not committed), "Plan 2: agent interface".

**Prerequisites:** Plan 1 (`2026-09-29-m3-reload.md`) is implemented first. This plan consumes it only through the wire: the daemon op `reload` with params `{ timeoutMs? }` and result `{ rev }`, the target in the envelope. Task 3's integration test also passes Plan 1's `HeadlessTargetOptions.loadDefinition` so the headless target declares `reload`, and Task 4's skill names `npx ironbird reload`. If Plan 1 has not landed, Tasks 1 and 2 still pass (their tests script the daemon), and Task 3's reload assertions fail with `UNSUPPORTED`.

## Verified SDK facts

Checked on 2026-09-29 with `npm view` and the SDK v2 docs (context7 `/websites/ts_sdk_modelcontextprotocol_io_v2`):

| Fact | Value |
|---|---|
| Latest versions | `@modelcontextprotocol/server` 2.2.0, `@modelcontextprotocol/client` 2.2.0, both depending on `@modelcontextprotocol/core` 2.2.0 and `zod ^4.2.0` |
| Server class | `import { McpServer } from '@modelcontextprotocol/server'`; `new McpServer({ name, version })` |
| Tool registration | `server.registerTool(name, { description, inputSchema: z.object({...}) }, async (args) => ({ content: [...], isError? }))`; the args are typed from the Zod 4 object |
| Stdio | `import { serveStdio } from '@modelcontextprotocol/server/stdio'`; `serveStdio(() => server)` returns a `StdioServerHandle` whose `close(): Promise<void>` tears the connection down |
| In-process test pair | `import { Client, InMemoryTransport } from '@modelcontextprotocol/client'`; `const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()`; `await server.connect(serverSide)`; `await client.connect(clientSide)`. Import both halves from one package |
| Client calls | `client.listTools()` returns `{ tools }` with `name`, `description`, `inputSchema`; `client.callTool({ name, arguments })` returns `{ content, isError? }`; tool-level failures come back as results, never as throws |
| Schema failures | Arguments that fail `inputSchema` never reach the handler; the SDK returns `{ isError: true, content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool <name>: ...' }] }` |
| Image content | `{ type: 'image', data: <base64>, mimeType: 'image/png' }` |
| Zod | `import { z } from 'zod'` resolves to Zod 4 in this repo (4.6.2 installed). `.refine()` on `z.object` still returns a `ZodObject` (checked in Node), so it is a valid `inputSchema`, and the SDK runs the refinement when it validates |

If `listTools` ever fails with a "does not support tools" error, pass `{ capabilities: { tools: {} } }` as `McpServer`'s second argument; the docs show both forms.

## Global Constraints

Copied from [AGENTS.md](../../../AGENTS.md) hard rules:

1. `@ironbird/core` imports only `zod`. No `react-native`, no `node:*` modules, no DOM or browser globals. It must run unmodified in Node and Hermes. Lint enforces this.
2. No arbitrary code execution anywhere. No `eval`, no `new Function`, and no protocol operation that runs caller-supplied code. Agents act only through declared commands and fake controls ([ADR-0001](../../adr/0001-commands-only-agent-surface.md)).
3. The bridge stays dev-only. `startBridge` must no-op when `__DEV__` is false unless `allowInNonDevBuilds` is set, and the bridge marker must stay referenced in the `hello` message so `ironbird verify-bundle` can detect it after minification. The marker constant is defined in `@ironbird/react-native` and nowhere else: `@ironbird/core` ships in release bundles, so the string must not appear in it or in any other package.
4. Validate every payload where it is applied, including inside the app. Never trust the daemon.
5. Protocol changes update [docs/protocol.md](../../protocol.md) in the same PR. Breaking changes bump `PROTOCOL_VERSION` and need an ADR.
6. Public API or CLI changes update [docs/api.md](../../api.md) or [docs/cli.md](../../cli.md) in the same PR and include a changeset.
7. New runtime dependencies in `core` or `react-native` need an ADR. New dependencies in `cli` need a one-line justification in the PR.
8. Errors that cross a package boundary are `IronbirdError` with a code from the protocol error table. No bare string throws.
9. Headless determinism is a feature. Library code and example app logic take time from the injected `Clock`, never from global `setTimeout`, `setInterval`, or `Date.now`. The bridge is library code too: it uses the `Clock` passed to `startBridge`, which defaults to the real clock. `requestAnimationFrame` is a rendering signal rather than a clock and may be used directly. Inside `@ironbird/core`, `clock.ts` and `scheduler.ts` are the only files that may use global timers or `Date.now`, and lint enforces that.

From the spec and the conventions:

- No protocol change in this plan: the MCP server calls existing operations and plan 1's `reload`. No new error codes (spec §9); MCP failures carry the existing `ErrorShape` unchanged.
- MCP tools take durations in milliseconds; only the CLI accepts `ms`, `s`, and `m` suffixes.
- Nothing is written to stdout by `ironbird mcp` except MCP messages; diagnostics go to stderr (spec §5).
- The server's name is `ironbird` and its version is the package version (spec §5).
- The skill never names the example app, its commands, its fakes, or the race (spec D7). Tool descriptions reach the eval agent too, so they are app-agnostic as well.
- `SKILL.md` stays under 200 lines (spec §6.1).
- `.mcp.json` entry, exactly: `{ "command": "npx", "args": ["ironbird", "mcp"] }`, written with two-space indentation and a trailing newline (spec §6.2).
- Dependency justification line for the PR, verbatim from spec §5.2: "`@modelcontextprotocol/server`: the official MCP server SDK, which ironbird needs to speak MCP, and whose v2 server package adds only its own core and the `zod` the CLI already uses. `@modelcontextprotocol/client` is a dev dependency for the integration test."
- Named exports only. Commit messages are plain imperative subjects with no attribution trailers. Never commit `.superpowers/`.
- Packages import each other from `dist`: run `pnpm build` before typechecking or running the serial tests whenever a package the test imports changed, and `pnpm --filter @ironbird/cli build` before any test that spawns `packages/cli/dist/bin.js`.

## Review Focus

The inputs the spec implies but no spec test names, most likely to bite first. Each has a test in the task that owns the code.

1. **The daemon restarts, or starts after the MCP server.** An agent starts `ironbird serve` after its session began, or restarts it on a new port. The next tool call must find it without restarting the MCP server (Task 1, "finds the daemon again on every call").
2. **An agent calls `ironbird_wait` with zero or two conditions, or with `equals: null`.** Zero or two must be rejected before any daemon call, with a message naming the four keys; `null` is a real value to wait for and must reach the daemon (Task 1).
3. **The screenshot file can't be read after a step was applied.** The step already changed the app, so the result must stay a success, carrying the step JSON and a note instead of the image; an error would invite a retry that applies the step twice (Task 2).
4. **`ironbird_run_scenario` gets a path that doesn't exist, a folder with no scenario files, or a relative path.** Relative paths resolve against the server's working directory; the other two are `INVALID_SCENARIO` `isError` results returned before the daemon is looked up (Task 2).
5. **`.mcp.json` is valid JSON but `mcpServers` is not an object** (an array, a string). Writing the entry would destroy the user's servers, so it fails with `INVALID_CONFIG`, details `{ file, issues: [{ path: ['mcpServers'], message }] }`, and writes nothing, like a non-object file (Task 5).

---

## File Structure

```text
packages/cli/
  package.json                      @modelcontextprotocol/server dep, @modelcontextprotocol/client devDep, "skills" in files
  skills/ironbird/SKILL.md          the skill: front matter and the six-step loop
  skills/ironbird/references/scenarios.md   condensed scenario file reference
  src/cli/output.ts                 withTarget moves here from program.ts
  src/cli/helpers.test.ts           withTarget test
  src/cli/program.ts                mcp and agent setup commands; ProgramIo.mcp
  src/cli/program.test.ts           mcp and agent setup tests
  src/mcp/server.ts                 createMcpServer, McpServerOptions, the 16 tools
  src/mcp/server.test.ts            tools against a scripted DaemonClient over InMemoryTransport
  src/mcp/stdio.ts                  runMcpStdio
  src/agent/setup.ts                agentSetup, findPackageRoot, AgentSetupOptions, AgentSetupResult
  src/agent/setup.test.ts
  src/agent/skill.test.ts           front matter, length, loop coverage, D7 leak check
  src/index.ts                      new exports
  test/mcp.integration.test.ts      serial: real daemon + example headless app; stdio child process
  test/package.integration.test.ts  serial: SKILL.md ships in the packed tarball
docs/agents.md                      new: agent setup documentation
docs/cli.md                         mcp, MCP tools, agent setup
docs/api.md                         @ironbird/cli exports
docs/architecture.md                §12 row for D4
.changeset/m3-agent-interface.md
```

---

### Task 1: The MCP server and its daemon tools

Thirteen of the sixteen tools: every tool that is one daemon call returning JSON. Images and scenarios follow in Task 2.

**Files:**
- Modify: `packages/cli/package.json` (through `pnpm add`), `pnpm-lock.yaml`
- Modify: `packages/cli/src/cli/output.ts` (add `withTarget`)
- Modify: `packages/cli/src/cli/helpers.test.ts`
- Modify: `packages/cli/src/cli/program.ts` (use the shared `withTarget`)
- Create: `packages/cli/src/mcp/server.ts`
- Create: `packages/cli/src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `DaemonClient` (`call<T>(op, params?, target?) => Promise<{ target?: string; result: T }>`, `rpc<T>(op, params?, target?) => Promise<T>`) and `createDaemonClient({ url, token? })` from `packages/cli/src/cli/client.ts`; `toErrorShape`, `Description`, `FakeCallsResult`, `SettleResult`, `StepResult`, `IronbirdError` from `@ironbird/core`. The daemon op `reload` (plan 1): params `{ timeoutMs? }`, result `{ rev }`, target in the envelope.
- Produces:
  - `export function withTarget(envelope: { target?: string; result: unknown }): Record<string, unknown>` in `packages/cli/src/cli/output.ts`.
  - `export interface McpServerOptions { version: string; cwd: string; resolve: () => Promise<{ client: DaemonClient; artifactsDir: string }>; readImage?: (path: string) => Promise<Buffer> }` and `export function createMcpServer(options: McpServerOptions): McpServer` in `packages/cli/src/mcp/server.ts`, registering `ironbird_status`, `ironbird_describe`, `ironbird_send`, `ironbird_state`, `ironbird_wait`, `ironbird_settle`, `ironbird_fake`, `ironbird_fake_calls`, `ironbird_events`, `ironbird_clock_advance`, `ironbird_clock_now`, `ironbird_reset`, `ironbird_reload`.
  - In `server.ts`, module-private: `type Content`, `type ToolResult`, `success(value, ...more)`, `failure(error)`, `guard(work)`, and the shared Zod fields `target`, `statePath`, `settle`, `payload`, `cursor(what)`, `limit`. Task 2 uses all of them.
  - In `server.test.ts`: `scriptedClient(responses, calls)`, `connect(responses, options)`, `json(result)`, `step(overrides)`, `settled`. Task 2 adds tests to this file and uses them.

- [ ] **Step 1: Add the dependencies**

Run:

```sh
pnpm --filter @ironbird/cli add @modelcontextprotocol/server@^2.2.0
pnpm --filter @ironbird/cli add -D @modelcontextprotocol/client@^2.2.0
```

Expected: `packages/cli/package.json` gains `"@modelcontextprotocol/server": "^2.2.0"` under `dependencies` and `"@modelcontextprotocol/client": "^2.2.0"` under `devDependencies`, and `pnpm-lock.yaml` changes. If core's `dist` predates plan 1, run `pnpm build` once now.

- [ ] **Step 2: Write the failing `withTarget` test**

In `packages/cli/src/cli/helpers.test.ts`, change the output import to:

```ts
import { createOutput, withTarget } from './output';
```

and add at the end of the file:

```ts
describe('withTarget', () => {
  it('adds the envelope target unless the result already carries one', () => {
    expect(withTarget({ target: 'headless', result: { rev: 1 } })).toEqual({ target: 'headless', rev: 1 });
    expect(withTarget({ target: 'headless', result: { target: 'ios', rev: 1 } })).toEqual({ target: 'ios', rev: 1 });
    expect(withTarget({ result: { version: '1' } })).toEqual({ version: '1' });
  });
});
```

- [ ] **Step 3: Write the failing MCP server tests**

Create `packages/cli/src/mcp/server.test.ts`:

```ts
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
    for (const result of [none, two, badSettle, noMs, zeroReload]) expect(result.isError).toBe(true);
    expect(zeroReload.content[0]?.text).toContain('Input validation error');
    expect(none.content[0]?.text).toContain('exactly one of equals, notEquals, exists, matches');
    expect(two.content[0]?.text).toContain('exactly one of equals, notEquals, exists, matches');
    expect(h.calls).toEqual([]);
    expect(h.resolves()).toBe(0);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/helpers.test.ts packages/cli/src/mcp/server.test.ts`
Expected: FAIL. `helpers.test.ts`: `withTarget is not a function` (or a missing export). `server.test.ts`: `Failed to resolve import "./server"`.

- [ ] **Step 5: Move `withTarget` into `output.ts`**

Append to `packages/cli/src/cli/output.ts`:

```ts
/**
 * The daemon's `result` with the envelope's `target` added when the result does not carry one,
 * which is what the CLI and the MCP server print for `state`, `reset`, and the like (docs/cli.md,
 * "Output shapes").
 */
export function withTarget(envelope: { target?: string; result: unknown }): Record<string, unknown> {
  const result = envelope.result as Record<string, unknown>;
  return envelope.target === undefined || 'target' in result ? result : { target: envelope.target, ...result };
}
```

In `packages/cli/src/cli/program.ts`, change the output import to:

```ts
import { createOutput, withTarget, type Output } from './output';
```

and delete the closure inside `buildProgram`:

```ts
  const withTarget = (envelope: { target?: string; result: unknown }): Record<string, unknown> => {
    const result = envelope.result as Record<string, unknown>;
    return envelope.target === undefined || 'target' in result ? result : { target: envelope.target, ...result };
  };
```

Every existing call site (`state`, `wait`, `settle`, `events`, `clock now`, `reset`, `screenshot`, and plan 1's `reload`) keeps calling `withTarget(...)` unchanged.

- [ ] **Step 6: Write the server with the thirteen daemon tools**

Create `packages/cli/src/mcp/server.ts`:

```ts
import { toErrorShape, type Description, type FakeCallsResult, type SettleResult, type StepResult } from '@ironbird/core';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { DaemonClient } from '../cli/client';
import { withTarget } from '../cli/output';

/** What the MCP server needs from its host; `ironbird mcp` builds it (docs/cli.md, `mcp`). */
export interface McpServerOptions {
  /** Reported as the server's version; the CLI passes its package version. */
  version: string;
  /** `ironbird_run_scenario` resolves a relative `path` against it: the project root under `.mcp.json`. */
  cwd: string;
  /**
   * Finds the daemon. Called once per tool call, never at start, so the server can start before
   * the daemon and a restarted daemon is picked up without restarting the server.
   */
  resolve: () => Promise<{ client: DaemonClient; artifactsDir: string }>;
  /** Reads a screenshot PNG for image content; default `readFile`. */
  readImage?: (path: string) => Promise<Buffer>;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };
type ToolResult = { content: Content[]; isError?: boolean };

const asText = (value: unknown): Content => ({ type: 'text', text: JSON.stringify(value) });
const success = (value: unknown, ...more: Content[]): ToolResult => ({ content: [asText(value), ...more] });
/** The same `{ error: { code, message, details } }` JSON the CLI prints. */
const failure = (error: unknown): ToolResult => ({ isError: true, content: [asText({ error: toErrorShape(error) })] });

/** Every failure, from the daemon or from the server itself, becomes an `isError` result rather than a protocol error. */
async function guard(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    return failure(error);
  }
}

const CONDITIONS = ['equals', 'notEquals', 'exists', 'matches'] as const;
/** The CLI's `wait --timeout` default. */
const WAIT_TIMEOUT_MS = 5_000;

const target = z.string().min(1).optional().describe('Target id from ironbird_status, such as headless or ios. Omit for the daemon default.');
const statePath = z.string().optional().describe('Return only this subtree of state, as a dotted path such as settings.theme. Omit for the whole state.');
const settle = z
  .union([z.boolean(), z.object({ timeoutMs: z.number().int().nonnegative() })])
  .optional()
  .describe('Wait for effects afterwards: true (default), false, or { timeoutMs }.');
const payload = z.unknown().optional().describe('The JSON payload, matching the payload schema from ironbird_describe. Default {}.');
const cursor = (what: string) => z.number().int().nonnegative().optional().describe(`Only ${what} with a sequence number above this; pass the previous nextSeq.`);
const limit = z.number().int().nonnegative().optional().describe('At most this many.');

/** Builds the `ironbird` MCP server: each tool is one daemon operation (spec §5.1). */
export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'ironbird', version: options.version });
  const daemon = async (): Promise<DaemonClient> => (await options.resolve()).client;

  server.registerTool(
    'ironbird_status',
    {
      description:
        'The daemon version, protocol, uptime, and connected targets (headless, and apps such as ios or android). Call this first, then ironbird_describe. If it fails with NO_TARGET and "Daemon unreachable", start `npx ironbird serve` in the project root in the background and retry.',
      inputSchema: z.object({}),
    },
    () => guard(async () => success(await (await daemon()).rpc('status'))),
  );

  server.registerTool(
    'ironbird_describe',
    {
      description:
        "The app's commands and fakes with their payload JSON Schemas, and the target's capabilities (clock, reset, reload, fakes). Read it before ironbird_send or ironbird_fake for exact names and payload shapes.",
      inputSchema: z.object({ target }),
    },
    (input) => guard(async () => success(withTarget(await (await daemon()).call<Description>('describe', {}, input.target)))),
  );

  server.registerTool(
    'ironbird_send',
    {
      description:
        'Validate and dispatch one app command, wait for its effects to settle, and return the step result: state (or the subtree at path), the events recorded, and settle. Call ironbird_describe first for command names and payload schemas. On headless, settle.idle false with quiescent true means the app waits on the clock or a fake: use ironbird_clock_advance or ironbird_fake.',
      inputSchema: z.object({ command: z.string().min(1).describe('Command name from ironbird_describe.'), payload, target, path: statePath, settle }),
    },
    (input) =>
      guard(async () =>
        success(await (await daemon()).rpc<StepResult>('dispatch', { name: input.command, payload: input.payload ?? {}, path: input.path ?? '', settle: input.settle ?? true }, input.target)),
      ),
  );

  server.registerTool(
    'ironbird_state',
    {
      description: 'Read state at a dotted path, or the whole state. Returns { target, rev, path, value }.',
      inputSchema: z.object({ path: statePath, target }),
    },
    (input) => guard(async () => success(withTarget(await (await daemon()).call('getState', { path: input.path ?? '' }, input.target)))),
  );

  server.registerTool(
    'ironbird_wait',
    {
      description:
        'Wait until the value at path meets exactly one condition: equals, notEquals, exists, or matches (a regular expression). Fails with WAIT_TIMEOUT, carrying the last value, after timeoutMs (default 5000). On headless it does not advance the clock; call ironbird_clock_advance first when the condition depends on time.',
      inputSchema: z
        .object({
          path: z.string().describe('Dotted state path to watch.'),
          equals: z.unknown().optional().describe('Holds when the value deep-equals this JSON value, null included.'),
          notEquals: z.unknown().optional().describe('Holds when the value does not deep-equal this JSON value.'),
          exists: z.boolean().optional().describe('true: holds when the path exists; false: when it does not.'),
          matches: z.string().optional().describe('Holds when the value matches this regular expression.'),
          timeoutMs: z.number().int().nonnegative().optional().describe('Give up after this many milliseconds. Default 5000.'),
          target,
        })
        .refine((input) => CONDITIONS.filter((key) => input[key] !== undefined).length === 1, { message: 'Pass exactly one of equals, notEquals, exists, matches' }),
    },
    (input) =>
      guard(async () => {
        const condition = Object.fromEntries(CONDITIONS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
        return success(withTarget(await (await daemon()).call('waitFor', { path: input.path, ...condition, timeoutMs: input.timeoutMs ?? WAIT_TIMEOUT_MS }, input.target)));
      }),
  );

  server.registerTool(
    'ironbird_settle',
    {
      description: 'Wait for in-flight effects without dispatching anything, and report whether the target is idle or quiescent and what is still pending.',
      inputSchema: z.object({ timeoutMs: z.number().int().nonnegative().optional().describe('How long to wait, in milliseconds.'), target }),
    },
    (input) =>
      guard(async () => success(withTarget(await (await daemon()).call<SettleResult>('settle', input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }, input.target)))),
  );

  server.registerTool(
    'ironbird_fake',
    {
      description:
        'Run a control on a fake, a stand-in for the outside world such as a server or a device API, to deliver, delay, duplicate, or drop what it sends, then settle. Fake names, controls, and payload schemas come from ironbird_describe under fakes. Returns a step result.',
      inputSchema: z.object({
        fake: z.string().min(1).describe('Fake name from ironbird_describe.'),
        control: z.string().min(1).describe("Control name from the fake's controls."),
        payload,
        target,
        path: statePath,
        settle,
      }),
    },
    (input) =>
      guard(async () =>
        success(
          await (await daemon()).rpc<StepResult>(
            'fakeControl',
            { fake: input.fake, control: input.control, payload: input.payload ?? {}, path: input.path ?? '', settle: input.settle ?? true },
            input.target,
          ),
        ),
      ),
  );

  server.registerTool(
    'ironbird_fake_calls',
    {
      description: "The calls the app made on a fake's port, oldest first, with arguments and outcomes. Page with since set to the previous nextSeq.",
      inputSchema: z.object({ fake: z.string().min(1).describe('Fake name from ironbird_describe.'), since: cursor('calls'), limit, target }),
    },
    (input) =>
      guard(async () => {
        const envelope = await (await daemon()).call<FakeCallsResult>('fakeCalls', { fake: input.fake, since: input.since, limit: input.limit }, input.target);
        return success({ ...(envelope.target === undefined ? {} : { target: envelope.target }), fake: input.fake, ...envelope.result });
      }),
  );

  server.registerTool(
    'ironbird_events',
    {
      description: 'Events the app recorded, oldest first. Page with since set to the previous nextSeq; sequence numbers restart after ironbird_reset or ironbird_reload.',
      inputSchema: z.object({ since: cursor('events'), limit, target }),
    },
    (input) => guard(async () => success(withTarget(await (await daemon()).call('events', { since: input.since, limit: input.limit }, input.target)))),
  );

  server.registerTool(
    'ironbird_clock_advance',
    {
      description: 'Headless only. Advance the manual clock by ms milliseconds, firing due timers, then settle. Returns a step result plus now.',
      inputSchema: z.object({ ms: z.number().int().nonnegative().describe('Milliseconds to advance.'), path: statePath, settle, target }),
    },
    (input) =>
      guard(async () => success(await (await daemon()).rpc<StepResult>('clockAdvance', { ms: input.ms, path: input.path ?? '', settle: input.settle ?? true }, input.target))),
  );

  server.registerTool(
    'ironbird_clock_now',
    {
      description: "Headless only. The manual clock's current time in epoch milliseconds.",
      inputSchema: z.object({ target }),
    },
    (input) => guard(async () => success(withTarget(await (await daemon()).call('clockNow', {}, input.target)))),
  );

  server.registerTool(
    'ironbird_reset',
    {
      description:
        'Headless only. Restart the app from the code already loaded, with a fresh clock, event log, and fakes. After changing app code, call ironbird_reload instead: reset runs the old code.',
      inputSchema: z.object({ target }),
    },
    (input) => guard(async () => success(withTarget(await (await daemon()).call('reset', {}, input.target)))),
  );

  server.registerTool(
    'ironbird_reload',
    {
      description:
        "Load the app's current code from a fresh start: the headless target re-bundles its entry, and a connected app reloads through its bridge. Call it after every code change, before checking behavior, and use the target id it returns from then on. Returns { target, rev }.",
      // Positive, as the daemon requires for `reload` (plan 1); the other duration inputs accept 0 because the
      // daemon does: a 0 ms wait or settle checks once, and a 0 ms clock advance fires only due timers.
      inputSchema: z.object({ target, timeoutMs: z.number().int().positive().optional().describe('Connected apps only: how long to wait for the app to come back. Default 60000.') }),
    },
    (input) => guard(async () => success(withTarget(await (await daemon()).call('reload', input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }, input.target)))),
  );

  return server;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/helpers.test.ts packages/cli/src/mcp/server.test.ts packages/cli/src/cli/program.test.ts`
Expected: PASS, all tests. `program.test.ts` is included to confirm the `withTarget` move changed no CLI output.

- [ ] **Step 8: Typecheck and lint**

Run: `pnpm --filter @ironbird/cli typecheck && pnpm lint`
Expected: no errors. If `registerTool` rejects a handler's return type, check that `ToolResult` is a type alias (not an interface), so it is assignable to the SDK's `CallToolResult` with its index signature.

- [ ] **Step 9: Commit**

The commit body carries the dependency justification (AGENTS.md hard rule 7).

```sh
git add packages/cli/package.json pnpm-lock.yaml packages/cli/src/cli/output.ts packages/cli/src/cli/helpers.test.ts packages/cli/src/cli/program.ts packages/cli/src/mcp/server.ts packages/cli/src/mcp/server.test.ts
git commit -m "Add the MCP server's daemon tools" -m "@modelcontextprotocol/server: the official MCP server SDK, which ironbird needs to speak MCP, and whose v2 server package adds only its own core and the zod the CLI already uses. @modelcontextprotocol/client is a dev dependency for the tests."
```

---

### Task 2: Image tools and `ironbird_run_scenario`

**Files:**
- Modify: `packages/cli/src/mcp/server.ts` (imports; three tools before `return server;`)
- Modify: `packages/cli/src/mcp/server.test.ts` (imports, the tool list, two describe blocks)

**Interfaces:**
- Consumes: everything Task 1 lists as produced in `server.ts` and `server.test.ts`; `loadScenarioFiles(paths: string[], cwd: string): Promise<Array<{ file: string; scenario: Scenario }>>` from `packages/cli/src/scenario/parse.ts` (throws `INVALID_SCENARIO` for an invalid file, a missing path, or a folder with no `*.yaml`/`*.yml`); `runScenario(client, scenario, { file, target?, artifacts, reset? }): Promise<ScenarioResult>` from `packages/cli/src/scenario/run.ts` (throws when the first `describe` or the D14 reset fails); `messageOf`, `Screenshot`, `ScenarioResult` from `@ironbird/core`.
- Produces: tools `ironbird_step`, `ironbird_screenshot`, `ironbird_run_scenario`, completing the sixteen. `ironbird_run_scenario` returns `{ results: ScenarioResult[] }`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/mcp/server.test.ts`, replace the imports with:

```ts
import { IronbirdError, type ScenarioResult } from '@ironbird/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonClient, type DaemonClient } from '../cli/client';
import { createMcpServer, type McpServerOptions } from './server';
```

Replace the `DAEMON_TOOLS` constant with:

```ts
const ALL_TOOLS = [
  'ironbird_status',
  'ironbird_describe',
  'ironbird_send',
  'ironbird_step',
  'ironbird_state',
  'ironbird_wait',
  'ironbird_settle',
  'ironbird_fake',
  'ironbird_fake_calls',
  'ironbird_events',
  'ironbird_clock_advance',
  'ironbird_clock_now',
  'ironbird_screenshot',
  'ironbird_run_scenario',
  'ironbird_reset',
  'ironbird_reload',
];
```

In the first test, replace `expect(tools.map((tool) => tool.name).sort()).toEqual([...DAEMON_TOOLS].sort());` with:

```ts
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_TOOLS].sort());
```

and rename that test to `'names itself ironbird with the package version and lists all sixteen tools without contacting the daemon'`.

Add at the end of the file:

```ts
describe('image tools', () => {
  const shot = { path: '/shots/ios.png', device: 'SIM-1', capturedAt: 5 };
  const png = Buffer.from('not really a png');
  const stepped = { ...step({ target: 'ios' }), screenshot: shot, settledBeforeCapture: true };

  it('ironbird_step returns the step result and the screenshot as image content', async () => {
    const read: string[] = [];
    const h = await connect({ step: stepped }, {
      readImage: async (file) => {
        read.push(file);
        return png;
      },
    });
    const result = await h.call('ironbird_step', { command: 'cart.addItem', payload: { sku: 'x' }, target: 'ios', device: 'SIM-1' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(json(result)).toMatchObject({ target: 'ios', screenshot: shot, settledBeforeCapture: true });
    expect(result.content[1]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    expect(read).toEqual([shot.path]);
    expect(h.calls).toEqual([{ op: 'step', params: { name: 'cart.addItem', payload: { sku: 'x' }, path: '', settle: true, device: 'SIM-1' }, target: 'ios' }]);
  });

  it('ironbird_screenshot returns the capture record with its target and the image', async () => {
    const h = await connect({ screenshot: shot }, { readImage: async () => png });
    const result = await h.call('ironbird_screenshot', { target: 'ios' });
    expect(json(result)).toEqual({ target: 'ios', ...shot });
    expect(result.content[1]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    expect(h.calls).toEqual([{ op: 'screenshot', params: {}, target: 'ios' }]);
  });

  it('keeps an applied step a success when the screenshot file cannot be read', async () => {
    const h = await connect({ step: stepped }, {
      readImage: async () => {
        throw new Error('ENOENT: no such file');
      },
    });
    const result = await h.call('ironbird_step', { command: 'cart.addItem', target: 'ios' });
    expect(result.isError).toBeFalsy();
    expect(json(result)).toMatchObject({ screenshot: shot });
    expect(result.content[1]).toEqual({ type: 'text', text: `The screenshot at ${shot.path} could not be read: ENOENT: no such file` });
  });
});

describe('ironbird_run_scenario', () => {
  let dir: string;
  const described = { app: { id: 'a', platform: 'headless' }, commands: {}, fakes: {}, capabilities: ['settle', 'events', 'clock', 'reset'] };
  // The expect step reads order.totalCents; artifact collection reads the root.
  const responses = {
    describe: described,
    reset: { rev: 0, path: '', value: {} },
    dispatch: step(),
    events: { events: [], nextSeq: 0, truncated: false },
    getState: (params: Record<string, unknown>) => (params['path'] === '' ? { rev: 1, path: '', value: {} } : { rev: 1, path: 'order.totalCents', value: 0 }),
  };
  const open = (extra: Record<string, Responder> = {}) => connect({ ...responses, ...extra }, { cwd: dir, artifactsDir: path.join(dir, '.ironbird') });
  const results = (result: { content: Array<{ type: string; text?: string }> }): ScenarioResult[] => (json(result) as { results: ScenarioResult[] }).results;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-mcp-scenario-'));
    await mkdir(path.join(dir, 'scenarios'));
    await mkdir(path.join(dir, 'empty'));
    await writeFile(path.join(dir, 'scenarios/a-passes.yml'), 'name: A passes\nsteps:\n  - send: cart.clear\n');
    await writeFile(path.join(dir, 'scenarios/b-fails.yaml'), 'name: B fails\nsteps:\n  - expect: order.totalCents\n    equals: 4500\n');
    await writeFile(path.join(dir, 'scenarios/c-passes.yaml'), 'name: C passes\nsteps:\n  - send: cart.clear\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs every file in a folder, resetting the headless target before each, and returns { results }', async () => {
    const h = await open();
    const result = await h.call('ironbird_run_scenario', { path: 'scenarios', target: 'headless' });
    expect(result.isError).toBeFalsy();
    const ran = results(result);
    expect(ran.map((r) => [r.scenario, r.passed, r.file])).toEqual([
      ['A passes', true, path.join(dir, 'scenarios/a-passes.yml')],
      ['B fails', false, path.join(dir, 'scenarios/b-fails.yaml')],
      ['C passes', true, path.join(dir, 'scenarios/c-passes.yaml')],
    ]);
    expect(ran[1]).toMatchObject({ target: 'headless', failedStep: { index: 0, expected: { equals: 4_500 }, actual: 0 } });
    for (const r of ran) expect(String(r.artifacts).startsWith(path.join(dir, '.ironbird', 'runs'))).toBe(true);
    expect(h.calls.filter((c) => c.op === 'reset')).toHaveLength(3);
    expect(h.calls.filter((c) => c.op === 'describe').every((c) => c.target === 'headless')).toBe(true);
  });

  it('runs a single file by relative path and stops after the first failed file with bail', async () => {
    const one = await open();
    expect(results(await one.call('ironbird_run_scenario', { path: 'scenarios/a-passes.yml' })).map((r) => r.passed)).toEqual([true]);
    const bailed = await open();
    expect(results(await bailed.call('ironbird_run_scenario', { path: 'scenarios', bail: true })).map((r) => r.scenario)).toEqual(['A passes', 'B fails']);
  });

  it('reports an invalid file, a missing path, or an empty folder as INVALID_SCENARIO before looking up the daemon', async () => {
    await writeFile(path.join(dir, 'scenarios/d-broken.yaml'), 'name: Broken\nsteps:\n  - send: cart.clear\n    payloads: {}\n');
    const h = await open();
    const broken = await h.call('ironbird_run_scenario', { path: 'scenarios' });
    expect(broken.isError).toBe(true);
    expect(json(broken)).toMatchObject({
      error: { code: 'INVALID_SCENARIO', details: { file: path.join(dir, 'scenarios/d-broken.yaml'), issues: [{ path: ['steps', 0, 'payloads'], line: 4 }] } },
    });
    for (const where of ['nope.yaml', 'empty']) {
      const result = await h.call('ironbird_run_scenario', { path: where });
      expect(result.isError, where).toBe(true);
      expect(json(result), where).toMatchObject({ error: { code: 'INVALID_SCENARIO' } });
    }
    expect(h.resolves()).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('returns a failure of the first describe as an isError result', async () => {
    const h = await open({ describe: new IronbirdError('NO_TARGET', 'No target ios', { available: ['headless'] }) });
    const result = await h.call('ironbird_run_scenario', { path: 'scenarios/a-passes.yml', target: 'ios' });
    expect(result.isError).toBe(true);
    expect(json(result)).toEqual({ error: { code: 'NO_TARGET', message: 'No target ios', details: { available: ['headless'] } } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/mcp/server.test.ts`
Expected: FAIL. The tool list test reports three missing names; the image and scenario tests fail with an SDK error result for an unknown tool (`Tool ironbird_step not found` or similar), or a thrown protocol error for it.

- [ ] **Step 3: Add the three tools**

In `packages/cli/src/mcp/server.ts`, replace the import block with:

```ts
import { messageOf, toErrorShape, type Description, type FakeCallsResult, type ScenarioResult, type Screenshot, type SettleResult, type StepResult } from '@ironbird/core';
import { McpServer } from '@modelcontextprotocol/server';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { DaemonClient } from '../cli/client';
import { withTarget } from '../cli/output';
import { loadScenarioFiles } from '../scenario/parse';
import { runScenario } from '../scenario/run';
```

After the `limit` constant, add:

```ts
const device = z.string().min(1).optional().describe('Simulator udid or adb serial. Omit for the configured device, else the only booted one.');
```

Insert immediately before the final `return server;` in `createMcpServer`:

```ts
  const readImage = options.readImage ?? ((file: string) => readFile(file));

  // The step or capture has already happened, so a PNG that can't be read must not turn the
  // result into an error: an agent that retried the step would apply it twice.
  const withImage = async (value: unknown, shot: Screenshot): Promise<ToolResult> => {
    try {
      const png = await readImage(shot.path);
      return success(value, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    } catch (error) {
      return success(value, { type: 'text', text: `The screenshot at ${shot.path} could not be read: ${messageOf(error)}` });
    }
  };

  server.registerTool(
    'ironbird_step',
    {
      description:
        'Connected apps only. Like ironbird_send, then capture a screenshot once settling ends, returned as an image. settledBeforeCapture is true only when settling reached idle first. The headless target has no screen.',
      inputSchema: z.object({ command: z.string().min(1).describe('Command name from ironbird_describe.'), payload, target, path: statePath, settle, device }),
    },
    (input) =>
      guard(async () => {
        const result = await (await daemon()).rpc<StepResult & { screenshot: Screenshot; settledBeforeCapture: boolean }>(
          'step',
          { name: input.command, payload: input.payload ?? {}, path: input.path ?? '', settle: input.settle ?? true, ...(input.device === undefined ? {} : { device: input.device }) },
          input.target,
        );
        return withImage(result, result.screenshot);
      }),
  );

  server.registerTool(
    'ironbird_screenshot',
    {
      description: 'Connected apps only. Capture the screen, returned as an image and as { target, path, device, capturedAt }. Look at it before describing what the app shows.',
      inputSchema: z.object({ target, device }),
    },
    (input) =>
      guard(async () => {
        const envelope = await (await daemon()).call<Screenshot>('screenshot', input.device === undefined ? {} : { device: input.device }, input.target);
        return withImage(withTarget(envelope), envelope.result);
      }),
  );

  server.registerTool(
    'ironbird_run_scenario',
    {
      description:
        'Run a YAML scenario file, or every *.yaml and *.yml file in a folder, and return { results }, one per file, each with passed, failedStep, and its artifacts folder. Every file is validated before any runs. The headless target is reset before each file. A connected app runs against its current state, so call ironbird_reload on it first after changing code. A failing scenario is a normal result with passed: false.',
      inputSchema: z.object({
        path: z.string().min(1).describe('A scenario file or a folder of them, relative to the project root.'),
        target,
        bail: z.boolean().optional().describe('Stop after the first failed scenario.'),
      }),
    },
    (input) =>
      guard(async () => {
        // Every file is parsed before anything runs, and before the daemon is looked up, so an
        // authoring error costs nothing and needs no daemon.
        const scenarios = await loadScenarioFiles([input.path], options.cwd);
        const { client, artifactsDir } = await options.resolve();
        const results: ScenarioResult[] = [];
        for (const { file, scenario } of scenarios) {
          const result = await runScenario(client, scenario, { file, target: input.target, artifacts: artifactsDir, reset: true });
          results.push(result);
          if (!result.passed && input.bail) break;
        }
        return success({ results });
      }),
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/mcp/server.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @ironbird/cli typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```sh
git add packages/cli/src/mcp/server.ts packages/cli/src/mcp/server.test.ts
git commit -m "Add the MCP image tools and ironbird_run_scenario"
```

---

### Task 3: `ironbird mcp` over stdio

**Files:**
- Create: `packages/cli/src/mcp/stdio.ts`
- Modify: `packages/cli/src/cli/program.ts` (`ProgramIo.mcp`, the `mcp` command, the core import)
- Modify: `packages/cli/src/cli/program.test.ts` (imports, a `mcp` describe block)
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/test/mcp.integration.test.ts`
- Modify: `docs/cli.md` (intro sentence, `mcp` section, "MCP tools" section, last-updated date)

**Interfaces:**
- Consumes: `createMcpServer`, `McpServerOptions` (Tasks 1 and 2); `resolveDaemon({ flag, cwd, env }): Promise<ResolvedDaemon>` and `createDaemonClient` from `packages/cli/src/cli/client.ts`; `startDaemon(options: DaemonOptions)` with `capture?: { resolveDevice?, capture? }` and `targets?: DaemonTarget[]` from `packages/cli/src/daemon.ts`; `createHeadlessTarget(options: HeadlessTargetOptions)` with plan 1's `loadDefinition?: () => Promise<HeadlessDefinition>`.
- Produces: `export async function runMcpStdio(options: McpServerOptions): Promise<void>` in `packages/cli/src/mcp/stdio.ts`; `ProgramIo.mcp?: (options: McpServerOptions) => Promise<void>`; the command `ironbird mcp` using the global `--daemon` and `--token`; `@ironbird/cli` exports `createMcpServer` and the type `McpServerOptions`.

- [ ] **Step 1: Write the failing program tests**

In `packages/cli/src/cli/program.test.ts`, add this import after the `./client` import:

```ts
import type { McpServerOptions } from '../mcp/server';
```

Add at the end of the file:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts -t mcp`
Expected: FAIL. TypeScript-aware Vitest still runs; the `run(['mcp', ...])` call exits 2 (`commander` reports `unknown command 'mcp'`), so `expected 2 to be 0` and `expected 2 to be 1`.

- [ ] **Step 3: Write `runMcpStdio`**

Create `packages/cli/src/mcp/stdio.ts`:

```ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer, type McpServerOptions } from './server';

/**
 * Serves the ironbird tools over this process's stdin and stdout until stdin ends or the process
 * is asked to stop. Only MCP messages reach stdout (docs/cli.md, `mcp`).
 */
export async function runMcpStdio(options: McpServerOptions): Promise<void> {
  const handle = await serveStdio(() => createMcpServer(options));
  await new Promise<void>((resolve) => {
    const done = (): void => {
      process.stdin.off('end', done);
      process.stdin.off('close', done);
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.stdin.once('end', done);
    process.stdin.once('close', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await handle.close();
}
```

`serveStdio` returns its handle synchronously in 2.2.0; the `await` keeps this correct if a later 2.x returns a promise.

- [ ] **Step 4: Add the `mcp` command**

In `packages/cli/src/cli/program.ts`:

Change the first import to add `messageOf`:

```ts
import { IronbirdError, messageOf, suggestNames, toErrorShape, type Description, type ErrorShape, type FakeCallsResult, type SettleResult, type StepResult } from '@ironbird/core';
```

Add after `import type { runServe } from './commands/serve';`:

```ts
import type { McpServerOptions } from '../mcp/server';
```

In `interface ProgramIo`, after `serve?: typeof runServe;`, add:

```ts
  /** Test hook replacing `runMcpStdio`, which would take over this process's stdin and stdout. */
  mcp?: (options: McpServerOptions) => Promise<void>;
```

Insert this command immediately before the final `return {` of `buildProgram` (after the `verify-bundle` command):

```ts
  program
    .command('mcp')
    .description('Serve the ironbird MCP tools over stdio; the daemon is found on each tool call')
    .action(async (_opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      try {
        // Loaded on demand: the MCP SDK and the scenario runner are needed only here.
        const serve = io.mcp ?? (await import('../mcp/stdio')).runMcpStdio;
        await serve({
          version: io.version,
          cwd: io.cwd,
          // Resolved per tool call, like a CLI command per invocation, so the server can start
          // before the daemon and survives a daemon restart.
          resolve: async () => {
            const daemon = await resolveDaemon({ flag: globals.daemon, cwd: io.cwd, env: io.env });
            return { client: (io.createClient ?? createDaemonClient)({ url: daemon.url, token: globals.token ?? daemon.token }), artifactsDir: daemon.artifactsDir };
          },
        });
        exitCode = 0;
      } catch (error) {
        // Never stdout: it belongs to the MCP client.
        io.stderr(`ironbird mcp: ${messageOf(error)}\n`);
        exitCode = 1;
      }
    });
```

In `packages/cli/src/index.ts`, add at the end:

```ts
export { createMcpServer } from './mcp/server';
export type { McpServerOptions } from './mcp/server';
```

- [ ] **Step 5: Run the program tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Write the integration test**

Create `packages/cli/test/mcp.integration.test.ts`:

```ts
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
```

- [ ] **Step 7: Build and run the integration test**

Run: `pnpm build && pnpm exec vitest run --project serial packages/cli/test/mcp.integration.test.ts`
Expected: PASS, 5 tests. A `JSON.parse` failure in the stdio test means something besides MCP reached stdout; find it rather than filtering it. If the reload assertions fail with `UNSUPPORTED`, plan 1 has not landed.

- [ ] **Step 8: Rewrite the MCP sections of cli.md**

In `docs/cli.md`:

Change the `Last updated` row to `| Last updated | 2026-09-29 |`.

Replace the intro sentence `Every command except \`serve\`, \`doctor\`, \`verify-bundle\`, and \`mcp\` talks to a running daemon.` with:

```markdown
Every command except `serve`, `doctor`, `verify-bundle`, `mcp`, and `agent setup` talks to a running daemon. `mcp` starts without one and finds it on each tool call.
```

Replace the whole `### mcp (P1)` section (heading, the `text` block, and its one-line paragraph) with:

````markdown
### mcp

```text
ironbird mcp [--daemon <url>] [--token <token>]
```

Runs an MCP server for coding agents over stdio until stdin closes. `ironbird agent setup` registers it in `.mcp.json` as `{ "command": "npx", "args": ["ironbird", "mcp"] }`, so it runs in the project root. The server is named `ironbird` and reports the package version. Its tools are listed [below](#mcp-tools); [agents.md](agents.md) covers setup.

The server needs no daemon to start. Each tool call finds the daemon the way other commands do: `--daemon`, then the nearest `.ironbird/daemon.json` walking up from the working directory, then `http://127.0.0.1:4567`, with `--token` or `IRONBIRD_TOKEN` for the token. So the server can start before `ironbird serve`, and a daemon restart needs no MCP restart. While no daemon answers, every tool fails with `NO_TARGET`, whose message says to run `ironbird serve`. Nothing but MCP messages is written to stdout; diagnostics go to stderr.
````

Replace the whole `## MCP tools (P1)` section (heading, table, and closing paragraph) with:

```markdown
## MCP tools

Each tool is one daemon operation, except `ironbird_run_scenario`, which runs the scenario runner inside the MCP server, as `scenario run` does in the CLI. App command schemas reach the agent as JSON Schemas in `ironbird_describe` results, never as tool input schemas, so the tool list is the same for every app.

| Tool | Input | Returns | Daemon operation |
|---|---|---|---|
| `ironbird_status` | none | `{ version, protocol, uptimeMs, targets }` | `status` |
| `ironbird_describe` | `target?` | The `Description` plus `target`: app, commands and fakes with JSON Schemas, capabilities | `describe` |
| `ironbird_send` | `command`, `payload?`, `target?`, `path?`, `settle?` | Step result | `dispatch` |
| `ironbird_step` | `command`, `payload?`, `target?`, `path?`, `settle?`, `device?` | Step result plus `screenshot` and `settledBeforeCapture`, and the screenshot as image content | `step` |
| `ironbird_state` | `path?`, `target?` | `{ target, rev, path, value }` | `getState` |
| `ironbird_wait` | `path`, exactly one of `equals`, `notEquals`, `exists`, `matches`, `timeoutMs?` (default 5000), `target?` | `{ target, rev, path, value, waitedMs }`, or a `WAIT_TIMEOUT` error | `waitFor` |
| `ironbird_settle` | `timeoutMs?`, `target?` | Settle result plus `target` | `settle` |
| `ironbird_fake` | `fake`, `control`, `payload?`, `target?`, `path?`, `settle?` | Step result | `fakeControl` |
| `ironbird_fake_calls` | `fake`, `since?`, `limit?`, `target?` | `{ target, fake, calls, nextSeq, truncated }` | `fakeCalls` |
| `ironbird_events` | `since?`, `limit?`, `target?` | `{ target, events, nextSeq, truncated }` | `events` |
| `ironbird_clock_advance` | `ms`, `path?`, `settle?`, `target?` | Step result plus `now` | `clockAdvance` |
| `ironbird_clock_now` | `target?` | `{ target, now }` | `clockNow` |
| `ironbird_screenshot` | `target?`, `device?` | `{ target, path, device, capturedAt }`, and the image as image content | `screenshot` |
| `ironbird_run_scenario` | `path` (a file or a folder), `target?`, `bail?` | `{ results: ScenarioResult[] }`, one per file | the scenario runner, in process |
| `ironbird_reset` | `target?` | `{ target, rev, path, value }` | `reset` |
| `ironbird_reload` | `target?`, `timeoutMs?` | `{ target, rev }` | `reload` |

- Inputs are Zod 4 objects, published to the agent as JSON Schemas. `settle` is `true` (the default), `false`, or `{ timeoutMs }`, as in the protocol. Durations are milliseconds. Defaults match the CLI: `payload` is `{}`, `path` is the whole state, and `ironbird_wait` gives up after 5000 ms. `ironbird_clock_advance` and `ironbird_clock_now` work only on a target that declares `clock` (headless); pass `target: 'headless'` when the daemon's default target is a device.
- A successful result is one text block holding the JSON the CLI prints for the same operation: the daemon's result with `target` added when it lacks one, and `fake` added for `ironbird_fake_calls`. A step that did not settle is still a success; its `settle` says so, where the CLI would exit 3. `ironbird_step` and `ironbird_screenshot` add one image block, the PNG at the returned path, base64-encoded as `image/png`; the MCP server reads it from disk, so it must run on the daemon's machine. If the file can't be read, a second text block says why instead, and the result stays a success because the step was already applied.
- A failure is a result with `isError: true` and one text block holding the same `{ "error": { "code", "message", "details" } }` JSON the CLI prints. Input that fails a tool's schema, such as `ironbird_wait` with no condition or two, is rejected by the MCP SDK with an `Input validation error` text before the daemon is contacted.
- `ironbird_run_scenario` resolves `path` against the MCP server's working directory, the project root when started from `.mcp.json`, and behaves as `scenario run`: every file is validated before any runs, a headless target is reset before each file, `bail` stops after the first failed scenario, and each result names its artifacts folder. An invalid file, a missing path, or a folder with no scenario files is an `isError` result with `INVALID_SCENARIO`, returned before the daemon is contacted. A scenario that runs and fails is a normal result with `passed: false`. A connected app runs against its current state, so reload it first. When the first `describe` of a file fails, the call returns that error, and the runs before it are only on disk.
- Tool descriptions are written for agents and name the next useful call.
```

- [ ] **Step 9: Run the unit and serial suites, typecheck, and lint**

Run: `pnpm --filter @ironbird/cli typecheck && pnpm lint && pnpm test`
Expected: no type or lint errors; every unit and serial test passes.

- [ ] **Step 10: Commit**

```sh
git add packages/cli/src/mcp/stdio.ts packages/cli/src/cli/program.ts packages/cli/src/cli/program.test.ts packages/cli/src/index.ts packages/cli/test/mcp.integration.test.ts docs/cli.md
git commit -m "Add ironbird mcp over stdio"
```

---

### Task 4: The ironbird skill

**Files:**
- Create: `packages/cli/skills/ironbird/SKILL.md`
- Create: `packages/cli/skills/ironbird/references/scenarios.md`
- Modify: `packages/cli/package.json` (`files`)
- Create: `packages/cli/src/agent/skill.test.ts`
- Create: `packages/cli/test/package.integration.test.ts`
- Create: `docs/agents.md`

**Interfaces:**
- Consumes: the sixteen tool names (Tasks 1 and 2); `npx ironbird reload` (plan 1); `npx ironbird agent setup` (Task 5, documented here, built next).
- Produces: `packages/cli/skills/ironbird/SKILL.md` and `packages/cli/skills/ironbird/references/scenarios.md`, shipped in the package (`"files": ["dist", "skills"]`). Task 5 copies exactly the files under `skills/ironbird/`, so its result lists `['SKILL.md', 'references/scenarios.md']`.

- [ ] **Step 1: Write the failing content tests**

Create `packages/cli/src/agent/skill.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const skillDir = path.resolve(__dirname, '../../skills/ironbird');
const read = (file: string): Promise<string> => readFile(path.join(skillDir, file), 'utf8');

// Spec D7: the skill must not name the example app, its commands, its fakes, or its bug, or the
// eval measures the skill leaking the answer instead of the agent using the loop.
const LEAKS = /checkout|\bcart\b|payment|totalCents|zero total|cut-45|haircut|plant_?race|\brace\b|\breader\b|setEcho|\bemit\b/i;

const TOOLS = [
  'ironbird_status',
  'ironbird_describe',
  'ironbird_send',
  'ironbird_step',
  'ironbird_state',
  'ironbird_wait',
  'ironbird_settle',
  'ironbird_fake',
  'ironbird_fake_calls',
  'ironbird_events',
  'ironbird_clock_advance',
  'ironbird_clock_now',
  'ironbird_screenshot',
  'ironbird_run_scenario',
  'ironbird_reset',
  'ironbird_reload',
];

describe('the ironbird skill', () => {
  it('has Agent Skills front matter naming it ironbird with a when-to-use description', async () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(await read('SKILL.md'));
    expect(match).not.toBeNull();
    const front = parse(match?.[1] ?? '') as Record<string, unknown>;
    expect(front['name']).toBe('ironbird');
    expect(String(front['description'])).toMatch(/^Use when/);
  });

  it('stays under 200 lines', async () => {
    expect((await read('SKILL.md')).split('\n').length).toBeLessThan(200);
  });

  it('teaches the six steps with every MCP tool and the CLI equivalents', async () => {
    const skill = await read('SKILL.md');
    for (const heading of ['### 1. Orient', '### 2. Reproduce headlessly', '### 3. Pin it down as a scenario', '### 4. Fix', '### 5. Check on a device', '### 6. Report with evidence']) {
      expect(skill).toContain(heading);
    }
    for (const tool of TOOLS) expect(skill, tool).toContain(`\`${tool}\``);
    for (const command of ['npx ironbird status', 'npx ironbird serve', 'npx ironbird scenario run', 'npx ironbird reload', 'npx ironbird screenshot']) expect(skill, command).toContain(command);
    expect(skill).toContain('references/scenarios.md');
  });

  it('never names the example app, its commands, or its bug', async () => {
    for (const file of ['SKILL.md', 'references/scenarios.md']) expect(await read(file), file).not.toMatch(LEAKS);
  });
});
```

- [ ] **Step 2: Write the failing packaging test**

Create `packages/cli/test/package.integration.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Spec §8, packaging: `agent setup` copies the skill from the installed package, so it must be in
// the tarball users install, not only in the repository.
const exec = promisify(execFile);
const cli = path.resolve(__dirname, '..');

describe('the packed @ironbird/cli', () => {
  let dir: string | undefined;

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('ships the ironbird skill with front matter that parses', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-pack-'));
    await exec('pnpm', ['pack', '--pack-destination', dir], { cwd: cli });
    const tarball = (await readdir(dir)).find((name) => name.endsWith('.tgz'));
    if (!tarball) throw new Error(`pnpm pack wrote no tarball to ${dir}`);
    const { stdout: listing } = await exec('tar', ['-tzf', path.join(dir, tarball)]);
    const files = listing.split('\n');
    expect(files).toContain('package/skills/ironbird/SKILL.md');
    expect(files).toContain('package/skills/ironbird/references/scenarios.md');

    const { stdout: skill } = await exec('tar', ['-xOzf', path.join(dir, tarball), 'package/skills/ironbird/SKILL.md']);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(match).not.toBeNull();
    const front = parse(match?.[1] ?? '') as Record<string, unknown>;
    expect(front['name']).toBe('ironbird');
    expect(typeof front['description']).toBe('string');
  }, 60_000);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/agent/skill.test.ts && pnpm exec vitest run --project serial packages/cli/test/package.integration.test.ts`
Expected: FAIL. `skill.test.ts`: `ENOENT: no such file or directory, open '.../packages/cli/skills/ironbird/SKILL.md'` in every test. (The `&&` stops there; run the second command on its own to see `expected [ ... ] to include 'package/skills/ironbird/SKILL.md'`.)

- [ ] **Step 4: Write `SKILL.md`**

Create `packages/cli/skills/ironbird/SKILL.md`:

```markdown
---
name: ironbird
description: Use when reproducing, fixing, or verifying behavior in a React Native app that has ironbird set up (an ironbird.config.ts in the project, or ironbird_* MCP tools available). Drives the app's declared commands and fakes headlessly and on a device, pins the bug down as a scenario file, and reports only what was checked, with evidence.
---

# ironbird

ironbird drives a React Native app through the commands the app declares. A daemon, `ironbird serve`, hosts the targets:

- `headless` runs the app's logic in Node, with a manual clock and fakes standing in for the outside world. It is fast and deterministic, and it is where most of the work happens.
- A connected app, such as `ios` or `android`, is the real app on a simulator or device, with a real clock. It needs Metro and the app running.

Use the `ironbird_*` MCP tools when you have them, and the CLI (`npx ironbird <command>`) otherwise. Every step below names both, and both return the same JSON. MCP durations are milliseconds; the CLI also takes `ms`, `s`, and `m` suffixes.

You act only through declared commands and fake controls. There is no way to run arbitrary code in the app; don't look for one.

## The loop

Work through the six steps in order. Each one ends with something you can show.

### 1. Orient

| Do | MCP | CLI |
|---|---|---|
| Check the daemon and list targets | `ironbird_status` | `npx ironbird status` |
| Read commands, fakes, capabilities | `ironbird_describe` | `npx ironbird commands`, `npx ironbird fakes` |

Read every command's payload schema and every fake's controls before sending anything. Capabilities say what a target supports: `clock`, `reset`, `reload`, `fakes`.

If no daemon answers (`NO_TARGET`, "Daemon unreachable"), start one in the background from the project root with `npx ironbird serve`, leave it running, and retry. For device checks the app must also appear in `ironbird_status`; if it doesn't, say so rather than guessing.

### 2. Reproduce headlessly

Drive the `headless` target until state shows the reported bug.

| Do | MCP | CLI |
|---|---|---|
| Start from a fresh app | `ironbird_reset` | `npx ironbird reset` |
| Send a command | `ironbird_send` | `npx ironbird send <command> '<json>'` |
| Act as the outside world | `ironbird_fake` | `npx ironbird fake <fake> <control> '<json>'` |
| Move time forward | `ironbird_clock_advance` | `npx ironbird clock advance <duration>` |
| Read state | `ironbird_state` | `npx ironbird state [path]` |
| Wait for a condition | `ironbird_wait` | `npx ironbird wait <path> --equals <value>` |
| See what happened | `ironbird_events`, `ironbird_fake_calls` | `npx ironbird events`, `npx ironbird fake <fake> --calls` |
| Check pending work | `ironbird_settle`, `ironbird_clock_now` | `npx ironbird settle`, `npx ironbird clock now` |

Bugs that happen "sometimes" usually depend on when and in what order the outside world answers. Use fake controls and clock advances to try the orderings a real network, server, or device can produce: answers that arrive late, twice, out of order, or never. Change one thing at a time and read state after each step.

A step result's `settle` says whether work is still pending. On headless, `idle: false` with `quiescent: true` means the app is waiting on the clock or a fake: advance the clock or run a control. Events and fake calls show what the app asked for, and in which order.

### 3. Pin it down as a scenario

Write a YAML scenario under `ironbird/scenarios/` that replays the steps that showed the bug and ends in an `expect` of the correct behavior. The format is in [references/scenarios.md](references/scenarios.md).

Run it before changing any app code: `ironbird_run_scenario` with `path` set to the file, or `npx ironbird scenario run <file>`. It must fail at the `expect` you wrote, with the wrong value in `failedStep.actual`. A scenario that passes before the fix does not reproduce the bug: go back to step 2.

Write it so the same file runs on a device too: mark `clock` steps `optional: true`, because devices have no clock control, and `screenshot` steps `optional: true`, because headless has no screen.

### 4. Fix

Change the app code. Then reload before checking anything: `ironbird_reload`, or `npx ironbird reload`. Reload loads your current code from a fresh start. `reset` re-runs the code the daemon loaded earlier, so a check after only a `reset` runs the old code.

If reload fails with `HEADLESS_LOAD_FAILED`, the target stays unusable until a reload succeeds: fix the load error and reload again.

Run the scenario until it passes. Then run the whole folder (`path` set to `ironbird/scenarios`, or `npx ironbird scenario run ironbird/scenarios`) and the project's own tests, to catch regressions.

### 5. Check on a device

Reload the device target so it runs the fixed code from a fresh start: `ironbird_reload` with `target` set to it, such as `ios`, or `npx ironbird reload --target ios`. Use the `target` id the reload returns from then on.

Run the same scenario with `target` set to that id. A device app has no `reset`, so the run starts from the state the reload left. Then capture the end state with `ironbird_screenshot`, or `npx ironbird screenshot --target <id>`, and look at it. `ironbird_step` (`npx ironbird step <command> '<json>'`) sends one command on a device and returns a screenshot with the result.

### 6. Report with evidence

- Never write "verified", "fixed", or "passes" without quoting the run that shows it: `passed: true`, its `target`, and its `artifacts` path.
- A run counts only if it used the final scenario file, came after your last code edit, and came after a reload of that target.
- Name every target you checked. If a check could not run, for example because no device was connected, report it as not done and say why. Never report it as passed.
- Name the scenario file and the assertion it makes, what the bug was, and what you changed.

## Results and errors

`ironbird_run_scenario` returns `{ results }`, one per file. The CLI prints one result per line. Each has `scenario`, `file`, `target`, `passed`, `stepsRun`, `skipped` (optional steps the target could not run), `failedStep` (`index`, `step`, then `expected` and `actual`, or `error`), and `artifacts`, the run folder. That folder holds `result.json`, a copy of the scenario file, `events.jsonl`, `state.json`, each fake's calls, and any screenshots.

Errors are `{ "error": { "code", "message", "details" } }`; MCP tools also set `isError`. The common ones:

| Code | What to do |
|---|---|
| `NO_TARGET` | Start `npx ironbird serve`, or connect the app, then check `ironbird_status` |
| `UNKNOWN_COMMAND`, `UNKNOWN_FAKE`, `UNKNOWN_CONTROL` | Use a name from `ironbird_describe`; `details.suggestions` lists near misses |
| `INVALID_PAYLOAD` | Fix the fields in `details.issues` against the payload schema |
| `UNSUPPORTED` | The target lacks that capability: clock and reset are headless only, screenshots device only |
| `WAIT_TIMEOUT` | `details.value` is the last value read; advance the clock or run a fake control first |
| `INVALID_SCENARIO` | Fix the file at the lines in `details.issues`; nothing ran |
| `TARGET_DISCONNECTED` | A reset or reload abandoned the call, or the app went away; check `ironbird_status` |
| `HEADLESS_LOAD_FAILED` | The app code does not load; fix it and reload |
```

- [ ] **Step 5: Write the scenario reference**

Create `packages/cli/skills/ironbird/references/scenarios.md`:

````markdown
# Scenario files

A scenario is a YAML file that replays a sequence of steps against one target and checks the result. Keep them under `ironbird/scenarios/`. Run one file or a folder with `ironbird_run_scenario` (`path`, `target?`, `bail?`) or `npx ironbird scenario run <path...> [--target <id>] [--bail]`.

```yaml
name: Refresh shows mail that arrives while offline
description: Optional; say what the scenario proves.
steps:
  - fake: mail
    control: goOffline
  - send: inbox.refresh
  - clock: 2s
    optional: true      # headless only; a device skips it
  - fake: mail
    control: deliver
    payload: { count: 2 }
  - wait: inbox.status
    equals: loaded
  - expect: inbox.unread
    equals: 2
  - screenshot: inbox
    optional: true      # devices only; headless skips it
```

The names above are made up. Take real command, fake, and control names and payload shapes from `ironbird_describe`.

## Top level

`name` (required), `description`, `target` (the tool's `target` or `--target` overrides it), and a non-empty `steps` list. Unknown keys are errors, so a typo fails before anything runs.

## Steps

Each step is exactly one kind, named by its key, plus an optional `optional: true`.

| Step | Fields | Does | Runs on |
|---|---|---|---|
| `send` | command name, `payload?` (default `{}`), `repeat?`, `settle?` (default `true`) | Dispatches the command and settles | Every target |
| `fake` | `fake`, `control`, `payload?`, `repeat?`, `settle?` | Runs a fake control and settles | Targets with `fakes` that wire that fake |
| `clock` | duration, `settle?` | Advances the manual clock | Targets with `clock` (headless) |
| `wait` | state path, one condition, `timeout?` (default 5 s) | Waits for the condition | Every target |
| `expect` | state path, one condition | Reads state once and checks it | Every target |
| `screenshot` | a name for the file | Captures the screen into the run folder | Devices |
| `reset` | `reset: true` | Restarts the app fresh | Targets with `reset` (headless) |

- **Durations:** a number of milliseconds, or a string with `ms`, `s`, or `m`, such as `300ms` or `2s`.
- **Conditions:** exactly one of `equals: <value>`, `notEquals: <value>`, `exists: true|false`, or `matches: <regular expression>`. Values compare as JSON, deeply.
- **`optional: true`:** skip the step, instead of failing, when the target can't run it. Its index goes in `skipped`. Use it on `clock` and `screenshot` steps so one file runs on both headless and a device.
- **`repeat: n`:** runs a `send` or `fake` step n times; a failure names the `repetition`.
- **`settle`:** a `send`, `fake`, or `clock` step that ends neither idle nor quiescent fails the scenario. `settle: false` skips waiting for effects.
- YAML 1.2 rules apply: `on` and `yes` are strings. Quote a string that looks like a number.

Whether a step can run is decided from `describe` before it runs. Each file starts from a fresh app on headless; a device runs against its current state, so reload it first.

## Failures

The run stops at the first failing step, and the result's `failedStep` says why:

| Failure | `failedStep` carries |
|---|---|
| An `expect` did not hold, or a `wait` timed out | `expected` (the condition) and `actual` (the value read) |
| A step did not settle | `actual: { settle }` with what is still pending |
| The target can't run a non-optional step | `error` with `UNSUPPORTED`, or `UNKNOWN_FAKE` for a fake it doesn't wire |
| Anything else | `error`, such as `INVALID_PAYLOAD`, `DISPATCH_FAILED`, or `TARGET_DISCONNECTED` |

An invalid file is reported as `INVALID_SCENARIO` with every problem and its line in `details.issues`, and no file runs.
````

- [ ] **Step 6: Ship the skill in the package**

In `packages/cli/package.json`, replace:

```json
  "files": [
    "dist"
  ],
```

with:

```json
  "files": [
    "dist",
    "skills"
  ],
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/agent/skill.test.ts && pnpm exec vitest run --project serial packages/cli/test/package.integration.test.ts`
Expected: PASS, 4 unit tests and 1 serial test. If the length test fails, move detail from `SKILL.md` into `references/scenarios.md` rather than cutting a loop step.

- [ ] **Step 8: Write docs/agents.md**

Create `docs/agents.md`:

````markdown
# ironbird: Agent setup

| | |
|---|---|
| Status | Draft |
| Last updated | 2026-09-29 |
| Related | [cli.md](cli.md) (`mcp`, `agent setup`, "MCP tools") · [architecture.md](architecture.md) |

ironbird gives a coding agent two things: an MCP server, `ironbird mcp`, whose tools drive your app through its declared commands, and a skill that teaches the agent a loop for using them. The loop: reproduce a bug headlessly, pin it down as a scenario, fix it, check it on a device, and report with evidence. This page sets both up.

## Set up

In the project root, with `@ironbird/cli` installed as a dev dependency and the app integrated (see [architecture.md](architecture.md#5-integrating-an-app)), run:

```sh
npx ironbird agent setup
```

It does two things and prints what it did as `{ skill: { dir, files }, mcp: { file, updated } }`:

- Copies the skill into `.claude/skills/ironbird/`: `SKILL.md` and `references/scenarios.md`. Other files in that folder are left alone.
- Adds an `ironbird` entry to `mcpServers` in `.mcp.json`, creating the file if needed. Other servers and keys are kept.

```json
{
  "mcpServers": {
    "ironbird": { "command": "npx", "args": ["ironbird", "mcp"] }
  }
}
```

Commit both, so every contributor and every agent session gets the same setup. Run the command again after upgrading `@ironbird/cli`: the skill is versioned with the CLI, and a rerun brings it up to date. If `.mcp.json` exists but isn't a JSON object, or its `mcpServers` isn't one, the command fails with `INVALID_CONFIG` and changes nothing.

Install `@ironbird/cli` locally, so `npx ironbird` runs the project's version rather than downloading one. Claude Code picks up the skill and the server at the start of the next session, and asks once before trusting a project's `.mcp.json` servers.

## What the tools need

- **A running daemon.** Start it in the project root and leave it running: `npx ironbird serve`. The MCP server doesn't start it, but finds it on every tool call, so the order you start them in doesn't matter and restarting the daemon needs no agent restart. Until a daemon answers, every tool fails with `NO_TARGET` and a message saying to run `ironbird serve`; the skill tells the agent to start it.
- **For device checks, Metro and the app.** The app runs on a simulator or device with the bridge started, so it appears as a target such as `ios` in `npx ironbird status`. Screenshots use `xcrun simctl` or `adb` on the same machine as the daemon and the MCP server.
- **A token, for a daemon bound beyond localhost.** Put it in `IRONBIRD_TOKEN` in the agent's environment.

The headless target needs only the daemon. It is where agents should do most of their work: it is fast and deterministic, and it has clock and fake controls that a device lacks.

## The loop

The skill ([`SKILL.md`](../packages/cli/skills/ironbird/SKILL.md)) teaches six steps, each with its MCP tool and CLI equivalent:

1. **Orient:** `ironbird_status`, then `ironbird_describe` for commands, fakes, and capabilities.
2. **Reproduce headlessly:** drive commands, fake controls, and clock advances; read state, events, and fake calls.
3. **Pin it down as a scenario:** a YAML file under `ironbird/scenarios/` that fails before the fix.
4. **Fix:** change the code, `ironbird_reload`, and run the scenario until it passes; then the whole folder and the project's tests.
5. **Check on a device:** `ironbird_reload` the device target, run the same scenario on it, and take a screenshot.
6. **Report with evidence:** every "verified" quotes a passing run's `passed`, target, and artifacts path, and a check that could not run is reported as not done.

The skill is app-agnostic. It knows the tools and the loop, and learns your app from `ironbird_describe`.

## Other agents

The skill is in the Agent Skills format, so any agent that reads that format can use it. Point `--skills-dir` at the folder your agent reads skills from; `.mcp.json` is updated either way:

```sh
npx ironbird agent setup --skills-dir <your agent's skills folder>
```

For an agent that keeps MCP servers in its own configuration, register a stdio server that runs `npx ironbird mcp` in the project root, adding `--daemon <url>` if the daemon can't be found from there. An agent without MCP can follow the same skill through its CLI column: every tool has a CLI command that prints the same JSON.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every tool fails with `NO_TARGET`, "Daemon unreachable" | No daemon; run `npx ironbird serve` in the project root |
| `ironbird_step` or `ironbird_screenshot` fails with `NO_TARGET` | No app connected; start Metro and the app, then check `npx ironbird status` |
| `AMBIGUOUS_DEVICE` from a screenshot | Several simulators are booted; set `devices.ios` in the config or pass `device` |
| A headless check still shows the old behavior after an edit | `reset` re-runs the code loaded earlier; call `ironbird_reload` |
| `UNAUTHORIZED` | The daemon has a token; set `IRONBIRD_TOKEN` for the agent |
````

- [ ] **Step 9: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 10: Commit**

```sh
git add packages/cli/skills packages/cli/package.json packages/cli/src/agent/skill.test.ts packages/cli/test/package.integration.test.ts docs/agents.md
git commit -m "Add the ironbird agent skill"
```

---

### Task 5: `ironbird agent setup`

**Files:**
- Create: `packages/cli/src/agent/setup.ts`
- Create: `packages/cli/src/agent/setup.test.ts`
- Modify: `packages/cli/src/cli/program.ts` (imports, the `agent setup` command)
- Modify: `packages/cli/src/cli/program.test.ts` (imports, an `agent setup` describe block)
- Modify: `packages/cli/src/index.ts`
- Modify: `docs/cli.md` (new `agent setup` section after `mcp`)

**Interfaces:**
- Consumes: the packaged skill folder `packages/cli/skills/ironbird/` (Task 4); `IronbirdError`, `deepEqual(a: unknown, b: unknown): boolean`, `messageOf` from `@ironbird/core`; `createOutput`, `exitCodeForError` (exist; `INVALID_CONFIG` maps to exit 2).
- Produces, in `packages/cli/src/agent/setup.ts`:
  - `export interface AgentSetupOptions { cwd: string; skillsDir?: string; packageRoot: string }`
  - `export interface AgentSetupResult { skill: { dir: string; files: string[] }; mcp: { file: string; updated: boolean } }` (`dir` and `file` are absolute; `files` are relative to `dir`, with `/` separators, sorted)
  - `export async function agentSetup(options: AgentSetupOptions): Promise<AgentSetupResult>`
  - `export async function findPackageRoot(start: string): Promise<string>` (internal to the package; not exported from `index.ts`)
  - the command `ironbird agent setup [--skills-dir <dir>]`; `@ironbird/cli` exports `agentSetup` and the types `AgentSetupOptions`, `AgentSetupResult`.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/cli/src/agent/setup.test.ts`:

```ts
import { IronbirdError } from '@ironbird/core';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentSetup, findPackageRoot } from './setup';

const ENTRY = { command: 'npx', args: ['ironbird', 'mcp'] };
const SKILL_V2 = '---\nname: ironbird\ndescription: v2\n---\n';

describe('agentSetup', () => {
  let root: string;
  let project: string;
  let pkg: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ironbird-agent-'));
    project = path.join(root, 'project');
    pkg = path.join(root, 'pkg');
    await mkdir(project);
    await mkdir(path.join(pkg, 'skills/ironbird/references'), { recursive: true });
    await writeFile(path.join(pkg, 'skills/ironbird/SKILL.md'), SKILL_V2);
    await writeFile(path.join(pkg, 'skills/ironbird/references/scenarios.md'), '# Scenarios v2\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const read = (file: string): Promise<string> => readFile(path.join(project, file), 'utf8');

  it('installs the skill and creates .mcp.json in a fresh project', async () => {
    expect(await agentSetup({ cwd: project, packageRoot: pkg })).toEqual({
      skill: { dir: path.join(project, '.claude/skills/ironbird'), files: ['SKILL.md', 'references/scenarios.md'] },
      mcp: { file: path.join(project, '.mcp.json'), updated: true },
    });
    expect(await read('.claude/skills/ironbird/SKILL.md')).toBe(SKILL_V2);
    expect(await read('.claude/skills/ironbird/references/scenarios.md')).toBe('# Scenarios v2\n');
    expect(await read('.mcp.json')).toBe(`${JSON.stringify({ mcpServers: { ironbird: ENTRY } }, null, 2)}\n`);
  });

  it('keeps other servers and keys, replaces only the ironbird entry, and leaves files it does not own alone', async () => {
    await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other-mcp' }, ironbird: { command: 'node', args: ['old.js'] } }, extra: true }));
    await mkdir(path.join(project, '.claude/skills/ironbird'), { recursive: true });
    await writeFile(path.join(project, '.claude/skills/ironbird/SKILL.md'), 'old skill');
    await writeFile(path.join(project, '.claude/skills/ironbird/NOTES.md'), 'mine');
    expect((await agentSetup({ cwd: project, packageRoot: pkg })).mcp.updated).toBe(true);
    expect(JSON.parse(await read('.mcp.json'))).toEqual({ mcpServers: { other: { command: 'other-mcp' }, ironbird: ENTRY }, extra: true });
    expect((await read('.mcp.json')).endsWith('}\n')).toBe(true);
    expect(await read('.claude/skills/ironbird/SKILL.md')).toBe(SKILL_V2);
    expect(await read('.claude/skills/ironbird/NOTES.md')).toBe('mine');
  });

  it('run again, updates the skill and reports updated false without rewriting an identical entry', async () => {
    await agentSetup({ cwd: project, packageRoot: pkg });
    const byHand = '{"mcpServers":{"ironbird":{"command":"npx","args":["ironbird","mcp"]}}}';
    await writeFile(path.join(project, '.mcp.json'), byHand);
    await writeFile(path.join(pkg, 'skills/ironbird/SKILL.md'), '---\nname: ironbird\ndescription: v3\n---\n');
    const again = await agentSetup({ cwd: project, packageRoot: pkg });
    expect(again.mcp.updated).toBe(false);
    expect(await read('.mcp.json')).toBe(byHand);
    expect(await read('.claude/skills/ironbird/SKILL.md')).toContain('v3');
  });

  it('puts the skill under skillsDir, relative to the project or absolute', async () => {
    const relative = await agentSetup({ cwd: project, packageRoot: pkg, skillsDir: '.agents/skills' });
    expect(relative.skill.dir).toBe(path.join(project, '.agents/skills/ironbird'));
    expect(await read('.agents/skills/ironbird/SKILL.md')).toBe(SKILL_V2);
    const elsewhere = path.join(root, 'shared-skills');
    const absolute = await agentSetup({ cwd: project, packageRoot: pkg, skillsDir: elsewhere });
    expect(absolute.skill.dir).toBe(path.join(elsewhere, 'ironbird'));
    expect(await readFile(path.join(elsewhere, 'ironbird/SKILL.md'), 'utf8')).toBe(SKILL_V2);
  });

  it.each<[string, string, string[]]>([
    ['not JSON', '{ "mcpServers": ', []],
    ['empty', '', []],
    ['an array', '[]', []],
    ['null', 'null', []],
    ['holding a list of servers', '{"mcpServers":[]}', ['mcpServers']],
  ])('fails with INVALID_CONFIG and writes nothing when .mcp.json is %s', async (_label, content, issuePath) => {
    await writeFile(path.join(project, '.mcp.json'), content);
    await expect(agentSetup({ cwd: project, packageRoot: pkg })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { file: path.join(project, '.mcp.json'), issues: [{ path: issuePath }] },
    });
    expect(await read('.mcp.json')).toBe(content);
    await expect(stat(path.join(project, '.claude'))).rejects.toThrow();
  });

  it('fails with INTERNAL naming the folder when the package has no skill', async () => {
    const empty = path.join(root, 'empty-pkg');
    await expect(agentSetup({ cwd: project, packageRoot: empty })).rejects.toMatchObject({ code: 'INTERNAL', details: { file: path.join(empty, 'skills', 'ironbird') } });
    await expect(stat(path.join(project, '.mcp.json'))).rejects.toThrow();
  });

  it('turns an unwritable skill folder into an IronbirdError naming the file, and leaves .mcp.json untouched', async () => {
    // A regular file where a folder must go fails mkdir on every platform, even when run as root.
    await writeFile(path.join(project, 'blocker'), 'not a folder');
    const attempt = agentSetup({ cwd: project, packageRoot: pkg, skillsDir: 'blocker/skills' });
    await expect(attempt).rejects.toBeInstanceOf(IronbirdError);
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL', details: { file: path.join(project, 'blocker/skills/ironbird/SKILL.md'), message: expect.any(String) } });
    await expect(stat(path.join(project, '.mcp.json'))).rejects.toThrow();
  });
});

describe('findPackageRoot', () => {
  it('walks up to the @ironbird/cli package', async () => {
    expect(await findPackageRoot(__dirname)).toBe(path.resolve(__dirname, '../..'));
  });

  it('fails with INTERNAL outside the package', async () => {
    await expect(findPackageRoot(tmpdir())).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/agent/setup.test.ts`
Expected: FAIL with `Failed to resolve import "./setup"`.

- [ ] **Step 3: Write `setup.ts`**

Create `packages/cli/src/agent/setup.ts`:

```ts
import { IronbirdError, deepEqual, messageOf } from '@ironbird/core';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AgentSetupOptions {
  /** The project root: `.mcp.json` lives here and a relative `skillsDir` resolves against it. */
  cwd: string;
  /** Where Agent Skills live; default `.claude/skills`. The skill goes in `<skillsDir>/ironbird/`. */
  skillsDir?: string;
  /** The installed `@ironbird/cli` package, which holds `skills/ironbird/`. */
  packageRoot: string;
}

export interface AgentSetupResult {
  /** `dir` is absolute; `files` are the skill's files relative to it, with `/` separators. */
  skill: { dir: string; files: string[] };
  /** `updated` is false when `.mcp.json` already held this exact entry and was left untouched. */
  mcp: { file: string; updated: boolean };
}

const DEFAULT_SKILLS_DIR = '.claude/skills';
const MCP_ENTRY = { command: 'npx', args: ['ironbird', 'mcp'] };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const invalid = (file: string, at: string[], message: string): IronbirdError =>
  new IronbirdError('INVALID_CONFIG', `Invalid ${file}: ${at.length === 0 ? '' : `${at.join('.')}: `}${message}`, { file, issues: [{ path: at, message }] });

/**
 * Reads and checks `.mcp.json` before anything is written, so an invalid file leaves the project
 * exactly as it was (spec §6.2). Undefined means the file does not exist.
 */
async function readMcpConfig(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new IronbirdError('INTERNAL', `Could not read ${file}: ${messageOf(error)}`, { file, message: messageOf(error) });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(file, [], `not valid JSON: ${messageOf(error)}`);
  }
  if (!isObject(parsed)) throw invalid(file, [], 'expected a JSON object');
  // Replacing a non-object here would throw away whatever the user keeps in it.
  if (parsed['mcpServers'] !== undefined && !isObject(parsed['mcpServers'])) throw invalid(file, ['mcpServers'], 'expected an object');
  return parsed;
}

/** Every file under `root`, relative to it with `/` separators, in name order. */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(prefix === '' ? root : path.join(root, ...prefix.split('/')), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** Runs one filesystem write, turning a Node error into `INTERNAL` naming the file, so no raw fs error leaves this public API (AGENTS.md hard rule 8). */
async function writing(file: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    throw new IronbirdError('INTERNAL', `Could not write ${file}: ${messageOf(error)}`, { file, message: messageOf(error) });
  }
}

/**
 * Installs the packaged skill into `<skillsDir>/ironbird/`, replacing the files it owns and leaving
 * others alone, and adds or replaces only `mcpServers.ironbird` in `.mcp.json` (spec §6.2).
 *
 * Everything that can be checked is checked before the first write: `.mcp.json` is read and
 * validated and the packaged skill is listed first, so an invalid config or a broken install
 * writes nothing. `.mcp.json` is written last, so a skill folder that can't be written leaves it
 * untouched. Every failure is an `IronbirdError`.
 */
export async function agentSetup(options: AgentSetupOptions): Promise<AgentSetupResult> {
  const mcpFile = path.resolve(options.cwd, '.mcp.json');
  const existing = await readMcpConfig(mcpFile);

  const source = path.join(options.packageRoot, 'skills', 'ironbird');
  let files: string[];
  try {
    files = await listFiles(source);
  } catch (error) {
    throw new IronbirdError('INTERNAL', `The ironbird skill is missing from ${source}; reinstall @ironbird/cli`, { file: source, message: messageOf(error) });
  }
  if (files.length === 0) throw new IronbirdError('INTERNAL', `The ironbird skill is missing from ${source}; reinstall @ironbird/cli`, { file: source, message: 'no files' });

  const dir = path.resolve(options.cwd, options.skillsDir ?? DEFAULT_SKILLS_DIR, 'ironbird');
  for (const file of files) {
    const to = path.join(dir, ...file.split('/'));
    await writing(to, async () => {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(path.join(source, ...file.split('/')), to);
    });
  }

  const servers = (existing?.['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  const updated = !deepEqual(servers['ironbird'], MCP_ENTRY);
  if (updated) {
    // Spreading keeps every other key, and an existing key keeps its position in the file.
    const next = { ...(existing ?? {}), mcpServers: { ...servers, ironbird: MCP_ENTRY } };
    await writing(mcpFile, () => writeFile(mcpFile, `${JSON.stringify(next, null, 2)}\n`));
  }
  return { skill: { dir, files }, mcp: { file: mcpFile, updated } };
}

/** The directory of the `@ironbird/cli` package that holds `start`, found by walking up to its `package.json`. */
export async function findPackageRoot(start: string): Promise<string> {
  let dir = path.resolve(start);
  for (;;) {
    const manifest = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => undefined);
    if (manifest !== undefined) {
      try {
        if ((JSON.parse(manifest) as { name?: unknown }).name === '@ironbird/cli') return dir;
      } catch {
        // Not a manifest we can read; keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new IronbirdError('INTERNAL', `Could not find the @ironbird/cli package above ${start}`, { message: `no @ironbird/cli package.json above ${start}` });
    dir = parent;
  }
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/agent/setup.test.ts`
Expected: PASS, 12 tests (5 of them from the `it.each`).

- [ ] **Step 5: Write the failing program tests**

In `packages/cli/src/cli/program.test.ts`, replace the `node:fs/promises` import with:

```ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
```

Add at the end of the file:

```ts
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
```

`mkdir` stays in the import for the `scenario run` block.

- [ ] **Step 6: Run the program tests to verify they fail**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts -t "agent setup"`
Expected: FAIL, `expected 2 to be 0` (commander: `unknown command 'agent'`), and the INVALID_CONFIG test fails on `h.out()` because commander's usage error goes to stderr and stdout is empty.

- [ ] **Step 7: Add the command**

In `packages/cli/src/cli/program.ts`, add after `import path from 'node:path';`:

```ts
import { fileURLToPath } from 'node:url';
```

Insert immediately after the `mcp` command added in Task 3 (still before the final `return {`):

```ts
  const agent = program.command('agent').description('Set up coding agents');
  agent
    .command('setup')
    .description('Install the ironbird skill and register the MCP server in .mcp.json; needs no daemon')
    .option('--skills-dir <dir>', 'the folder your agent reads Agent Skills from', '.claude/skills')
    .action(async (opts: { skillsDir: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const output = createOutput({ json: Boolean(globals.json) || !io.isTTY, write: io.stdout });
      try {
        const { agentSetup, findPackageRoot } = await import('../agent/setup');
        // The skill ships next to `dist/` in the installed package; this module runs from a chunk
        // in `dist/` there, and from `src/cli/` in this repository's tests.
        const packageRoot = await findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
        output.result(await agentSetup({ cwd: io.cwd, skillsDir: opts.skillsDir, packageRoot }));
        exitCode = 0;
      } catch (error) {
        const shape = toErrorShape(error);
        output.error(shape);
        exitCode = exitCodeForError(shape.code);
      }
    });
```

In `packages/cli/src/index.ts`, add at the end:

```ts
export { agentSetup } from './agent/setup';
export type { AgentSetupOptions, AgentSetupResult } from './agent/setup';
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit packages/cli/src/cli/program.test.ts packages/cli/src/agent/setup.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Check the built binary finds its skill**

Run: `pnpm --filter @ironbird/cli build && cd "$(mktemp -d)" && node /Users/sunkibaek/apps/ironbird/packages/cli/dist/bin.js agent setup --json && ls .claude/skills/ironbird .claude/skills/ironbird/references && cat .mcp.json`
Expected: one JSON line with `updated: true`; the listing shows `SKILL.md`, `references`, and `scenarios.md`; `.mcp.json` holds the `ironbird` entry. This proves `findPackageRoot` works from the bundled `dist/` chunk, which the unit tests cannot.

- [ ] **Step 10: Document the command**

In `docs/cli.md`, insert this section immediately after the `mcp` section written in Task 3 (before `## Scenario files`):

````markdown
### agent setup

```text
ironbird agent setup [--skills-dir <dir>]
```

Sets up coding agents in the project, the working directory, without a daemon: it copies the ironbird skill that ships with this CLI into `<skills-dir>/ironbird/` (default `.claude/skills`), replacing the files it owns and leaving any other files in that folder alone, and adds or replaces only the `mcpServers.ironbird` entry in `.mcp.json`, creating the file if needed:

```json
{ "mcpServers": { "ironbird": { "command": "npx", "args": ["ironbird", "mcp"] } } }
```

Other servers and keys are kept, and the file is written with two-space indentation and a trailing newline; when the entry is already identical, the file is left untouched. Running it again after an upgrade brings the skill up to date with the installed CLI. For Codex and other agents that read Agent Skills, pass their skills folder as `--skills-dir`; a relative path resolves against the working directory. See [agents.md](agents.md).

Prints `{ skill: { dir, files }, mcp: { file, updated } }`: `dir` and `file` are absolute, `files` are the skill's files relative to `dir`, and `updated` is false when the entry was already identical. If `.mcp.json` exists but is not a JSON object, or its `mcpServers` is not an object, it fails with `INVALID_CONFIG`, details `{ file, issues }`, exit 2, and writes nothing, including the skill. A skill file or `.mcp.json` that can't be written fails with `INTERNAL`, details `{ file, message }`, exit 1; the skill is written before `.mcp.json`, so a skill folder that can't be written leaves `.mcp.json` untouched.
````

- [ ] **Step 11: Typecheck, lint, and run the suites**

Run: `pnpm --filter @ironbird/cli typecheck && pnpm lint && pnpm test`
Expected: no errors; every unit and serial test passes.

- [ ] **Step 12: Commit**

```sh
git add packages/cli/src/agent/setup.ts packages/cli/src/agent/setup.test.ts packages/cli/src/cli/program.ts packages/cli/src/cli/program.test.ts packages/cli/src/index.ts docs/cli.md
git commit -m "Add ironbird agent setup"
```

---

### Task 6: Architecture, API docs, and the changeset

**Files:**
- Modify: `docs/architecture.md` (§12 table)
- Modify: `docs/api.md` (`@ironbird/cli` section)
- Create: `.changeset/m3-agent-interface.md`

**Interfaces:**
- Consumes: everything above; plan 1's reload behavior (spec D4, D5) for the §12 row.
- Produces: docs and the release note only.

- [ ] **Step 1: Add the §12 row for D4**

In `docs/architecture.md`, §12 "Decisions", add this row at the end of the table, after the `@ironbird/core` row:

```markdown
| A `reload` operation loads the app's current code from a fresh start on both target kinds, and a failed headless reload leaves the target unusable until a reload succeeds | Here: the daemon bundles the headless entry once and `reset` re-runs that bundle, so without `reload` an agent's check after a fix silently runs the old code; an agent must never verify against code it already replaced (M3 design D4, D5) |
```

- [ ] **Step 2: Document the new exports**

In `docs/api.md`, in the `## @ironbird/cli` section, append this sentence to the end of the paragraph that begins "The binary is documented in [cli.md](cli.md).":

```markdown
 For agents, `createMcpServer` builds the `ironbird mcp` server, an `McpServer` from `@modelcontextprotocol/server` with the sixteen tools in [cli.md](cli.md#mcp-tools), from `McpServerOptions`: its `version`, the `cwd` that scenario paths resolve against, a `resolve` called on every tool call that returns a `DaemonClient` and the artifacts directory, and an optional `readImage` for screenshots. `agentSetup` does what `ironbird agent setup` does, given `AgentSetupOptions` (`cwd`, `skillsDir?`, and the `packageRoot` holding `skills/ironbird/`), and returns an `AgentSetupResult`.
```

(The sentence continues the same paragraph; keep the single leading space so it follows the previous sentence.)

- [ ] **Step 3: Write the changeset**

Create `.changeset/m3-agent-interface.md`:

```md
---
"@ironbird/cli": patch
---
Agent interface. `ironbird mcp` is now a stdio MCP server built on `@modelcontextprotocol/server` 2.x (a new dependency) with sixteen tools, one per daemon operation plus `ironbird_run_scenario`, which runs the scenario runner in process with the same validation, per-file reset, `bail`, and artifacts as `scenario run`. Inputs are Zod 4 schemas; each result is one text block holding the JSON the CLI prints, `ironbird_step` and `ironbird_screenshot` add the PNG as image content, and failures are `isError` results holding the CLI's error JSON. The server finds the daemon on every tool call, so it can start first and survives a daemon restart, and writes nothing but MCP messages to stdout. The package now ships an app-agnostic Agent Skills skill in `skills/ironbird/` that teaches the reproduce, pin down, fix, device check, and report-with-evidence loop, and `ironbird agent setup [--skills-dir <dir>]` installs it (default `.claude/skills`) and adds only the `mcpServers.ironbird` entry to `.mcp.json`, failing with `INVALID_CONFIG` and writing nothing when `.mcp.json` is not a JSON object. `@ironbird/cli` exports `createMcpServer` and `agentSetup` with their option and result types.
```

- [ ] **Step 4: Run everything**

Run: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`
Expected: the build succeeds, lint and typecheck report nothing, and every unit and serial test passes. Then run `pnpm test` once more under Node 22 (`nvm use 22` or equivalent), as CI does, before pushing.

- [ ] **Step 5: Commit**

```sh
git add docs/architecture.md docs/api.md .changeset/m3-agent-interface.md
git commit -m "Document the agent interface and add its changeset"
```

The PR description carries the dependency line from Global Constraints and says which exit criterion this moves: it builds what the eval (plan 3) measures; the criterion itself is measured there.

---

## Spec discrepancies

None of the spec and the contract contradict each other. These points the spec leaves open are decided here rather than silently:

1. **Result shapes.** Spec §5.1's "Returns" column lists `ironbird_state` as `{ rev, path, value }` but `ironbird_reset` as `{ target, rev, path, value }`, and `ironbird_fake_calls` without `fake`. The plan returns exactly what the CLI prints for the same operation (the daemon's result with `target` added when missing, and `fake` for fake calls), so a result reads the same in both surfaces; every field the spec lists is present. cli.md's new table shows the actual shapes.
2. **Error text.** Spec §5.1 says the failure text holds "the same `{ code, message, details }` JSON the CLI prints"; the CLI prints it under an `error` key. The plan uses `{ "error": { code, message, details } }`, byte-for-byte the CLI's shape, which also keeps `ErrorShape` unchanged (spec §9).
3. **`ironbird_wait` default timeout.** The spec says `timeoutMs?`; the plan uses the CLI's 5000 ms default.
4. **Unreadable screenshot.** Not covered by the spec. The result stays a success with a text note instead of the image (Review Focus 3).
5. **`mcpServers` that is not an object.** Not covered by the spec. `INVALID_CONFIG`, nothing written (Review Focus 5).
6. **Paths in `agent setup` output.** Not specified. `dir` and `file` are absolute, like `ScenarioResult.file`; `files` are relative to `dir`.
7. **A later file's `describe` failing in `ironbird_run_scenario`.** The CLI prints earlier results and exits with the error's code; an MCP result can't be both. The call returns the error, and earlier runs remain on disk under `runs/`. cli.md says so.
8. **api.md.** The contract does not list it, but AGENTS.md hard rule 6 requires it for the new exports (Task 6).
9. **Other agents' skills folders.** Spec §6.2 mentions Codex; docs/agents.md does not name a specific folder, to avoid documenting a path this repository does not test.

## Self-Review

**Spec coverage.** §5 command and lazy resolution (`--daemon`, `.ironbird/daemon.json`, default URL, `IRONBIRD_TOKEN`, start before the daemon, survive a restart, "start ironbird serve" hint, name `ironbird`, package version, stdout clean): Task 1 (resolve per call, hint via the client's `NO_TARGET` message), Task 3 (command, stdio, child-process test). §5.1 all sixteen tools with Zod 4 objects and `settle` as `boolean | { timeoutMs }`: Tasks 1 and 2, the listing test asserts all sixteen. One JSON text block, image blocks for step and screenshot read from the returned path: Tasks 1 and 2. `isError` with the CLI error JSON, SDK rejection of schema failures before any daemon call: Task 1. `ironbird_run_scenario` (path against the server's cwd, validation first, D14 reset, `bail`, artifacts paths, `INVALID_SCENARIO` as `isError`, failed scenario as a normal result, `{ results }`): Task 2 unit tests, Task 3 integration. Agent-facing descriptions naming the next call (`ironbird_send` points at `ironbird_describe`; `ironbird_run_scenario` suggests `ironbird_reload`): Tasks 1 and 2. §5.2 dependencies and justification: Task 1 Step 1 and the commit body, Global Constraints. §6.1 skill in `skills/ironbird/`, front matter, six-step loop with MCP and CLI columns, `references/scenarios.md`, D7, under 200 lines, evidence rules, target id from reload, `optional: true` clock steps: Task 4 with content tests. `skills` in `files` and the packaging test: Task 4. §6.2 `agent setup` (copy owned files, leave others, default `.claude/skills`, `--skills-dir`, only `mcpServers.ironbird`, create if absent, two-space indent and trailing newline, rerun updates, output shape, `updated` false when identical, `INVALID_CONFIG` exit 2 writing nothing): Task 5. §6.3 `docs/agents.md`: Task 4; cli.md `mcp` and "MCP tools" rewritten without P1 markers: Task 3; `agent setup` section: Task 5; architecture.md §12 row for D4: Task 6; changeset for `@ironbird/cli`: Task 6. Plan 1 owns cli.md's `reload`, `reset`, and `serve` notes, protocol.md, and the core and react-native changesets; plan 3 owns spec.md and roadmap.md. §8 rows owned here: `agent setup` unit tests (fresh project, other servers, run twice, invalid JSON): Task 5; MCP integration in the serial project with every tool's happy path, an `isError`, run_scenario on a file and a folder, image content with a stub capture: Task 3; packaging: Task 4.

**Placeholder scan.** Every code step has complete code or an exact replacement quoted in full. Task 2 edits `server.ts` with a full replacement import block, one added constant, and one insertion before `return server;`; Task 2 edits `server.test.ts` with a full replacement import block, a full replacement constant, one quoted line change, and appended blocks. Task 3 and Task 5 edits to `program.ts` quote the exact import lines and name where each insertion goes. No step says "similar to" or "add handling".

**Type consistency.** `McpServerOptions` matches the contract exactly: `version`, `cwd`, `resolve: () => Promise<{ client: DaemonClient; artifactsDir: string }>`, `readImage?`. `createMcpServer(options): McpServer` and `runMcpStdio(options): Promise<void>` match the contract; `ProgramIo.mcp` has `runMcpStdio`'s signature. `AgentSetupResult` matches the contract; `agentSetup` takes `AgentSetupOptions`, which is the contract's inline `{ cwd, skillsDir?, packageRoot }` given a name. `withTarget` moves from a closure to `output.ts` with the same signature, so plan 1's `reload` command, which calls `withTarget`, keeps compiling. `success`, `failure`, `guard`, `Content`, and `ToolResult` are defined in Task 1 and used unchanged in Task 2; `Screenshot` and `ScenarioResult` come from `@ironbird/core`. `loadScenarioFiles([path], cwd)` and `runScenario(client, scenario, { file, target, artifacts, reset: true })` match their M2 signatures. The test helpers `scriptedClient`, `connect`, `json`, `step`, and `settled` are defined in Task 1 and reused in Task 2; `connect`'s `artifactsDir` option exists from Task 1 on.

**Review Focus.** Each of the five has a test in its owning task: restarted daemon (Task 1, "finds the daemon again on every call"), wait conditions and `null` (Task 1, two tests), unreadable screenshot (Task 2), missing path, empty folder, and relative path (Task 2), `mcpServers` not an object (Task 5, the last `it.each` row).
