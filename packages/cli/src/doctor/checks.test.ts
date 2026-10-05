import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon } from '../daemon';
import { systemExec, type Exec } from '../devices';
import {
  PORT_PROBE_TIMEOUT_MS,
  SKIPPED_DETAIL,
  SKIPPED_FIX,
  checkAdb,
  checkGitignore,
  checkNode,
  checkPort,
  checkSimctl,
  checkVersions,
  failureText,
  identifyDaemon,
  newestVersion,
  statusUrl,
} from './checks';
import { hasGitEntry, systemEnvironment, type HttpProbe, type InstalledPackage } from './environment';
import { FAKE_UDID, execFailure, fakeEnvironment } from './fake-environment';

const STATUS_BODY = JSON.stringify({ ok: true, result: { version: '0.1.0', protocol: 1, uptimeMs: 5, targets: [] } });
const UNAUTHORIZED_BODY = JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Token missing or wrong' } });
const DEFAULT_PORTS = { host: '127.0.0.1', port: 4567, bridgePort: 4568 };
const answering = (probe: HttpProbe) => async (): Promise<HttpProbe> => probe;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('checkNode', () => {
  it('passes Node 22 and newer', () => {
    expect(checkNode('22.0.0')).toEqual({ id: 'node', ok: true, required: true, detail: 'Node 22.0.0' });
    expect(checkNode('26.10.0').ok).toBe(true);
    expect(checkNode('v22.12.0').ok).toBe(true);
  });

  it('fails an older or unreadable version, with a fix naming the required version', () => {
    expect(checkNode('20.11.1')).toEqual({
      id: 'node',
      ok: false,
      required: true,
      detail: 'Node 20.11.1; ironbird needs Node 22 or newer',
      fix: 'Install Node 22 or newer, for example the current LTS from nodejs.org',
    });
    expect(checkNode('banana').ok).toBe(false);
  });

  it('fails a version string that only starts with a number', () => {
    for (const version of ['22garbage', '22', '22.0', 'v22.x.y', '22.0.0 extra', '22.0.0\nx', '', 'vv22.0.0']) expect(checkNode(version).ok, version).toBe(false);
    expect(checkNode('v24.0.0-nightly20251001').ok).toBe(true);
  });
});

describe('identifyDaemon', () => {
  it('recognizes a status answer and a token refusal, and nothing else', () => {
    expect(identifyDaemon({ kind: 'response', status: 200, body: STATUS_BODY })).toBe('an ironbird daemon (version 0.1.0, protocol 1)');
    expect(identifyDaemon({ kind: 'response', status: 401, body: UNAUTHORIZED_BODY })).toBe('an ironbird daemon that requires a token');
    const others: HttpProbe[] = [
      { kind: 'response', status: 200, body: '<html>hi</html>' },
      { kind: 'response', status: 200, body: JSON.stringify({ ok: true, result: { version: 1, protocol: 1 } }) },
      { kind: 'response', status: 200, body: UNAUTHORIZED_BODY },
      { kind: 'response', status: 401, body: JSON.stringify({ error: 'nope' }) },
      { kind: 'response', status: 404, body: UNAUTHORIZED_BODY },
      { kind: 'timeout' },
      { kind: 'unreachable', code: 'ECONNREFUSED' },
    ];
    for (const probe of others) expect(identifyDaemon(probe)).toBeUndefined();
  });
});

describe('identifyDaemon detail', () => {
  it('keeps the reported version on one line and bounded', () => {
    const body = (version: string): string => JSON.stringify({ ok: true, result: { version, protocol: 1 } });
    expect(identifyDaemon({ kind: 'response', status: 200, body: body('1.0.0\nFAKE: all good\r\u0007') })).toBe('an ironbird daemon (version 1.0.0FAKE: all good, protocol 1)');
    const long = identifyDaemon({ kind: 'response', status: 200, body: body('9'.repeat(500)) }) ?? '';
    expect(long).toBe(`an ironbird daemon (version ${'9'.repeat(40)}..., protocol 1)`);
  });
});

describe('statusUrl', () => {
  it('reaches a wildcard bind over loopback and brackets IPv6 hosts', () => {
    expect(statusUrl('127.0.0.1', 4567)).toBe('http://127.0.0.1:4567/v1/rpc');
    expect(statusUrl('0.0.0.0', 4567)).toBe('http://127.0.0.1:4567/v1/rpc');
    expect(statusUrl('::', 4567)).toBe('http://[::1]:4567/v1/rpc');
    expect(statusUrl('::1', 4567)).toBe('http://[::1]:4567/v1/rpc');
    expect(statusUrl('192.168.1.20', 4567)).toBe('http://192.168.1.20:4567/v1/rpc');
  });
});

describe('checkPort', () => {
  it('passes free daemon and bridge ports, probing the daemon port first with a 1 s timeout', async () => {
    const env = fakeEnvironment();
    expect(await checkPort(DEFAULT_PORTS, env)).toEqual({ id: 'port', ok: true, required: true, detail: 'daemon port 4567 on 127.0.0.1 is free; bridge port 4568 is free' });
    expect(PORT_PROBE_TIMEOUT_MS).toBe(1_000);
    expect(env.log.http).toEqual([{ url: 'http://127.0.0.1:4567/v1/rpc', timeoutMs: 1_000 }]);
    expect(env.log.bind).toEqual([
      { host: '127.0.0.1', port: 4567 },
      { host: '127.0.0.1', port: 4568 },
    ]);
  });

  it('passes a port held by an ironbird daemon, with or without a token, without binding anything', async () => {
    const cases = [
      { status: 200, body: STATUS_BODY, said: 'an ironbird daemon (version 0.1.0, protocol 1)' },
      { status: 401, body: UNAUTHORIZED_BODY, said: 'an ironbird daemon that requires a token' },
    ];
    for (const { status, body, said } of cases) {
      const env = fakeEnvironment({ probeHttp: answering({ kind: 'response', status, body }) });
      expect(await checkPort(DEFAULT_PORTS, env)).toEqual({ id: 'port', ok: true, required: true, detail: `daemon port 4567 is held by ${said}; the bridge port is not checked while it runs` });
      expect(env.log.bind).toEqual([]);
    }
  });

  it('fails a port held by anything else, with a fix to change the port or stop the process', async () => {
    const fix = 'Change daemon.port in ironbird.config.ts, or stop the process using port 4567';
    expect(await checkPort(DEFAULT_PORTS, fakeEnvironment({ probeHttp: answering({ kind: 'response', status: 200, body: '<html>hi</html>' }) }))).toEqual({
      id: 'port',
      ok: false,
      required: true,
      detail: 'daemon port 4567 on 127.0.0.1 is in use by something that is not an ironbird daemon (HTTP 200)',
      fix,
    });
    expect(await checkPort(DEFAULT_PORTS, fakeEnvironment({ probeHttp: answering({ kind: 'timeout' }) }))).toEqual({
      id: 'port',
      ok: false,
      required: true,
      detail: 'daemon port 4567 on 127.0.0.1 is in use by something that did not answer within 1 s',
      fix,
    });
    expect(await checkPort(DEFAULT_PORTS, fakeEnvironment({ tryBind: async () => ({ ok: false, code: 'EADDRINUSE', message: 'listen EADDRINUSE' }) }))).toEqual({
      id: 'port',
      ok: false,
      required: true,
      detail: 'daemon port 4567 on 127.0.0.1 is in use by something that is not an ironbird daemon',
      fix,
    });
  });

  it('fails a host it cannot bind, with a fix naming daemon.host', async () => {
    const message = 'listen EADDRNOTAVAIL: address not available 203.0.113.1:4567';
    const env = fakeEnvironment({ tryBind: async () => ({ ok: false, code: 'EADDRNOTAVAIL', message }) });
    expect(await checkPort({ ...DEFAULT_PORTS, host: '203.0.113.1' }, env)).toEqual({
      id: 'port',
      ok: false,
      required: true,
      detail: `cannot bind 203.0.113.1:4567 (EADDRNOTAVAIL): ${message}`,
      fix: 'Change daemon.host or daemon.port in ironbird.config.ts',
    });
  });

  it('fails a bridge port in use when the daemon port is free', async () => {
    const env = fakeEnvironment({ tryBind: async (_host, port) => (port === 4568 ? { ok: false, code: 'EADDRINUSE', message: 'in use' } : { ok: true }) });
    expect(await checkPort(DEFAULT_PORTS, env)).toEqual({
      id: 'port',
      ok: false,
      required: true,
      detail: 'daemon port 4567 on 127.0.0.1 is free, but bridge port 4568 on 127.0.0.1 is in use',
      fix: 'Change bridge.port in ironbird.config.ts, or stop the process using port 4568',
    });
  });

  it('probes a wildcard bind over loopback but binds the configured host', async () => {
    const env = fakeEnvironment();
    await checkPort({ host: '0.0.0.0', port: 5000, bridgePort: 5001 }, env);
    expect(env.log.http).toEqual([{ url: 'http://127.0.0.1:5000/v1/rpc', timeoutMs: 1_000 }]);
    expect(env.log.bind).toEqual([
      { host: '0.0.0.0', port: 5000 },
      { host: '0.0.0.0', port: 5001 },
    ]);
  });

  it('accepts port 0, rejects equal fixed ports as serve does, and skips when the config could not be loaded', async () => {
    const env = fakeEnvironment();
    expect(await checkPort({ host: '127.0.0.1', port: 0, bridgePort: 0 }, env)).toEqual({
      id: 'port',
      ok: true,
      required: true,
      detail: 'daemon port 0: the OS picks a free port at start; bridge port 0: the OS picks a free port at start',
    });
    expect(await checkPort({ host: '127.0.0.1', port: 4567, bridgePort: 4567 }, env)).toEqual({
      id: 'port',
      ok: false,
      required: true,
      detail: 'daemon.port and bridge.port are both 4567',
      fix: 'Give daemon.port and bridge.port different values in ironbird.config.ts',
    });
    expect(await checkPort(undefined, env)).toEqual({ id: 'port', ok: false, required: true, detail: SKIPPED_DETAIL, fix: SKIPPED_FIX });
    expect(env.log.http).toEqual([]);
    expect(env.log.bind).toEqual([]);
  });
});

describe('checkPort against real sockets', () => {
  it('passes a port held by a real daemon, with and without a token', async () => {
    for (const token of [undefined, 'secret']) {
      const daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '9.9.9-test', log: () => {}, ...(token === undefined ? {} : { token }) });
      cleanups.push(() => daemon.close());
      const check = await checkPort({ host: '127.0.0.1', port: daemon.port, bridgePort: 0 }, systemEnvironment());
      expect(check.ok).toBe(true);
      expect(check.detail).toContain(token === undefined ? 'version 9.9.9-test' : 'requires a token');
    }
  });

  it('fails a port held by a plain HTTP server, and passes the same port once it is free', async () => {
    const server = createHttpServer((_req, res) => res.end('not ironbird'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const held = await checkPort({ host: '127.0.0.1', port, bridgePort: 0 }, systemEnvironment());
    expect(held).toMatchObject({ ok: false, detail: `daemon port ${port} on 127.0.0.1 is in use by something that is not an ironbird daemon (HTTP 200)` });
    await new Promise((resolve) => server.close(resolve));
    expect(await checkPort({ host: '127.0.0.1', port, bridgePort: 0 }, systemEnvironment())).toMatchObject({ ok: true, detail: `daemon port ${port} on 127.0.0.1 is free; bridge port 0: the OS picks a free port at start` });
  });
});

describe('checkGitignore', () => {
  const root = '/work/app';
  const paths = { rootDir: root, artifactsPath: path.join(root, '.ironbird') };
  const git =
    (handlers: { revParse?: () => void; checkIgnore?: () => void }): Exec =>
    async (_file, args) => {
      if (args.includes('rev-parse')) handlers.revParse?.();
      if (args.includes('check-ignore')) handlers.checkIgnore?.();
      return { stdout: Buffer.from(''), stderr: '' };
    };
  const noGitEntry = async (): Promise<boolean> => false;
  const failsWith = (code: number | string, stderr = '') => (): never => {
    throw execFailure(code, stderr);
  };

  it('passes when git ignores the artifacts directory, asking with a trailing slash', async () => {
    const env = fakeEnvironment();
    expect(await checkGitignore(paths, env)).toEqual({ id: 'gitignore', ok: true, required: true, detail: '.ironbird/ is ignored by git' });
    expect(env.log.exec).toEqual([
      ['git', '-C', root, 'rev-parse', '--show-toplevel'],
      ['git', '-C', root, 'check-ignore', '-q', '--', '.ironbird/'],
    ]);
  });

  it('fails with a fix naming the .gitignore to edit when git does not ignore it', async () => {
    expect(await checkGitignore(paths, { exec: git({ checkIgnore: failsWith(1) }), hasGitEntry: noGitEntry })).toEqual({
      id: 'gitignore',
      ok: false,
      required: true,
      detail: '.ironbird/ is not ignored by git, so state, events, and screenshots could be committed',
      fix: `Add .ironbird/ to ${path.join(root, '.gitignore')}`,
    });
  });

  it('checks a configured artifacts directory', async () => {
    const env = fakeEnvironment();
    expect((await checkGitignore({ rootDir: root, artifactsPath: path.join(root, 'out', 'artifacts') }, env)).detail).toBe('out/artifacts/ is ignored by git');
    expect(env.log.exec[1]).toEqual(['git', '-C', root, 'check-ignore', '-q', '--', 'out/artifacts/']);
  });

  it('passes outside a git repository, without git, and for an artifacts directory outside the repository', async () => {
    expect(await checkGitignore(paths, { exec: git({ revParse: failsWith(128, 'fatal: not a git repository (or any of the parent directories): .git\n') }), hasGitEntry: noGitEntry })).toEqual({
      id: 'gitignore',
      ok: true,
      required: true,
      detail: 'not in a git repository',
    });
    expect(await checkGitignore(paths, { exec: git({ revParse: failsWith('ENOENT') }), hasGitEntry: noGitEntry })).toEqual({ id: 'gitignore', ok: true, required: true, detail: 'not a git repository' });
    const outside = await checkGitignore(
      { rootDir: root, artifactsPath: '/elsewhere/artifacts' },
      { exec: git({ checkIgnore: failsWith(128, "fatal: ../../elsewhere/artifacts/: '../../elsewhere/artifacts/' is outside repository at '/work'\n") }), hasGitEntry: noGitEntry },
    );
    expect(outside).toEqual({ id: 'gitignore', ok: true, required: true, detail: '../../elsewhere/artifacts/ is outside the git repository' });
  });

  it('fails without git when a .git entry exists in the project or above it, because the ignore status cannot be checked', async () => {
    const asked: string[] = [];
    const check = await checkGitignore(paths, {
      exec: git({ revParse: failsWith('ENOENT') }),
      hasGitEntry: async (fromDir) => {
        asked.push(fromDir);
        return true;
      },
    });
    expect(check).toEqual({
      id: 'gitignore',
      ok: false,
      required: true,
      detail: "git is not installed, so .ironbird/ ignore status can't be checked",
      fix: 'Install git, or add .ironbird/ to .gitignore',
    });
    expect(asked).toEqual([root]);
  });

  it('fails when git fails for another reason, quoting it', async () => {
    expect(await checkGitignore(paths, { exec: git({ revParse: failsWith(128, 'fatal: detected dubious ownership in repository at /work/app\n') }), hasGitEntry: noGitEntry })).toEqual({
      id: 'gitignore',
      ok: false,
      required: true,
      detail: 'git rev-parse failed: fatal: detected dubious ownership in repository at /work/app',
      fix: 'Run git status in /work/app and fix what it reports',
    });
  });
});

describe('checkGitignore with real git', () => {
  const repo = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ironbird-doctor-git-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  };

  it('passes a fresh clone whose .gitignore lists .ironbird/ before the directory exists', async () => {
    const dir = await repo();
    await systemExec('git', ['-C', dir, 'init', '-q']);
    await writeFile(path.join(dir, '.gitignore'), '.ironbird/\n');
    expect(await checkGitignore({ rootDir: dir, artifactsPath: path.join(dir, '.ironbird') }, { exec: systemExec, hasGitEntry })).toEqual({
      id: 'gitignore',
      ok: true,
      required: true,
      detail: '.ironbird/ is ignored by git',
    });
  });

  it('fails a repository that does not ignore it, and passes a directory that is not a repository', async () => {
    const dir = await repo();
    await systemExec('git', ['-C', dir, 'init', '-q']);
    expect(await checkGitignore({ rootDir: dir, artifactsPath: path.join(dir, '.ironbird') }, { exec: systemExec, hasGitEntry })).toMatchObject({ ok: false, fix: `Add .ironbird/ to ${path.join(dir, '.gitignore')}` });
    const plain = await repo();
    expect(await checkGitignore({ rootDir: plain, artifactsPath: path.join(plain, '.ironbird') }, { exec: systemExec, hasGitEntry })).toMatchObject({ ok: true, detail: 'not in a git repository' });
  });
});

describe('hasGitEntry', () => {
  it('finds a .git directory or file in the directory or an ancestor', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ironbird-doctor-gitentry-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const nested = path.join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(dir, '.git'), 'gitdir: /elsewhere\n');
    expect(await hasGitEntry(nested)).toBe(true);
    await rm(path.join(dir, '.git'));
    await mkdir(path.join(dir, 'a', '.git'));
    expect(await hasGitEntry(nested)).toBe(true);
    expect(await hasGitEntry(path.join(dir, 'a', '.git'))).toBe(true);
  });
});

describe('newestVersion', () => {
  it('orders by major, minor, and patch, puts a prerelease below its release, and ignores anything else', () => {
    expect(newestVersion(['0.1.0', '0.10.0', '0.9.9'])).toBe('0.10.0');
    expect(newestVersion(['0.2.0-beta.1', '0.1.9'])).toBe('0.2.0-beta.1');
    expect(newestVersion(['0.2.0-beta.1', '0.2.0'])).toBe('0.2.0');
    expect(newestVersion(['workspace:*', 'latest'])).toBeUndefined();
  });
});

describe('checkVersions', () => {
  const pkg = (name: string, version: string | undefined): InstalledPackage => ({ name, version, dir: `/work/app/node_modules/${name}` });
  const installed = (...packages: InstalledPackage[]) => ({ listInstalledPackages: async () => packages });

  it('passes when every installed package and this CLI share one version, listing each', async () => {
    expect(await checkVersions('/work/app', '0.1.0', installed(pkg('@ironbird/cli', '0.1.0'), pkg('@ironbird/core', '0.1.0'), pkg('ironbird', '0.1.0')))).toEqual({
      id: 'versions',
      ok: true,
      required: true,
      detail: '@ironbird/cli 0.1.0, @ironbird/core 0.1.0, ironbird 0.1.0, this CLI 0.1.0',
    });
  });

  it('fails on skew between packages, suggesting the newest version', async () => {
    expect(await checkVersions('/work/app', '0.1.0', installed(pkg('@ironbird/core', '0.1.0'), pkg('@ironbird/react-native', '0.2.0')))).toEqual({
      id: 'versions',
      ok: false,
      required: true,
      detail: '@ironbird/core 0.1.0, @ironbird/react-native 0.2.0, this CLI 0.1.0',
      fix: 'Install one version of every ironbird package, for example @ironbird/core@0.2.0 @ironbird/react-native@0.2.0, and run the CLI installed in the project (npx ironbird) so it matches',
    });
  });

  it('fails when the running CLI differs from the installed packages', async () => {
    expect(await checkVersions('/work/app', '0.2.0', installed(pkg('@ironbird/cli', '0.1.0'), pkg('@ironbird/core', '0.1.0')))).toMatchObject({
      ok: false,
      detail: '@ironbird/cli 0.1.0, @ironbird/core 0.1.0, this CLI 0.2.0',
    });
  });

  it('fails when nothing is installed, or a package has no readable version', async () => {
    expect(await checkVersions('/work/app', '0.1.0', installed())).toEqual({
      id: 'versions',
      ok: false,
      required: true,
      detail: 'No ironbird packages are installed in /work/app or above it',
      fix: 'Install @ironbird/core and @ironbird/react-native, and @ironbird/cli as a dev dependency, all at 0.1.0',
    });
    expect(await checkVersions('/work/app', '0.1.0', installed(pkg('@ironbird/core', undefined)))).toMatchObject({ ok: false, detail: '@ironbird/core (no readable version), this CLI 0.1.0' });
  });
});

describe('checkSimctl', () => {
  it('is optional and fails off macOS', async () => {
    expect(await checkSimctl(fakeEnvironment({ platform: 'linux' }))).toEqual({ id: 'simctl', ok: false, required: false, detail: 'iOS simulators need macOS; this machine runs linux' });
  });

  it('lists booted simulators', async () => {
    expect(await checkSimctl(fakeEnvironment())).toEqual({ id: 'simctl', ok: true, required: false, detail: `xcrun simctl is available; booted: iPhone 17 (${FAKE_UDID})` });
    const none = fakeEnvironment({ exec: async () => ({ stdout: Buffer.from(JSON.stringify({ devices: {} })), stderr: '' }) });
    expect((await checkSimctl(none)).detail).toBe('xcrun simctl is available; no simulator is booted');
  });

  it('fails without Xcode, quoting xcrun', async () => {
    const env = fakeEnvironment({
      exec: async () => {
        throw execFailure(72, 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH\n');
      },
    });
    expect(await checkSimctl(env)).toEqual({
      id: 'simctl',
      ok: false,
      required: false,
      detail: 'xcrun simctl is unavailable: xcrun: error: unable to find utility "simctl", not a developer tool or in PATH',
      fix: 'Install Xcode, open it once to finish installing its components, and select it with sudo xcode-select -s /Applications/Xcode.app',
    });
  });

  it('fails on output it cannot read rather than throwing', async () => {
    const env = fakeEnvironment({ exec: async () => ({ stdout: Buffer.from('not json'), stderr: '' }) });
    const check = await checkSimctl(env);
    expect(check.ok).toBe(false);
    expect(check.detail.startsWith('xcrun simctl is unavailable: ')).toBe(true);
  });
});

describe('checkAdb', () => {
  it('is optional and lists connected devices', async () => {
    expect(await checkAdb(fakeEnvironment())).toEqual({ id: 'adb', ok: true, required: false, detail: 'adb is available; devices: Pixel_8 (emulator-5554)' });
    const none = fakeEnvironment({ exec: async () => ({ stdout: Buffer.from('List of devices attached\n\n'), stderr: '' }) });
    expect((await checkAdb(none)).detail).toBe('adb is available; no device is connected');
  });

  it('fails without adb, or when adb fails, with a fix', async () => {
    const missing = fakeEnvironment({
      exec: async () => {
        throw execFailure('ENOENT');
      },
    });
    expect(await checkAdb(missing)).toEqual({ id: 'adb', ok: false, required: false, detail: 'adb is not on the PATH', fix: 'Install the Android SDK Platform-Tools and add them to your PATH' });
    const broken = fakeEnvironment({
      exec: async () => {
        throw execFailure(1, 'adb: failed to start daemon\nmore\n');
      },
    });
    expect(await checkAdb(broken)).toEqual({ id: 'adb', ok: false, required: false, detail: 'adb failed: adb: failed to start daemon', fix: 'Run adb devices and fix what it reports' });
  });
});

describe('one-line details', () => {
  it('keeps text from host tools and package.json on one line', async () => {
    const noisy = fakeEnvironment({
      exec: async () => {
        throw execFailure(1, 'adb: bad\u001b[31m thing\r\nsecond line\n');
      },
    });
    expect((await checkAdb(noisy)).detail).toBe('adb failed: adb: bad [31m thing');
    const pkg = { name: '@ironbird/core', version: '0.1.0\nextra', dir: '/x' };
    expect((await checkVersions('/work/app', '0.1.0', { listInstalledPackages: async () => [pkg] })).detail).toBe('@ironbird/core 0.1.0 extra, this CLI 0.1.0');
    expect(failureText(new Error('a\nb'))).toBe('a b');
    expect(failureText(new Error('x'.repeat(500))).length).toBe(203);
  });
});
