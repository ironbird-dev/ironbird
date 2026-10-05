import { createServer as createHttpServer } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon } from '../daemon';
import { PORT_PROBE_TIMEOUT_MS, SKIPPED_DETAIL, SKIPPED_FIX, checkNode, checkPort, identifyDaemon, statusUrl } from './checks';
import { systemEnvironment, type HttpProbe } from './environment';
import { fakeEnvironment } from './fake-environment';

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
