import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDaemonInfo } from '../../daemon-info';
import { isLoopback, runServe } from './serve';

const example = path.resolve(__dirname, '../../../../../examples/checkout');

interface Run {
  stdout: string[];
  stderr: string[];
  exit: Promise<number>;
  stop: () => void;
}

const noAdb = async (): Promise<never> => {
  throw Object.assign(new Error('adb not installed'), { code: 'ENOENT' });
};

function start(cwd: string, options: Partial<Parameters<typeof runServe>[0]> = {}, env: Record<string, string> = {}): Run {
  const controller = new AbortController();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = runServe({ headless: true, json: true, port: 0, bridgePort: 0, ...options }, { cwd, env, stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t), version: '0.0.0-test', signal: controller.signal, exec: noAdb });
  return { stdout, stderr, exit, stop: () => controller.abort() };
}

async function firstLine(run: Run): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200 && run.stdout.length === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
  return JSON.parse(run.stdout[0] ?? '{}') as Record<string, unknown>;
}

describe('runServe', () => {
  let temp: string | undefined;
  afterEach(async () => {
    if (temp) await rm(temp, { recursive: true, force: true });
    temp = undefined;
    await rm(path.join(example, '.ironbird/daemon.json'), { force: true });
  });

  it('loads the example headless entry, starts the daemon, writes daemon.json, and cleans up on abort', async () => {
    const run = start(example);
    const line = await firstLine(run);
    expect(line['url']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(line['defaultTarget']).toBe('headless');
    expect(line['targets']).toEqual([expect.objectContaining({ id: 'headless', appId: 'com.example.checkout' })]);
    const info = await readDaemonInfo(path.join(example, '.ironbird'));
    expect(info?.url).toBe(line['url']);
    const response = await fetch(`${line['url'] as string}/v1/rpc`, { method: 'POST', body: JSON.stringify({ op: 'describe' }) });
    const described = (await response.json()) as { result: { commands: Record<string, unknown> } };
    expect(Object.keys(described.result.commands)).toEqual(['cart.addItem', 'cart.clear', 'payment.start']);
    run.stop();
    expect(await run.exit).toBe(0);
    expect(await readDaemonInfo(path.join(example, '.ironbird'))).toBeUndefined();
  });

  it('exits 2 with HEADLESS_LOAD_FAILED and the import chain when the entry imports react-native', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-serve-'));
    await writeFile(path.join(temp, 'ironbird.config.ts'), `export default { headless: './headless.ts' };`);
    await writeFile(path.join(temp, 'pricing.ts'), `import { Platform } from 'react-native'; export const p = Platform;`);
    await writeFile(path.join(temp, 'headless.ts'), `import { p } from './pricing'; export default p;`);
    const run = start(temp);
    expect(await run.exit).toBe(2);
    const printed = JSON.parse(run.stdout[0] ?? '{}') as { error: { code: string; details: { importChain: string[] } } };
    expect(printed.error.code).toBe('HEADLESS_LOAD_FAILED');
    expect(printed.error.details.importChain).toEqual(['headless.ts', 'pricing.ts', 'react-native']);
  });

  it('exits 2 when the default export is not a headless definition', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-serve-'));
    await writeFile(path.join(temp, 'ironbird.config.ts'), `export default { headless: './headless.ts' };`);
    await writeFile(path.join(temp, 'headless.ts'), `export default { nope: true };`);
    const run = start(temp);
    expect(await run.exit).toBe(2);
    expect(run.stdout[0]).toContain('defineHeadless');
  });

  it('runs remote-only with --no-headless and generates a token for a non-loopback host', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-serve-'));
    const run = start(temp, { headless: false, host: '0.0.0.0' });
    const line = await firstLine(run);
    expect(line['targets']).toEqual([]);
    expect(run.stderr.join('')).toMatch(/IRONBIRD_TOKEN=[0-9a-f]{32}/);
    run.stop();
    expect(await run.exit).toBe(0);
  });

  it('--no-headless skips a configured headless entry', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-serve-'));
    const headlessPath = path.resolve(__dirname, '../../../../../examples/checkout/src/ironbird/headless.ts');
    await writeFile(path.join(temp, 'ironbird.config.ts'), `export default { headless: '${headlessPath}' };`);
    const run = start(temp, { headless: false });
    const line = await firstLine(run);
    expect(line['targets']).toEqual([]);
    expect(line['defaultTarget']).toBeUndefined();
    run.stop();
    expect(await run.exit).toBe(0);
  });

  it('port in use exits 2 with INVALID_CONFIG and shows the port number', async () => {
    // Start first daemon on port 0 to get a random available port
    const run1 = start(example);
    const line1 = await firstLine(run1);
    const url = line1['url'] as string;
    const portMatch = url.match(/:(\d+)$/);
    expect(portMatch).toBeTruthy();
    const portStr = portMatch?.[1];
    expect(portStr).toBeTruthy();
    const usedPort = parseInt(portStr as string, 10);

    const infoBefore = await readDaemonInfo(path.join(example, '.ironbird'));
    expect(infoBefore?.url).toBe(url);

    // Try to start second daemon on the same port
    const run2 = start(example, { port: usedPort });
    const errorLine = await firstLine(run2);
    expect(await run2.exit).toBe(2);
    const error = errorLine['error'] as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe('INVALID_CONFIG');
    expect(String(error?.message)).toContain(String(usedPort));

    // The failed second serve never wrote daemon.json, so it must not delete the running
    // daemon's discovery file on its way out.
    expect(await readDaemonInfo(path.join(example, '.ironbird'))).toEqual(infoBefore);

    // Clean up first daemon
    run1.stop();
    expect(await run1.exit).toBe(0);
    expect(await readDaemonInfo(path.join(example, '.ironbird'))).toBeUndefined();
  });

  it('knows loopback hosts', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.5')).toBe(false);
  });

  it('prints the bridge URL, records it in daemon.json, and notes that adb is absent', async () => {
    const run = start(example);
    const line = await firstLine(run);
    expect(line['bridgeUrl']).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(line['bridgePort']).toBe(Number(new URL(line['bridgeUrl'] as string).port));
    const info = await readDaemonInfo(path.join(example, '.ironbird'));
    expect(info?.bridgeUrl).toBe(line['bridgeUrl']);
    expect(run.stderr.join('')).toContain('adb not found; skipping adb reverse');
    run.stop();
    expect(await run.exit).toBe(0);
  });

  it('a bridge port in use exits 2 with INVALID_CONFIG naming bridge.port', async () => {
    const run1 = start(example);
    const line1 = await firstLine(run1);
    const usedPort = Number(new URL(line1['bridgeUrl'] as string).port);
    const run2 = start(example, { bridgePort: usedPort });
    const errorLine = await firstLine(run2);
    expect(await run2.exit).toBe(2);
    expect(errorLine['error']).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining(String(usedPort)), details: { issues: [{ path: ['bridge', 'port'] }] } });
    run1.stop();
    expect(await run1.exit).toBe(0);
  });
});
