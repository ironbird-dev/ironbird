import { isIronbirdError } from '@ironbird/core';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SKIPPED_DETAIL, SKIPPED_FIX } from './checks';
import { CONFIG_DOCS_URL, checkProject } from './project';

const FIXTURE = path.resolve(__dirname, '../../test/fixtures/doctor-app');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ironbird-doctor-project-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (file: string, text: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), text);
};
const absent = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => false,
    () => true,
  );
const WITH_HEADLESS = `export default { appId: 'com.example.doctor', headless: './src/headless.ts' };\n`;

describe('checkProject', () => {
  it('fails a missing config with a fix naming the file and its docs, and reports the defaults', async () => {
    const result = await checkProject({ cwd: dir });
    expect(result.config).toEqual({
      id: 'config',
      ok: false,
      required: true,
      detail: `No ironbird.config.ts in ${dir} or any directory above it`,
      fix: `Create ${path.join(dir, 'ironbird.config.ts')} that default-exports defineConfig({ appId: '<your app id>' }) from @ironbird/cli/config; see ${CONFIG_DOCS_URL}`,
    });
    expect(result.headless).toEqual({ id: 'headless', ok: true, required: true, detail: 'not configured' });
    expect(result.outcome).toMatchObject({ status: 'missing', rootDir: dir, config: { daemon: { port: 4567 }, bridge: { port: 4568 }, artifactsPath: path.join(dir, '.ironbird') } });
    expect(await absent(path.join(dir, '.ironbird'))).toBe(true);
  });

  it('fails a --config file that does not exist', async () => {
    const result = await checkProject({ cwd: dir, configPath: 'custom.config.ts' });
    expect(result.config).toMatchObject({ ok: false, detail: 'custom.config.ts does not exist' });
    expect(result.config.fix).toContain(`Create ${path.join(dir, 'custom.config.ts')}`);
    expect(result.outcome).toMatchObject({ status: 'missing', rootDir: dir });
  });

  it('passes a remote-only config, with the headless check "not configured"', async () => {
    await write('ironbird.config.ts', `export default { appId: 'com.example.doctor' };\n`);
    const result = await checkProject({ cwd: dir });
    expect(result.config).toEqual({ id: 'config', ok: true, required: true, detail: 'ironbird.config.ts is valid' });
    expect(result.headless).toEqual({ id: 'headless', ok: true, required: true, detail: 'not configured' });
    expect(result.outcome).toMatchObject({ status: 'loaded', rootDir: dir, config: { appId: 'com.example.doctor' } });
  });

  it('lists the INVALID_CONFIG issues of an invalid config and skips the headless check', async () => {
    await write('ironbird.config.ts', `export default { daemon: { port: 'eighty' }, artifactDir: 'x' };\n`);
    const result = await checkProject({ cwd: dir });
    expect(result.config).toEqual({
      id: 'config',
      ok: false,
      required: true,
      detail: 'ironbird.config.ts is invalid: daemon.port: Invalid input: expected number, received string; Unrecognized key: "artifactDir"',
      fix: `Fix ironbird.config.ts; see ${CONFIG_DOCS_URL}`,
    });
    expect(result.headless).toEqual({ id: 'headless', ok: false, required: true, detail: SKIPPED_DETAIL, fix: SKIPPED_FIX });
    expect(result.outcome).toEqual({ status: 'invalid', rootDir: dir });
  });

  it('reports a config that fails to bundle', async () => {
    await write('ironbird.config.ts', 'export default {\n');
    const result = await checkProject({ cwd: dir });
    expect(result.config.ok).toBe(false);
    // loadTypeScriptModule puts esbuild's own text (without its "Failed to load" prefix) in the issue.
    expect(result.config.detail).toMatch(/^ironbird\.config\.ts is invalid: .*(Expected|Unexpected)/);
  });

  it('loads the headless entry without booting it', async () => {
    await write('ironbird.config.ts', WITH_HEADLESS);
    await write('src/headless.ts', `export default { kind: 'ironbird.headless', create: async () => { throw new Error('booted'); } };\n`);
    expect((await checkProject({ cwd: dir })).headless).toEqual({ id: 'headless', ok: true, required: true, detail: 'src/headless.ts loads' });
  });

  it('fails a headless entry that does not default-export defineHeadless', async () => {
    await write('ironbird.config.ts', WITH_HEADLESS);
    await write('src/headless.ts', 'export default { answer: 42 };\n');
    expect((await checkProject({ cwd: dir })).headless).toEqual({
      id: 'headless',
      ok: false,
      required: true,
      detail: 'src/headless.ts must default-export defineHeadless(...)',
      fix: 'Default-export defineHeadless(...) from @ironbird/core in src/headless.ts',
    });
  });

  it('reports the import chain when the headless graph imports react-native', async () => {
    await write('ironbird.config.ts', WITH_HEADLESS);
    await write('src/headless.ts', `import { platform } from './pricing';\nexport default { platform };\n`);
    await write('src/pricing.ts', `import { Platform } from 'react-native';\nexport const platform = Platform;\n`);
    expect((await checkProject({ cwd: dir })).headless).toEqual({
      id: 'headless',
      ok: false,
      required: true,
      detail: 'react-native is imported in the headless graph: headless.ts > pricing.ts > react-native',
      fix: 'Headless code runs in Node, so nothing it imports may import react-native: move that import out of this chain, for example behind a port with a fake',
    });
  });

  it('reports any other load failure with its message', async () => {
    await write('ironbird.config.ts', WITH_HEADLESS);
    await write('src/headless.ts', `throw new Error('boom at load');\n`);
    const { headless } = await checkProject({ cwd: dir });
    expect(headless.ok).toBe(false);
    expect(headless.detail).toContain('boom at load');
    expect(headless.fix).toBeUndefined();
  });

  it('lists every INVALID_CONFIG issue on one line, without truncating', async () => {
    const keys = Array.from({ length: 30 }, (_, index) => `unknownKey${index}: 1`).join(', ');
    await write('ironbird.config.ts', `export default { ${keys} };\n`);
    const { config } = await checkProject({ cwd: dir });
    expect(config.ok).toBe(false);
    expect(config.detail.length).toBeGreaterThan(500);
    expect(config.detail).not.toMatch(/[\r\n]|\.\.\.$/);
    for (let index = 0; index < 30; index += 1) expect(config.detail).toContain(`"unknownKey${index}"`);
  });

  it('throws an INTERNAL error when the scratch directory cannot be removed', async () => {
    await write('ironbird.config.ts', `export default { appId: 'com.example.doctor' };\n`);
    let scratch = '';
    const removeDir = async (target: string): Promise<void> => {
      scratch = target;
      throw new Error('disk on fire');
    };
    const error = await checkProject({ cwd: dir, removeDir }).catch((caught: unknown) => caught);
    expect(isIronbirdError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'INTERNAL', message: `Could not remove doctor scratch directory ${scratch}: disk on fire`, details: { dir: scratch, message: 'disk on fire' } });
    expect(path.dirname(scratch)).toBe(path.join(dir, '.ironbird'));
    await rm(scratch, { recursive: true, force: true });
  });

  it('keeps a multi-line load failure on one line', async () => {
    await write('ironbird.config.ts', WITH_HEADLESS);
    await write('src/headless.ts', `throw new Error('first line\\nsecond line');\n`);
    const { headless } = await checkProject({ cwd: dir });
    expect(headless.ok).toBe(false);
    expect(headless.detail).toContain('first line second line');
    expect(headless.detail).not.toMatch(/[\r\n]/);
  });

  it("bundles where the daemon would, so bare imports resolve from the app's node_modules, and leaves no .ironbird behind", async () => {
    expect(await absent(path.join(FIXTURE, '.ironbird'))).toBe(true);
    const result = await checkProject({ cwd: FIXTURE });
    expect(result.config).toMatchObject({ ok: true });
    expect(result.headless).toEqual({ id: 'headless', ok: true, required: true, detail: 'headless.ts loads' });
    expect(await absent(path.join(FIXTURE, '.ironbird'))).toBe(true);
  });

  it("never touches an existing .ironbird/cache or daemon.json, and removes its own directory", async () => {
    await write('ironbird.config.ts', WITH_HEADLESS);
    await write('src/headless.ts', `export default { kind: 'ironbird.headless', create: async () => ({}) };\n`);
    await write('.ironbird/cache/headless-1.mjs', 'daemon bundle');
    await write('.ironbird/daemon.json', '{"url":"http://127.0.0.1:4567"}');
    expect((await checkProject({ cwd: dir })).headless.ok).toBe(true);
    expect((await readdir(path.join(dir, '.ironbird'))).sort()).toEqual(['cache', 'daemon.json']);
    expect(await readdir(path.join(dir, '.ironbird', 'cache'))).toEqual(['headless-1.mjs']);
    expect(await readFile(path.join(dir, '.ironbird', 'cache', 'headless-1.mjs'), 'utf8')).toBe('daemon bundle');
    expect(await readFile(path.join(dir, '.ironbird', 'daemon.json'), 'utf8')).toBe('{"url":"http://127.0.0.1:4567"}');
  });

  it('fails config and headless when it cannot create its temporary directory', async () => {
    await write('ironbird.config.ts', WITH_HEADLESS);
    await write('.ironbird', 'a file where the directory should be');
    const result = await checkProject({ cwd: dir });
    expect(result.config.ok).toBe(false);
    expect(result.config.detail).toContain(`Cannot create a temporary directory under ${path.join(dir, '.ironbird')}`);
    expect(result.headless).toEqual({ id: 'headless', ok: false, required: true, detail: SKIPPED_DETAIL, fix: SKIPPED_FIX });
    expect(result.outcome).toEqual({ status: 'invalid', rootDir: dir });
  });
});
