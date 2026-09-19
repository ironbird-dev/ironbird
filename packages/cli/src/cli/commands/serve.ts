import { IronbirdError, isHeadlessDefinition, toErrorShape } from '@ironbird/core';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadTypeScriptModule } from '../../bundle';
import { loadConfig } from '../../config';
import { isLoopbackHost, startDaemon, type Daemon } from '../../daemon';
import { removeDaemonInfo, writeDaemonInfo } from '../../daemon-info';
import { adbReverse, type Exec } from '../../devices';
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
  /** Test hook: replaces the host tool runner used for `adb reverse`. */
  exec?: Exec;
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
  let port: number | undefined;
  let bridgePort: number | undefined;
  let configPath: string | undefined;
  // Only this invocation's own discovery file may be removed on the way out. A second `serve`
  // that fails to bind must leave the running daemon's `daemon.json` alone.
  let wroteInfo = false;

  try {
    const config = await loadConfig({ cwd: io.cwd, configPath: options.config });
    artifactsPath = config.artifactsPath;
    configPath = config.configPath;
    const host = options.host ?? config.daemon.host;
    port = options.port ?? config.daemon.port;
    bridgePort = options.bridgePort ?? config.bridge.port;
    // Each is a real fixed port only when non-zero (0 asks the OS for an ephemeral one, so two
    // zeros never collide). Both servers binding the same fixed port can never work, no matter
    // which one the OS happens to fail first, so this is caught as a configuration error before
    // either socket opens rather than surfacing as a confusing EADDRINUSE on just one of them.
    if (port !== 0 && bridgePort !== 0 && port === bridgePort) {
      const message = `--port and --bridge-port must differ (both are ${port})`;
      throw new IronbirdError('INVALID_CONFIG', message, { file: configPath, issues: [{ path: ['bridge', 'port'], message }] });
    }
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
      target = await createHeadlessTarget({ definition, appId: config.appId, clockStart: config.clock.start, settleTimeoutMs: config.settle.timeoutMs, env: io.env, log, entryPath: config.headlessPath, bootTimeoutMs: config.boot.timeoutMs });
    } else if (options.headless && !config.headlessPath) {
      log('No headless entry in config; running remote-only');
    }

    const defaultTarget = target ? config.defaultTarget : undefined;
    daemon = await startDaemon({ host, port, token, version: io.version, headless: target, defaultTarget, log, bridge: { port: bridgePort }, artifactsPath: config.artifactsPath, devices: config.devices });
    const boundBridgePort = daemon.bridgeUrl === undefined ? bridgePort : Number(new URL(daemon.bridgeUrl).port);
    // Emulators reach the host's bridge port at their own localhost only after adb reverse; a
    // machine without adb, or without a device, just logs and moves on.
    await adbReverse(boundBridgePort, { exec: io.exec, log });
    await writeDaemonInfo(config.artifactsPath, { url: daemon.url, pid: process.pid, startedAt: Date.now(), version: io.version, defaultTarget, ...(daemon.bridgeUrl === undefined ? {} : { bridgeUrl: daemon.bridgeUrl }) });
    wroteInfo = true;
    output.result({ url: daemon.url, bridgeUrl: daemon.bridgeUrl, targets: daemon.targets(), defaultTarget, bridgePort: boundBridgePort });
  } catch (error) {
    const shape = toErrorShape(error);
    const failed = error as { code?: string; port?: number };
    if (failed.code === 'EADDRINUSE') {
      const which = failed.port !== undefined && failed.port === bridgePort ? 'bridge' : 'daemon';
      const usedPort = failed.port ?? (which === 'bridge' ? bridgePort : port) ?? 'unknown';
      const message = `Port ${usedPort} is already in use; stop the other daemon or pass ${which === 'bridge' ? '--bridge-port' : '--port'}`;
      output.error({
        code: 'INVALID_CONFIG',
        message,
        details: { file: configPath, issues: [{ path: [which, 'port'], message }] },
      });
      await cleanup();
      return exitCodeForError('INVALID_CONFIG');
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
    if (wroteInfo && artifactsPath) await removeDaemonInfo(artifactsPath).catch(() => undefined);
  }
}
