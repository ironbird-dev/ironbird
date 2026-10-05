import { parseScenario, runScenario as runScenarioOnClient } from '@ironbird/cli/runner';
import * as fc from 'fast-check';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordedStep } from './steps';
import { createTestTarget } from './target';
import { counterApp } from './test-app';
import { traceSlug, traceYaml, writeTrace, type Trace } from './trace';

const INC: RecordedStep = { send: 'count.inc', payload: {}, rejected: false };
const FAIL: RecordedStep = { send: 'count.fail', payload: {}, rejected: true };

// The rejected step in the middle must not reach the file.
const TRACE: Trace = {
  invariant: 'the bell never rings',
  seed: 42,
  path: '3:1:0',
  steps: [INC, FAIL, { fake: 'bell', control: 'strike', payload: { times: 1 }, rejected: false }, { clock: 100, rejected: false }],
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ironbird-trace-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('traceYaml', () => {
  it('writes the applied steps as a scenario file with a leading reset, leaving rejected steps out', () => {
    expect(traceYaml(TRACE)).toBe(
      [
        'name: "Counterexample: the bell never rings"',
        'description: "modelTest seed 42, path 3:1:0. A trace: it reproduces the violating state; add expect steps to make it a regression check."',
        'steps:',
        '  - reset: true',
        '  - send: count.inc',
        '    payload: {}',
        '  - fake: bell',
        '    control: strike',
        '    payload:',
        '      times: 1',
        '  - clock: 100',
        '',
      ].join('\n'),
    );
  });

  it('says in the description which rejected steps changed state, so replay may not reproduce the violation', () => {
    const yaml = traceYaml({ ...TRACE, rejectedAfterChange: [1, 3] });
    const scenario = parseScenario(yaml, 'trace.yaml');
    expect(scenario.description).toBe(
      'modelTest seed 42, path 3:1:0. A trace: it reproduces the violating state; add expect steps to make it a regression check.\n' +
        'Not faithfully replayable: steps 1, 3 of details.steps were rejected after changing state; the trace leaves them out, so replay may not reproduce the violation.',
    );
    expect(scenario.steps.map((step) => step.kind)).toEqual(['reset', 'send', 'fake', 'clock']);
    expect(traceYaml({ ...TRACE, rejectedAfterChange: [] })).toBe(traceYaml(TRACE));
  });

  it('round-trips through parseScenario', () => {
    const scenario = parseScenario(traceYaml(TRACE), 'trace.yaml');
    expect(scenario.name).toBe('Counterexample: the bell never rings');
    expect(scenario.description).toContain('seed 42, path 3:1:0');
    expect(scenario.steps.map((step) => step.kind)).toEqual(['reset', 'send', 'fake', 'clock']);
    expect(scenario.steps[1]).toMatchObject({ kind: 'send', command: 'count.inc', payload: {} });
    expect(scenario.steps[2]).toMatchObject({ kind: 'fake', fake: 'bell', control: 'strike', payload: { times: 1 } });
    expect(scenario.steps[3]).toMatchObject({ kind: 'clock', ms: 100, optional: false });
  });

  it('keeps any JSON payload and any invariant name exact', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.string({ unit: 'binary', minLength: 1 }), (payload, invariant) => {
        const scenario = parseScenario(traceYaml({ invariant, seed: 1, path: '0', steps: [{ send: 'x', payload, rejected: false }] }), 'trace.yaml');
        const step = scenario.steps[1];
        return scenario.name === `Counterexample: ${invariant}` && step?.kind === 'send' && JSON.stringify(step.payload) === JSON.stringify(payload);
      }),
      { numRuns: 500, seed: 1 },
    );
  });

  it('replays through the CLI runner on a fresh target with a rejected step in the middle, where keeping it would fail', async () => {
    const recorded: Trace = { invariant: 'count stays at or below the cap', seed: 1, path: '0', steps: [INC, FAIL, INC, INC] };
    const scenario = parseScenario(traceYaml(recorded), 'trace.yaml');
    expect(scenario.steps.map((step) => step.kind)).toEqual(['reset', 'send', 'send', 'send']);
    const target = await createTestTarget({ headless: counterApp, env: { BUG: '1' } });
    try {
      const replayed = await runScenarioOnClient(target.client, scenario, { file: 'trace.yaml', artifacts: false, reset: true });
      expect(replayed).toMatchObject({ passed: true, stepsRun: 4 });
      expect(await target.state('count')).toBe(3);
      // The same steps with the rejected one kept: the runner stops at it with DISPATCH_FAILED.
      const kept = parseScenario(['name: Kept', 'steps:', '  - send: count.inc', '  - send: count.fail', '  - send: count.inc', '  - send: count.inc', ''].join('\n'), 'kept.yaml');
      const stopped = await runScenarioOnClient(target.client, kept, { file: 'kept.yaml', artifacts: false, reset: true });
      expect(stopped).toMatchObject({ passed: false, failedStep: { index: 1, error: { code: 'DISPATCH_FAILED' } } });
    } finally {
      await target.dispose();
    }
  });
});

describe('traceSlug', () => {
  it('makes a filesystem-safe name of at most 60 characters', () => {
    expect(traceSlug('the bell never rings')).toBe('the-bell-never-rings');
    expect(traceSlug('Completed orders have a non-zero total!')).toBe('completed-orders-have-a-non-zero-total');
    expect(traceSlug('!!!')).toBe('invariant');
    expect(traceSlug('x'.repeat(80))).toHaveLength(60);
  });
});

describe('writeTrace', () => {
  it('writes <stamp>-<slug>.trace.yaml under the directory, creating it', async () => {
    const file = await writeTrace(path.join(dir, 'model'), TRACE, { now: () => Date.parse('2026-10-03T12:34:56.789Z') });
    expect(file).toBe(path.join(dir, 'model', '2026-10-03T12-34-56-789Z-the-bell-never-rings.trace.yaml'));
    expect(await readFile(file, 'utf8')).toBe(traceYaml(TRACE));
  });

  it('fails with INTERNAL naming the file when the directory cannot be created', async () => {
    const blocker = path.join(dir, 'file');
    await writeFile(blocker, '');
    const clock = { now: () => Date.parse('2026-10-03T12:34:56.789Z') };
    const error = await writeTrace(path.join(blocker, 'model'), TRACE, clock).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const expectedFile = path.join(blocker, 'model', '2026-10-03T12-34-56-789Z-the-bell-never-rings.trace.yaml');
    expect(error).toMatchObject({ name: 'IronbirdError', code: 'INTERNAL', details: { file: expectedFile, message: expect.any(String) } });
    expect((error as Error).message).toContain(`Could not write trace ${expectedFile}: `);
  });
});
