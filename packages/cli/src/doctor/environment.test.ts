import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, type Daemon } from '../daemon';
import { listInstalledPackages, probeHttp, systemEnvironment, tryBind } from './environment';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A TCP server on an ephemeral loopback port that accepts connections and never writes a byte. */
async function silentServer(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function daemon(token?: string): Promise<Daemon> {
  const started = await startDaemon({ host: '127.0.0.1', port: 0, version: '9.9.9-test', log: () => {}, ...(token === undefined ? {} : { token }) });
  cleanups.push(() => started.close());
  return started;
}

describe('tryBind', () => {
  it('binds and releases a free port', async () => {
    const port = await freePort();
    expect(await tryBind('127.0.0.1', port)).toEqual({ ok: true });
    expect(await tryBind('127.0.0.1', port)).toEqual({ ok: true });
  });

  it('reports EADDRINUSE for a port in use', async () => {
    const port = await silentServer();
    expect(await tryBind('127.0.0.1', port)).toMatchObject({ ok: false, code: 'EADDRINUSE' });
  });

  it('reports EADDRNOTAVAIL for an address this machine does not have', async () => {
    expect(await tryBind('203.0.113.1', 0)).toMatchObject({ ok: false, code: 'EADDRNOTAVAIL' });
  });
});

describe('probeHttp', () => {
  it('reads status from an ironbird daemon, and the 401 UNAUTHORIZED envelope from one that needs a token', async () => {
    const open = await daemon();
    const answered = await probeHttp(`${open.url}/v1/rpc`, 1_000);
    expect(answered).toMatchObject({ kind: 'response', status: 200 });
    expect(JSON.parse((answered as { body: string }).body)).toMatchObject({ ok: true, result: { version: '9.9.9-test', protocol: 1 } });

    const locked = await daemon('secret');
    const refused = await probeHttp(`${locked.url}/v1/rpc`, 1_000);
    expect(refused).toMatchObject({ kind: 'response', status: 401 });
    expect(JSON.parse((refused as { body: string }).body)).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Token missing or wrong' } });
  });

  it('returns any other HTTP server answer as it is', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>hi</html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address() as net.AddressInfo;
    expect(await probeHttp(`http://127.0.0.1:${port}/v1/rpc`, 1_000)).toEqual({ kind: 'response', status: 200, body: '<html>hi</html>' });
  });

  it('times out on a server that accepts but never answers', async () => {
    const port = await silentServer();
    const started = performance.now();
    expect(await probeHttp(`http://127.0.0.1:${port}/v1/rpc`, 100)).toEqual({ kind: 'timeout' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('reports a closed port as unreachable', async () => {
    const port = await freePort();
    expect(await probeHttp(`http://127.0.0.1:${port}/v1/rpc`, 1_000)).toEqual({ kind: 'unreachable', code: 'ECONNREFUSED' });
  });
});

describe('listInstalledPackages', () => {
  it('finds @ironbird/* and ironbird walking up the tree, the nearest copy first, as Node resolves them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ironbird-doctor-packages-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const manifest = async (dir: string, body: unknown): Promise<void> => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'package.json'), typeof body === 'string' ? body : JSON.stringify(body));
    };
    const app = path.join(root, 'apps', 'mobile');
    const top = path.join(root, 'node_modules');
    await manifest(path.join(app, 'node_modules', '@ironbird', 'core'), { name: '@ironbird/core', version: '0.2.0' });
    await manifest(path.join(top, '@ironbird', 'core'), { name: '@ironbird/core', version: '0.1.0' });
    await manifest(path.join(top, '@ironbird', 'cli'), { name: '@ironbird/cli', version: '0.2.0' });
    await manifest(path.join(top, '@ironbird', 'broken'), '{ not json');
    await manifest(path.join(top, 'ironbird'), { name: 'ironbird', version: '0.2.0' });
    await manifest(path.join(top, 'ironbird-unrelated'), { name: 'ironbird-unrelated', version: '9.0.0' });
    await mkdir(path.join(top, '@ironbird', '.cache'), { recursive: true });

    expect(await listInstalledPackages(app)).toEqual([
      { name: '@ironbird/broken', version: undefined, dir: path.join(top, '@ironbird', 'broken') },
      { name: '@ironbird/cli', version: '0.2.0', dir: path.join(top, '@ironbird', 'cli') },
      { name: '@ironbird/core', version: '0.2.0', dir: path.join(app, 'node_modules', '@ironbird', 'core') },
      { name: 'ironbird', version: '0.2.0', dir: path.join(top, 'ironbird') },
    ]);
  });

  it('returns nothing where no ironbird package is installed', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'ironbird-doctor-empty-'));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));
    expect(await listInstalledPackages(empty)).toEqual([]);
  });
});

describe('systemEnvironment', () => {
  it('reports this process', () => {
    const env = systemEnvironment();
    expect(env.nodeVersion).toBe(process.versions.node);
    expect(env.platform).toBe(process.platform);
  });
});
