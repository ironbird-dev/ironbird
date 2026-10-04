// Requires the built CommonJS output, which requires @ironbird/cli/runner's CommonJS build, so
// this proves @ironbird/testing runs under Jest with no transform (M4 design D9). Build first.
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createTarget, defineCommands, defineHeadless } = require('@ironbird/core');
const { z } = require('zod');
const { modelTest, runScenario } = require('../dist/index.cjs');

const commands = defineCommands({ 'count.inc': z.object({}) });

// A counter capped at 2; with env.BUG === '1' the cap is skipped.
const app = defineHeadless(({ env }) => {
  let state = { count: 0 };
  const listeners = new Set();
  const target = createTarget({
    commands,
    dispatch: () => {
      state = { count: env.BUG === '1' ? state.count + 1 : Math.min(2, state.count + 1) };
      for (const listener of listeners) listener();
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return { target };
});

let dir;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ironbird-jest-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('runs a scenario file', async () => {
  const file = path.join(dir, 'count.yaml');
  writeFileSync(file, ['name: Count to the cap', 'steps:', '  - send: count.inc', '    repeat: 3', '  - expect: count', '    equals: 2', ''].join('\n'));
  const result = await runScenario(file, { headless: app });
  expect(result.passed).toBe(true);
});

test('finds a bug with modelTest', async () => {
  const inc = { send: 'count.inc', payload: {} };
  await expect(
    modelTest({ headless: app, env: { BUG: '1' }, steps: ['count.inc'], invariants: { 'count stays at or below 2': (s) => s.count <= 2 }, numRuns: 20, seed: 1, artifacts: false }),
  ).rejects.toMatchObject({ code: 'INVARIANT_FAILED', details: { steps: [inc, inc, inc] } });
});
