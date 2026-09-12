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

function start(cwd: string, options: Partial<Parameters<typeof runServe>[0]> = {}, env: Record<string, string> = {}): Run {
  const controller = new AbortController();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = runServe({ headless: true, json: true, port: 0, ...options }, { cwd, env, stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t), version: '0.0.0-test', signal: controller.signal });
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

  it('knows loopback hosts', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.5')).toBe(false);
  });
});
