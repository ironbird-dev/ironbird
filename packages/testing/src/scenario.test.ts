import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScenario } from './scenario';
import { counterApp } from './test-app';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenario-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function scenarioFile(name: string, lines: string[]): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

const RING_ONCE = [
  'name: Ring once',
  'steps:',
  '  - send: count.inc',
  '  - fake: bell',
  '    control: strike',
  '    payload: { times: 1 }',
  '  - clock: 100',
  '  - expect: count',
  '    equals: 1',
  '  - expect: rings',
  '    equals: 1',
];

describe('runScenario', () => {
  it('runs a passing scenario headless from a fresh app and writes nothing by default', async () => {
    const file = await scenarioFile('ring.yaml', RING_ONCE);
    const result = await runScenario(file, { headless: counterApp });
    expect(result).toMatchObject({ scenario: 'Ring once', file, target: 'headless', passed: true, stepsRun: 5, skipped: [], artifacts: null });
    expect(await readdir(dir)).toEqual(['ring.yaml']);
  });

  it('returns a failing scenario as passed: false with the failed step', async () => {
    const file = await scenarioFile('wrong.yaml', ['name: Wrong count', 'steps:', '  - send: count.inc', '  - expect: count', '    equals: 5']);
    const result = await runScenario(file, { headless: counterApp });
    expect(result.passed).toBe(false);
    expect(result.failedStep).toMatchObject({ index: 1, expected: { equals: 5 }, actual: 1 });
  });

  it('passes env to the app', async () => {
    const file = await scenarioFile('cap.yaml', ['name: Past the cap', 'steps:', '  - send: count.inc', '    repeat: 3', '  - expect: count', '    equals: 3']);
    expect((await runScenario(file, { headless: counterApp })).passed).toBe(false);
    expect((await runScenario(file, { headless: counterApp, env: { BUG: '1' } })).passed).toBe(true);
  });

  it('runs a scenario written for a device on the headless target', async () => {
    const file = await scenarioFile('ios.yaml', ['name: On iOS', 'target: ios', 'steps:', '  - send: count.inc', '  - screenshot: after', '    optional: true']);
    const result = await runScenario(file, { headless: counterApp });
    expect(result).toMatchObject({ target: 'headless', passed: true, stepsRun: 1, skipped: [1] });
  });

  it('writes the run directory under artifacts when asked', async () => {
    const file = await scenarioFile('ring.yaml', RING_ONCE);
    const root = path.join(dir, 'artifacts');
    const result = await runScenario(file, { headless: counterApp, artifacts: root });
    expect(typeof result.artifacts).toBe('string');
    const runDir = result.artifacts as string;
    expect(runDir.startsWith(path.join(root, 'runs'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'))).toMatchObject({ passed: true });
  });

  it('throws INVALID_SCENARIO for an invalid file, a missing path, or a directory', async () => {
    const invalid = await scenarioFile('bad.yaml', ['name: Bad', 'steps:', '  - send: count.inc', '    payloads: {}']);
    await expect(runScenario(invalid, { headless: counterApp })).rejects.toMatchObject({ code: 'INVALID_SCENARIO', details: { file: invalid } });
    await expect(runScenario(path.join(dir, 'missing.yaml'), { headless: counterApp })).rejects.toMatchObject({ code: 'INVALID_SCENARIO' });
    // A directory of valid files, so the directory itself is the only problem.
    const suite = path.join(dir, 'suite');
    await mkdir(suite);
    await writeFile(path.join(suite, 'ring.yaml'), `${RING_ONCE.join('\n')}\n`);
    await expect(runScenario(suite, { headless: counterApp })).rejects.toMatchObject({ code: 'INVALID_SCENARIO', message: expect.stringContaining('is a directory') });
  });
});
