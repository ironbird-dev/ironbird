import { messageOf } from '@ironbird/core';
import path from 'node:path';
import { checkAdb, checkGitignore, checkNode, checkPort, checkSimctl, checkVersions, failCheck, oneLine, type DoctorCheck, type DoctorCheckId } from './checks';
import { systemEnvironment, type DoctorEnvironment } from './environment';
import { checkProject, type ProjectChecks } from './project';

/** What `ironbird doctor` prints (M5 design D6). */
export interface DoctorReport {
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  cwd: string;
  /** `--config`; default is the nearest config file walking up from `cwd`. */
  configPath?: string | undefined;
  /** The running CLI's version, compared with the installed packages. */
  version: string;
  /** Test hook: replaces parts of the probed environment. */
  environment?: Partial<DoctorEnvironment> | undefined;
}

const unexpected = (error: unknown): string => `check failed unexpectedly: ${oneLine(messageOf(error))}`;

/** One check's fault becomes that check's failure, so the rest of the report still prints. */
async function guard(id: DoctorCheckId, required: boolean, run: () => DoctorCheck | Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await run();
  } catch (error) {
    return failCheck(id, required, unexpected(error));
  }
}

/** Runs the checks of M5 design §6, one at a time and in its order, without a daemon. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const env: DoctorEnvironment = { ...systemEnvironment(), ...options.environment };
  const cwd = path.resolve(options.cwd);
  const node = await guard('node', true, () => checkNode(env.nodeVersion));
  let project: ProjectChecks;
  try {
    project = await checkProject({ cwd, configPath: options.configPath });
  } catch (error) {
    project = { config: failCheck('config', true, unexpected(error)), headless: failCheck('headless', true, unexpected(error)), outcome: { status: 'invalid', rootDir: cwd } };
  }
  const { outcome } = project;
  const config = outcome.status === 'invalid' ? undefined : outcome.config;
  const { rootDir } = outcome;
  const ports = config === undefined ? undefined : { host: config.daemon.host, port: config.daemon.port, bridgePort: config.bridge.port };
  const artifactsPath = config?.artifactsPath ?? path.join(rootDir, '.ironbird');
  return {
    checks: [
      node,
      project.config,
      project.headless,
      await guard('port', true, () => checkPort(ports, env)),
      await guard('gitignore', true, () => checkGitignore({ rootDir, artifactsPath }, env)),
      await guard('versions', true, () => checkVersions(rootDir, options.version, env)),
      await guard('simctl', false, () => checkSimctl(env)),
      await guard('adb', false, () => checkAdb(env)),
    ],
  };
}

/** 0 when every required check passes, 1 otherwise; optional checks never change it (M5 design D6). */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.checks.every((check) => check.ok || !check.required) ? 0 : 1;
}
