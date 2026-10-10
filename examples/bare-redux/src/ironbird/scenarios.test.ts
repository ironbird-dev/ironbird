import { runScenario } from '@ironbird/testing';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import headless from './headless';

const file = (name: string): string => path.resolve(__dirname, '../../ironbird/scenarios', name);

describe('the bare-redux scenarios, headless and in process', () => {
  it.each(['add-and-sync.yaml', 'ack-reorder.yaml', 'auto-reorder.yaml'])('%s passes', async (name) => {
    const result = await runScenario(file(name), { headless });
    expect(result.failedStep).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it.each([
    ['ack-reorder.yaml', 8],
    ['auto-reorder.yaml', 7],
  ])('%s fails at its last step with PLANT_BUG=1, showing revision 1', async (name, index) => {
    const result = await runScenario(file(name), { headless, env: { PLANT_BUG: '1' } });
    expect(result).toMatchObject({ passed: false, failedStep: { index, expected: { equals: 2 }, actual: 1 } });
  });

  it('add-and-sync passes with PLANT_BUG=1 too: a single save cannot be reordered', async () => {
    const result = await runScenario(file('add-and-sync.yaml'), { headless, env: { PLANT_BUG: '1' } });
    expect(result.passed).toBe(true);
  });

  it('passes the integration exercise acceptance scenario', async () => {
    const result = await runScenario(path.resolve(__dirname, '../../exercise/acceptance.yaml'), { headless });
    expect(result.failedStep).toBeUndefined();
    expect(result.passed).toBe(true);
  });
});
