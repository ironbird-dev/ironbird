import { IronbirdError, suggestNames, toErrorShape, type Description, type ErrorShape, type SettleResult, type StepResult } from '@ironbird/core';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { createDaemonClient, resolveDaemon, type DaemonClient } from './client';
import { runServe } from './commands/serve';
import { UsageError, parseDuration } from './durations';
import { exitCodeForError, exitCodeForStep } from './exit-codes';
import { createOutput, type Output } from './output';
import { parseJsonOrString, parsePayload } from './values';

export interface ProgramIo {
  cwd: string;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  stdout(text: string): void;
  stderr(text: string): void;
  version: string;
  signal?: AbortSignal;
  createClient?: (options: { url: string; token?: string }) => DaemonClient;
  serve?: typeof runServe;
}

interface GlobalOptions {
  target?: string;
  json?: boolean;
  config?: string;
  daemon?: string;
  token?: string;
}

interface Context {
  output: Output;
  client: DaemonClient;
  target: string | undefined;
}

type Outcome = { value: unknown; exit?: number } | undefined;

const integer = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError('expected a non-negative integer');
  return parsed;
};

const settleParam = (opts: { settle?: boolean; settleTimeout?: string }): boolean | { timeoutMs: number } => {
  if (opts.settle === false) return false;
  return opts.settleTimeout === undefined ? true : { timeoutMs: parseDuration(opts.settleTimeout) };
};

const stepOutcome = (result: StepResult): Outcome => ({ value: result, exit: exitCodeForStep(result) });

export function buildProgram(io: ProgramIo): { program: Command; run(argv: string[]): Promise<number> } {
  let exitCode = 0;

  const program = new Command('ironbird')
    .version(io.version)
    .description('Ground-test React Native apps for AI coding agents')
    .option('--target <id>', 'target id, such as headless, ios, or android-2')
    .option('--json', 'force JSON output')
    .option('--config <file>', 'config file; default is the nearest ironbird.config.ts')
    .option('--daemon <url>', 'daemon address; default from .ironbird/daemon.json or http://127.0.0.1:4567')
    .option('--token <token>', 'daemon token; default IRONBIRD_TOKEN')
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  const signal = (): AbortSignal => {
    if (io.signal) return io.signal;
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    return controller.signal;
  };

  const context = async (command: Command): Promise<Context> => {
    const opts = command.optsWithGlobals<GlobalOptions>();
    const output = createOutput({ json: Boolean(opts.json) || !io.isTTY, write: io.stdout });
    const daemon = await resolveDaemon({ flag: opts.daemon, cwd: io.cwd, env: io.env });
    const client = (io.createClient ?? createDaemonClient)({ url: daemon.url, token: opts.token ?? daemon.token });
    return { output, client, target: opts.target };
  };

  const withTarget = (envelope: { target?: string; result: unknown }): Record<string, unknown> => {
    const result = envelope.result as Record<string, unknown>;
    return envelope.target === undefined || 'target' in result ? result : { target: envelope.target, ...result };
  };

  const wrap =
    (fn: (ctx: Context, ...args: never[]) => Promise<Outcome>) =>
    async (...args: unknown[]): Promise<void> => {
      const command = args[args.length - 1] as Command;
      let output = createOutput({ json: !io.isTTY, write: io.stdout });
      try {
        const ctx = await context(command);
        output = ctx.output;
        const outcome = await fn(ctx, ...(args.slice(0, -1) as never[]));
        if (outcome) output.result(outcome.value);
        exitCode = outcome?.exit ?? 0;
      } catch (error) {
        if (error instanceof UsageError || error instanceof InvalidArgumentError) {
          io.stderr(`error: ${error.message}\n`);
          exitCode = 2;
          return;
        }
        const shape = toErrorShape(error);
        output.error(shape);
        exitCode = exitCodeForError(shape.code);
      }
    };

  program
    .command('serve')
    .description('Run the daemon in the foreground')
    .option('--port <port>', 'HTTP port for the client API', integer)
    .option('--bridge-port <port>', 'WebSocket port for app bridges', integer)
    .option('--host <host>', 'bind address; anything but loopback requires a token')
    .option('--no-headless', 'do not load the headless entry')
    .action(async (opts: { port?: number; bridgePort?: number; host?: string; headless: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const serve = io.serve ?? runServe;
      exitCode = await serve(
        { port: opts.port, bridgePort: opts.bridgePort, host: opts.host, headless: opts.headless, token: globals.token, config: globals.config, json: Boolean(globals.json) || !io.isTTY },
        { cwd: io.cwd, env: io.env, stdout: io.stdout, stderr: io.stderr, version: io.version, signal: signal() },
      );
    });

  program.command('status').description('Daemon version, protocol, uptime, and targets').action(wrap(async (ctx) => ({ value: await ctx.client.rpc('status') })));

  program
    .command('commands')
    .description('List commands with descriptions and payload JSON Schemas')
    .option('--name <command>', 'show one command')
    .action(
      wrap(async (ctx, opts: { name?: string }) => {
        const description = await ctx.client.rpc<Description>('describe', {}, ctx.target);
        if (!opts.name) return { value: description.commands };
        const one = description.commands[opts.name];
        if (!one) throw new IronbirdError('UNKNOWN_COMMAND', `Unknown command ${opts.name}`, { name: opts.name, suggestions: suggestNames(opts.name, Object.keys(description.commands)) });
        return { value: { [opts.name]: one } };
      }),
    );

  program.command('fakes').description('List fakes with their control schemas').action(wrap(async (ctx) => ({ value: (await ctx.client.rpc<Description>('describe', {}, ctx.target)).fakes })));

  program
    .command('send <command> [payload]')
    .description('Validate and dispatch a command, then settle')
    .option('--path <path>', 'return only this subtree of state', '')
    .option('--no-settle', 'return right after dispatch')
    .option('--settle-timeout <duration>', 'how long to wait for effects')
    .action(
      wrap(async (ctx, name: string, payload: string | undefined, opts: { path: string; settle: boolean; settleTimeout?: string }) =>
        stepOutcome(await ctx.client.rpc<StepResult>('dispatch', { name, payload: parsePayload(payload), path: opts.path, settle: settleParam(opts) }, ctx.target)),
      ),
    );

  program.command('state [path]').description('Print state at a path').action(wrap(async (ctx, path: string | undefined) => ({ value: withTarget(await ctx.client.call('getState', { path: path ?? '' }, ctx.target)) })));

  program
    .command('wait <path>')
    .description('Wait until a state condition holds')
    .option('--equals <value>')
    .option('--not-equals <value>')
    .option('--exists')
    .option('--matches <regex>')
    .option('--timeout <duration>', 'give up after this long', '5s')
    .action(
      wrap(async (ctx, path: string, opts: { equals?: string; notEquals?: string; exists?: boolean; matches?: string; timeout: string }) => {
        const conditions: Record<string, unknown> = {};
        if (opts.equals !== undefined) conditions['equals'] = parseJsonOrString(opts.equals);
        if (opts.notEquals !== undefined) conditions['notEquals'] = parseJsonOrString(opts.notEquals);
        if (opts.exists) conditions['exists'] = true;
        if (opts.matches !== undefined) conditions['matches'] = opts.matches;
        if (Object.keys(conditions).length !== 1) throw new UsageError('wait needs exactly one of --equals, --not-equals, --exists, --matches');
        return { value: withTarget(await ctx.client.call('waitFor', { path, ...conditions, timeoutMs: parseDuration(opts.timeout) }, ctx.target)) };
      }),
    );

  program
    .command('settle')
    .description('Print a settle result without dispatching')
    .option('--timeout <duration>')
    .action(
      wrap(async (ctx, opts: { timeout?: string }) => {
        const envelope = await ctx.client.call<SettleResult>('settle', opts.timeout === undefined ? {} : { timeoutMs: parseDuration(opts.timeout) }, ctx.target);
        return { value: withTarget(envelope), exit: exitCodeForStep({ settle: envelope.result }) };
      }),
    );

  program
    .command('events')
    .description('Print recorded events')
    .option('--since <seq>', 'only events newer than this sequence number', integer)
    .option('--limit <n>', 'at most this many events', integer)
    .option('--follow', 'keep streaming events as JSON lines until interrupted')
    .action(
      wrap(async (ctx, opts: { since?: number; limit?: number; follow?: boolean }) => {
        const params: Record<string, unknown> = {};
        if (opts.since !== undefined) params['since'] = opts.since;
        if (opts.limit !== undefined) params['limit'] = opts.limit;
        const envelope = await ctx.client.call<{ events: unknown[]; nextSeq: number; truncated: boolean }>('events', params, ctx.target);
        if (!opts.follow) return { value: withTarget(envelope) };
        for (const event of envelope.result.events) io.stdout(`${JSON.stringify(event)}\n`);
        await ctx.client.stream({
          target: ctx.target,
          since: envelope.result.nextSeq,
          signal: signal(),
          onMessage: (kind, data) => {
            if (kind === 'event') {
              io.stdout(`${JSON.stringify(data)}\n`);
            } else if (kind === 'error') {
              const shape = data as ErrorShape;
              ctx.output.error(shape);
              exitCode = exitCodeForError(shape.code);
            }
          },
        });
        return undefined;
      }),
    );

  const clock = program.command('clock').description('Manual clock control (headless only)');
  clock
    .command('advance <duration>')
    .option('--path <path>', 'return only this subtree of state', '')
    .action(wrap(async (ctx, duration: string, opts: { path: string }) => stepOutcome(await ctx.client.rpc<StepResult>('clockAdvance', { ms: parseDuration(duration), path: opts.path, settle: true }, ctx.target))));
  clock.command('now').action(wrap(async (ctx) => ({ value: withTarget(await ctx.client.call('clockNow', {}, ctx.target)) })));

  program.command('reset').description('Recreate the headless app with a fresh clock, recorder, and fakes').action(wrap(async (ctx) => ({ value: withTarget(await ctx.client.call('reset', {}, ctx.target)) })));

  return {
    program,
    async run(argv) {
      exitCode = 0;
      try {
        await program.parseAsync(argv, { from: 'user' });
      } catch (error) {
        if (error instanceof CommanderError) return error.code === 'commander.helpDisplayed' || error.code === 'commander.version' || error.code === 'commander.help' ? 0 : 2;
        throw error;
      }
      return exitCode;
    },
  };
}
