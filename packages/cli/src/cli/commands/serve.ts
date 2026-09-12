import { IronbirdError, isHeadlessDefinition, toErrorShape } from '@ironbird/core';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadTypeScriptModule } from '../../bundle';
import { loadConfig } from '../../config';
import { isLoopbackHost, startDaemon, type Daemon } from '../../daemon';
import { removeDaemonInfo, writeDaemonInfo } from '../../daemon-info';
import { createHeadlessTarget, type HeadlessTarget } from '../../headless-target';
import { exitCodeForError } from '../exit-codes';
import { createOutput } from '../output';

export interface ServeOptions {
  port?: number;
  bridgePort?: number;
  host?: string;
  headless: boolean;
  token?: string;
  config?: string;
  json: boolean;
}

export interface ServeIo {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  version: string;
  signal: AbortSignal;
}

export function isLoopback(host: string): boolean {
  return isLoopbackHost(host);
}

export async function runServe(options: ServeOptions, io: ServeIo): Promise<number> {
  const output = createOutput({ json: options.json, write: io.stdout });
  const log = (line: string): void => io.stderr(`${line}\n`);
  let target: HeadlessTarget | undefined;
  let daemon: Daemon | undefined;
  let artifactsPath: string | undefined;

  try {
    const config = await loadConfig({ cwd: io.cwd, configPath: options.config });
    artifactsPath = config.artifactsPath;
    const host = options.host ?? config.daemon.host;
    const port = options.port ?? config.daemon.port;
    let token = options.token ?? io.env['IRONBIRD_TOKEN'];
    if (!isLoopback(host) && !token) {
      token = randomBytes(16).toString('hex');
      log(`Binding ${host} requires a token. Generated one for this session:\nIRONBIRD_TOKEN=${token}`);
    }

    if (options.headless && config.headlessPath) {
      const loaded = await loadTypeScriptModule(config.headlessPath, { outDir: path.join(config.artifactsPath, 'cache'), label: 'headless', forbidden: ['react-native'] });
      const definition = loaded.exports['default'];
      if (!isHeadlessDefinition(definition)) {
        throw new IronbirdError('HEADLESS_LOAD_FAILED', `${path.relative(io.cwd, config.headlessPath)} must default-export defineHeadless(...)`, { entry: config.headlessPath, message: 'default export is not a headless definition' });
      }
      target = await createHeadlessTarget({ definition, appId: config.appId, clockStart: config.clock.start, settleTimeoutMs: config.settle.timeoutMs, env: io.env, log });
    } else if (options.headless && !config.headlessPath) {
      log('No headless entry in config; running remote-only');
    }

    daemon = await startDaemon({ host, port, token, version: io.version, headless: target, defaultTarget: target ? config.defaultTarget : undefined, log });
    await writeDaemonInfo(config.artifactsPath, { url: daemon.url, pid: process.pid, startedAt: Date.now(), version: io.version, defaultTarget: target ? config.defaultTarget : undefined });
    output.result({ url: daemon.url, targets: daemon.targets(), defaultTarget: target ? config.defaultTarget : undefined, bridgePort: options.bridgePort ?? config.bridge.port });
  } catch (error) {
    const shape = toErrorShape(error);
    const code = (error as { code?: string }).code;
    if (code === 'EADDRINUSE') {
      output.error({ code: 'INTERNAL', message: `Port ${options.port ?? 'from config'} is already in use; stop the other daemon or pass --port`, details: { message: shape.message } });
      await cleanup();
      return 2;
    }
    output.error(shape);
    await cleanup();
    return exitCodeForError(shape.code);
  }

  await new Promise<void>((resolve) => {
    if (io.signal.aborted) return resolve();
    io.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await cleanup();
  return 0;

  async function cleanup(): Promise<void> {
    await daemon?.close().catch(() => undefined);
    await target?.dispose().catch(() => undefined);
    if (artifactsPath) await removeDaemonInfo(artifactsPath).catch(() => undefined);
  }
}
