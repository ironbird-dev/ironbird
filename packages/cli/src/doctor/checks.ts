import { messageOf } from '@ironbird/core';
import path from 'node:path';
import { listAndroidDevices, listBootedSimulators } from '../devices';
import type { DoctorEnvironment, HttpProbe } from './environment';

export type DoctorCheckId = 'node' | 'config' | 'headless' | 'port' | 'gitignore' | 'versions' | 'simctl' | 'adb';

/** One entry of `ironbird doctor`'s output (M5 design D6), with its keys in this order. */
export interface DoctorCheck {
  id: DoctorCheckId;
  ok: boolean;
  required: boolean;
  /** One line saying what was found. */
  detail: string;
  /** What to do about a failure; absent when there is nothing specific to do. */
  fix?: string;
}

export const MIN_NODE_MAJOR = 22;
/** How long the port check waits for whatever holds the daemon port to answer `status` (M5 design §6). */
export const PORT_PROBE_TIMEOUT_MS = 1_000;
export const SKIPPED_DETAIL = 'skipped: the config could not be loaded';
export const SKIPPED_FIX = 'Fix the config check first';

export function passCheck(id: DoctorCheckId, required: boolean, detail: string): DoctorCheck {
  return { id, ok: true, required, detail };
}

export function failCheck(id: DoctorCheckId, required: boolean, detail: string, fix?: string): DoctorCheck {
  return fix === undefined ? { id, ok: false, required, detail } : { id, ok: false, required, detail, fix };
}

/** `22.12.0`, `v22.12.0`, or a prerelease like `v24.0.0-nightly2025`; anything else is unreadable. */
const VERSION_PATTERN = /^v?(\d+)\.\d+\.\d+(?:[-+][^\r\n]*)?$/;

export function checkNode(version: string): DoctorCheck {
  const major = Number.parseInt(VERSION_PATTERN.exec(version)?.[1] ?? '', 10);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return passCheck('node', true, `Node ${version}`);
  return failCheck('node', true, `Node ${version}; ironbird needs Node ${MIN_NODE_MAJOR} or newer`, `Install Node ${MIN_NODE_MAJOR} or newer, for example the current LTS from nodejs.org`);
}

export interface PortConfig {
  host: string;
  port: number;
  bridgePort: number;
}

const LOOPBACK_FOR_WILDCARD: Record<string, string> = { '0.0.0.0': '127.0.0.1', '::': '::1' };

/** Where `doctor` sends `status`: a wildcard bind is reached over loopback, and IPv6 hosts are bracketed. */
export function statusUrl(host: string, port: number): string {
  const target = LOOPBACK_FOR_WILDCARD[host] ?? host;
  return `http://${target.includes(':') ? `[${target}]` : target}:${port}/v1/rpc`;
}

const MAX_REPORTED_VERSION_LENGTH = 40;

/** A version taken from an HTTP answer is untrusted: drop control characters and cap the length so `detail` stays one line. */
function reportable(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
  return clean.length > MAX_REPORTED_VERSION_LENGTH ? `${clean.slice(0, MAX_REPORTED_VERSION_LENGTH)}...` : clean;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Names an ironbird daemon from its answer to `status`, or returns undefined for anything else. A
 * daemon answers 200 `{ ok: true, result: { version, protocol, ... } }`, or 401 with an
 * `UNAUTHORIZED` envelope when it requires a token, which `doctor` never sends (M5 design §6).
 */
export function identifyDaemon(probe: HttpProbe): string | undefined {
  if (probe.kind !== 'response') return undefined;
  let body: unknown;
  try {
    body = JSON.parse(probe.body);
  } catch {
    return undefined;
  }
  if (!isObject(body)) return undefined;
  const { result, error } = body;
  if (probe.status === 200 && body['ok'] === true && isObject(result)) {
    const version = result['version'];
    const protocol = result['protocol'];
    if (typeof version === 'string' && typeof protocol === 'number') return `an ironbird daemon (version ${reportable(version)}, protocol ${protocol})`;
  }
  if (probe.status === 401 && body['ok'] === false && isObject(error) && error['code'] === 'UNAUTHORIZED') return 'an ironbird daemon that requires a token';
  return undefined;
}

type PortFinding = { ok: true; ironbird: boolean; detail: string } | { ok: false; detail: string; fix: string };

/**
 * HTTP first, then a bind: on macOS a bind of 127.0.0.1 succeeds while a daemon holds 0.0.0.0 on
 * the same port, so only asking the port tells whether a daemon is there.
 */
async function inspectDaemonPort(host: string, port: number, env: Pick<DoctorEnvironment, 'probeHttp' | 'tryBind'>): Promise<PortFinding> {
  if (port === 0) return { ok: true, ironbird: false, detail: 'daemon port 0: the OS picks a free port at start' };
  const fix = `Change daemon.port in ironbird.config.ts, or stop the process using port ${port}`;
  const probe = await env.probeHttp(statusUrl(host, port), PORT_PROBE_TIMEOUT_MS);
  const daemon = identifyDaemon(probe);
  if (daemon !== undefined) return { ok: true, ironbird: true, detail: `daemon port ${port} is held by ${daemon}` };
  if (probe.kind === 'response') return { ok: false, detail: `daemon port ${port} on ${host} is in use by something that is not an ironbird daemon (HTTP ${probe.status})`, fix };
  if (probe.kind === 'timeout') return { ok: false, detail: `daemon port ${port} on ${host} is in use by something that did not answer within ${PORT_PROBE_TIMEOUT_MS / 1_000} s`, fix };
  const bind = await env.tryBind(host, port);
  if (bind.ok) return { ok: true, ironbird: false, detail: `daemon port ${port} on ${host} is free` };
  if (bind.code === 'EADDRINUSE') return { ok: false, detail: `daemon port ${port} on ${host} is in use by something that is not an ironbird daemon`, fix };
  return { ok: false, detail: `cannot bind ${host}:${port} (${bind.code}): ${bind.message}`, fix: 'Change daemon.host or daemon.port in ironbird.config.ts' };
}

async function inspectBridgePort(host: string, bridgePort: number, env: Pick<DoctorEnvironment, 'tryBind'>): Promise<PortFinding> {
  if (bridgePort === 0) return { ok: true, ironbird: false, detail: 'bridge port 0: the OS picks a free port at start' };
  const bind = await env.tryBind(host, bridgePort);
  if (bind.ok) return { ok: true, ironbird: false, detail: `bridge port ${bridgePort} is free` };
  const fix = `Change bridge.port in ironbird.config.ts, or stop the process using port ${bridgePort}`;
  if (bind.code === 'EADDRINUSE') return { ok: false, detail: `bridge port ${bridgePort} on ${host} is in use`, fix };
  return { ok: false, detail: `cannot bind ${host}:${bridgePort} (${bind.code}): ${bind.message}`, fix };
}

/**
 * The daemon port must be free or held by an ironbird daemon (M5 design §6). The bridge port must
 * be free too, since `ironbird serve` binds both, unless a daemon already holds the daemon port, in
 * which case it holds its bridge port as well. Equal fixed ports fail as `serve` itself would.
 */
export async function checkPort(ports: PortConfig | undefined, env: Pick<DoctorEnvironment, 'probeHttp' | 'tryBind'>): Promise<DoctorCheck> {
  if (ports === undefined) return failCheck('port', true, SKIPPED_DETAIL, SKIPPED_FIX);
  const { host, port, bridgePort } = ports;
  if (port !== 0 && port === bridgePort) return failCheck('port', true, `daemon.port and bridge.port are both ${port}`, 'Give daemon.port and bridge.port different values in ironbird.config.ts');
  const daemon = await inspectDaemonPort(host, port, env);
  if (!daemon.ok) return failCheck('port', true, daemon.detail, daemon.fix);
  if (daemon.ironbird) return passCheck('port', true, `${daemon.detail}; the bridge port is not checked while it runs`);
  const bridge = await inspectBridgePort(host, bridgePort, env);
  if (!bridge.ok) return failCheck('port', true, `${daemon.detail}, but ${bridge.detail}`, bridge.fix);
  return passCheck('port', true, `${daemon.detail}; ${bridge.detail}`);
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

const MAX_ONE_LINE_LENGTH = 200;

/** External text (host tool output, package.json fields, device names) onto one line: control characters become spaces and the length is capped, so `detail` stays one line. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return clean.length > MAX_ONE_LINE_LENGTH ? `${clean.slice(0, MAX_ONE_LINE_LENGTH)}...` : clean;
}

/** The first line of a host tool's stderr, else the error's message, on one line. */
export function failureText(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const first = typeof stderr === 'string' ? stderr.trim().split('\n')[0] : undefined;
  return oneLine(first ? first : messageOf(error));
}

/**
 * The artifacts directory (`.ironbird/` by default) must be ignored by git (M5 design §6), because it
 * holds state, events, and screenshots (architecture.md §9). Asked with a trailing slash: without
 * it, git reports a `.ironbird/` pattern as not matching while the directory doesn't exist yet, as
 * in a fresh clone.
 */
export async function checkGitignore(paths: { rootDir: string; artifactsPath: string }, env: Pick<DoctorEnvironment, 'exec' | 'hasGitEntry'>): Promise<DoctorCheck> {
  const { rootDir, artifactsPath } = paths;
  const gitFix = `Run git status in ${oneLine(rootDir)} and fix what it reports`;
  try {
    await env.exec('git', ['-C', rootDir, 'rev-parse', '--show-toplevel']);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      // Without git there is no asking it, so look for a repository the way git would.
      if (!(await env.hasGitEntry(rootDir))) return passCheck('gitignore', true, 'not a git repository');
      return failCheck('gitignore', true, "git is not installed, so .ironbird/ ignore status can't be checked", 'Install git, or add .ironbird/ to .gitignore');
    }
    if (failureText(error).includes('not a git repository')) return passCheck('gitignore', true, 'not in a git repository');
    return failCheck('gitignore', true, `git rev-parse failed: ${failureText(error)}`, gitFix);
  }
  const relative = `${path.relative(rootDir, artifactsPath).split(path.sep).join('/') || '.'}/`;
  const shown = oneLine(relative);
  try {
    await env.exec('git', ['-C', rootDir, 'check-ignore', '-q', '--', relative]);
    return passCheck('gitignore', true, `${shown} is ignored by git`);
  } catch (error) {
    if (codeOf(error) === 1) return failCheck('gitignore', true, `${shown} is not ignored by git, so state, events, and screenshots could be committed`, `Add ${shown} to ${oneLine(path.join(rootDir, '.gitignore'))}`);
    if (failureText(error).includes('outside repository')) return passCheck('gitignore', true, `${shown} is outside the git repository`);
    return failCheck('gitignore', true, `git check-ignore failed: ${failureText(error)}`, gitFix);
  }
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/;

function compareKeys(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The highest of `versions` by major, minor, and patch, a prerelease ranking below its release; strings that aren't `x.y.z[-pre]` are ignored. */
export function newestVersion(versions: string[]): string | undefined {
  let best: { version: string; key: number[] } | undefined;
  for (const version of versions) {
    const match = SEMVER_PATTERN.exec(version);
    if (!match) continue;
    const key = [Number(match[1]), Number(match[2]), Number(match[3]), version.includes('-') ? 0 : 1];
    if (best === undefined || compareKeys(key, best.key) > 0) best = { version, key };
  }
  return best?.version;
}

/**
 * Every installed `@ironbird/*` package, the `ironbird` package, and the running CLI must have one
 * version (M5 design §6): a CLI from `npx` or a global install that differs from the app's packages
 * is the skew the M3 eval hit. Changesets releases them as one fixed group, so equal is the norm.
 */
export async function checkVersions(rootDir: string, runningVersion: string, env: Pick<DoctorEnvironment, 'listInstalledPackages'>): Promise<DoctorCheck> {
  const installed = await env.listInstalledPackages(rootDir);
  if (installed.length === 0) {
    return failCheck('versions', true, `No ironbird packages are installed in ${oneLine(rootDir)} or above it`, `Install @ironbird/core and @ironbird/react-native, and @ironbird/cli as a dev dependency, all at ${runningVersion}`);
  }
  const entries: Array<{ name: string; version: string | undefined }> = [...installed.map(({ name, version }) => ({ name, version })), { name: 'this CLI', version: runningVersion }];
  const detail = entries.map(({ name, version }) => `${oneLine(name)} ${version === undefined ? '(no readable version)' : oneLine(version)}`).join(', ');
  const versions = new Set(entries.map(({ version }) => version));
  if (versions.size === 1 && !versions.has(undefined)) return passCheck('versions', true, detail);
  const target = newestVersion(entries.flatMap(({ version }) => (version === undefined ? [] : [version]))) ?? runningVersion;
  return failCheck(
    'versions',
    true,
    detail,
    `Install one version of every ironbird package, for example ${installed.map(({ name }) => `${name}@${target}`).join(' ')}, and run the CLI installed in the project (npx ironbird) so it matches`,
  );
}

/** Informational (M5 design §6): iOS work needs macOS and `xcrun simctl`; the detail lists booted simulators. */
export async function checkSimctl(env: Pick<DoctorEnvironment, 'platform' | 'exec'>): Promise<DoctorCheck> {
  if (env.platform !== 'darwin') return failCheck('simctl', false, `iOS simulators need macOS; this machine runs ${env.platform}`);
  try {
    const booted = await listBootedSimulators(env.exec);
    if (booted.length === 0) return passCheck('simctl', false, 'xcrun simctl is available; no simulator is booted');
    return passCheck('simctl', false, `xcrun simctl is available; booted: ${booted.map((device) => `${oneLine(device.name ?? 'unnamed')} (${oneLine(device.id)})`).join(', ')}`);
  } catch (error) {
    return failCheck('simctl', false, `xcrun simctl is unavailable: ${failureText(error)}`, 'Install Xcode, open it once to finish installing its components, and select it with sudo xcode-select -s /Applications/Xcode.app');
  }
}

/** Informational (M5 design §6): Android work needs `adb`; the detail lists connected devices. */
export async function checkAdb(env: Pick<DoctorEnvironment, 'exec'>): Promise<DoctorCheck> {
  try {
    const devices = await listAndroidDevices(env.exec);
    if (devices.length === 0) return passCheck('adb', false, 'adb is available; no device is connected');
    return passCheck('adb', false, `adb is available; devices: ${devices.map((device) => (device.name ? `${oneLine(device.name)} (${oneLine(device.id)})` : oneLine(device.id))).join(', ')}`);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return failCheck('adb', false, 'adb is not on the PATH', 'Install the Android SDK Platform-Tools and add them to your PATH');
    return failCheck('adb', false, `adb failed: ${failureText(error)}`, 'Run adb devices and fix what it reports');
  }
}
