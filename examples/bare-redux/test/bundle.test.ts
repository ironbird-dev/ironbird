import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Metro builds of this example, checked the way a user checks theirs (docs/cli.md, verify-bundle):
// the release bundle must not contain the bridge, and the dev bundle must, so the clean release
// result isn't vacuous. The dev bundle also names every module's resolved path, which shows
// whether the monorepo resolved a second react-native.
const exec = promisify(execFile);
const example = path.resolve(__dirname, '..');
const cli = path.resolve(example, '../../packages/cli/dist/bin.js');
const reactNativeBin = path.join(example, 'node_modules/.bin/react-native');
let out: string;

beforeAll(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), 'ironbird-bare-redux-bundle-'));
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

async function bundle(dev: boolean): Promise<string> {
  const file = path.join(out, dev ? 'dev.jsbundle' : 'release.jsbundle');
  await exec(reactNativeBin, ['bundle', '--platform', 'ios', '--dev', String(dev), '--entry-file', 'index.js', '--bundle-output', file], {
    cwd: example,
    maxBuffer: 256 * 1024 * 1024,
  });
  return file;
}

async function verify(file: string): Promise<{ code: number; found: unknown[] }> {
  try {
    const { stdout } = await exec('node', [cli, 'verify-bundle', file, '--json'], { cwd: example });
    return { code: 0, found: (JSON.parse(stdout) as { found: unknown[] }).found };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    return { code: failure.code, found: (JSON.parse(failure.stdout) as { found: unknown[] }).found };
  }
}

describe('bare-redux Metro bundles', () => {
  // Regression check: passes before the bridge is wired and must keep passing after.
  it('keeps the bridge out of the release bundle', async () => {
    const result = await verify(await bundle(false));
    expect(result).toEqual({ code: 0, found: [] });
  }, 300_000);

  // The red-to-green gate for the device wiring (Step 3).
  it('ships the bridge in the dev bundle with exactly one react-native', async () => {
    const file = await bundle(true);
    const result = await verify(file);
    expect(result.code).toBe(1);
    expect(result.found).toHaveLength(1);
    const source = await readFile(file, 'utf8');
    expect(source).toMatch(/react-native@0\.87\.1/);
    expect(source).not.toMatch(/react-native@0\.86\./);
  }, 300_000);
});
