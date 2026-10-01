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
      // Positive and at most the timer limit, as the daemon requires for `reload` (plan 1); the other duration
      // inputs accept 0 because the daemon does: a 0 ms wait or settle checks once, and a 0 ms clock advance
      // fires only due timers.
      inputSchema: z.object({
        target,
        timeoutMs: z.number().int().positive().max(2_147_483_647).optional().describe('Connected apps only: how long to wait for the app to come back. Default 60000.'),
      }),
    },
    (input) => guard(async () => success(withTarget(await (await daemon()).call('reload', input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }, input.target)))),
  );

  return server;
}
