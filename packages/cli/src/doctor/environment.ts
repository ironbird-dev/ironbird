import { messageOf } from '@ironbird/core';
import { access, readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { systemExec, type Exec } from '../devices';

/** What answered a `status` request on a port, if anything did. */
export type HttpProbe = { kind: 'response'; status: number; body: string } | { kind: 'timeout' } | { kind: 'unreachable'; code: string };

export type BindProbe = { ok: true } | { ok: false; code: string; message: string };

export interface InstalledPackage {
  name: string;
  /** Undefined when the package's `package.json` is missing, unreadable, or has no string `version`. */
  version: string | undefined;
  dir: string;
}

/**
 * Everything `ironbird doctor` learns from the machine, injected so each check is unit tested with
 * fakes (M5 design §11). The config and headless checks read the project's own files instead.
 */
export interface DoctorEnvironment {
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** Runs `git`, `xcrun`, and `adb`. */
  exec: Exec;
  probeHttp(url: string, timeoutMs: number): Promise<HttpProbe>;
  tryBind(host: string, port: number): Promise<BindProbe>;
  listInstalledPackages(fromDir: string): Promise<InstalledPackage[]>;
  /** Whether `fromDir` or any directory above it holds a `.git` entry, a directory or a file (worktrees and submodules use a file). */
  hasGitEntry(fromDir: string): Promise<boolean>;
}

/**
 * Sends the protocol's `status` operation (`POST /v1/rpc`, docs/protocol.md §3) with no token and
 * reports whatever answered. The timeout covers the body too, so a server that sends headers and
 * then stalls is a timeout rather than a hang. Never throws.
 */
export async function probeHttp(url: string, timeoutMs: number): Promise<HttpProbe> {
  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.timeout(timeoutMs); // throws a RangeError for a negative or non-finite duration
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'status' }),
      redirect: 'manual',
      signal,
    });
    return { kind: 'response', status: response.status, body: await response.text() };
  } catch (error) {
    // A stalled body rejects with AbortError rather than TimeoutError, so the signal is the authority.
    if (signal?.aborted === true || (error as { name?: unknown }).name === 'TimeoutError') return { kind: 'timeout' };
    const code = (error as { cause?: { code?: unknown } }).cause?.code ?? (error as { code?: unknown }).code;
    return { kind: 'unreachable', code: typeof code === 'string' ? code : messageOf(error) };
  }
}

/** Binds `host:port` the way `ironbird serve` does and releases it at once. Never throws. */
export function tryBind(host: string, port: number): Promise<BindProbe> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const fail = (error: NodeJS.ErrnoException): void => resolve({ ok: false, code: error.code ?? 'UNKNOWN', message: error.message });
    server.once('error', fail);
    try {
      server.listen(port, host, () => server.close(() => resolve({ ok: true })));
    } catch (error) {
      // listen validates the port synchronously (ERR_SOCKET_BAD_PORT) instead of emitting 'error'.
      fail(error as NodeJS.ErrnoException);
    }
  });
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

async function readVersion(dir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    const version = parsed !== null && typeof parsed === 'object' ? (parsed as { version?: unknown }).version : undefined;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every `@ironbird/*` package and the unscoped `ironbird` package visible from `fromDir`, found the
 * way Node resolves them: `node_modules` in `fromDir` and each directory above it, the nearest copy
 * of a name winning. pnpm's entries are symlinks, so nothing here filters on `isDirectory()`.
 */
export async function listInstalledPackages(fromDir: string): Promise<InstalledPackage[]> {
  const found = new Map<string, InstalledPackage>();
  let dir = path.resolve(fromDir);
  for (;;) {
    const modules = path.join(dir, 'node_modules');
    const scoped = await readdir(path.join(modules, '@ironbird')).catch(() => [] as string[]);
    const names = [...scoped.filter((name) => !name.startsWith('.')).map((name) => `@ironbird/${name}`), 'ironbird'];
    for (const name of names) {
      const packageDir = path.join(modules, ...name.split('/'));
      if (found.has(name) || !(await exists(packageDir))) continue;
      found.set(name, { name, version: await readVersion(packageDir), dir: packageDir });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Looks for `.git` the way git does, without running git: for when git is not installed. */
export async function hasGitEntry(fromDir: string): Promise<boolean> {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (await exists(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function systemEnvironment(): DoctorEnvironment {
  return { nodeVersion: process.versions.node, platform: process.platform, exec: systemExec, probeHttp, tryBind, listInstalledPackages, hasGitEntry };
}
