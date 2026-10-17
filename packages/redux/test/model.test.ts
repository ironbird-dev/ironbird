import { isIronbirdError } from '@ironbird/core';
import { createTestTarget, modelTest, type ModelStep } from '@ironbird/testing';
import { describe, expect, it } from 'vitest';
import { todoApp, type TodosState } from './sample-app';

const STEPS: ModelStep[] = ['todos/add', 'todos/toggle', 'todos/clearDone'];
const CAP = 'the list holds at most three to-dos';
// The contract's literal three, independent of the sample's MAX_TODOS, so changing the sample's cap fails these tests.
const INVARIANTS = { [CAP]: (state: TodosState) => state.items.length <= 3 };

describe('@ironbird/redux under modelTest', () => {
  it('holds the cap over generated sequences', async () => {
    const result = await modelTest<TodosState>({ headless: todoApp, steps: STEPS, invariants: INVARIANTS, numRuns: 50, maxSteps: 12, seed: 1, artifacts: false });
    expect(result.runs).toBe(50);
    expect(result.stepsApplied).toBeGreaterThan(0);
  });

  it('finds the planted bug through the projected state and shrinks it to four adds', async () => {
    const error = await modelTest<TodosState>({ headless: todoApp, env: { BUG: '1' }, steps: ['todos/add'], invariants: INVARIANTS, numRuns: 100, seed: 1, artifacts: false }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isIronbirdError(error) ? error.code : error).toBe('INVARIANT_FAILED');
    const details = (error as { details: { invariant: string; steps: Array<{ send: string }> } }).details;
    expect(details.invariant).toBe(CAP);
    expect(details.steps.map((step) => step.send)).toEqual(['todos/add', 'todos/add', 'todos/add', 'todos/add']);
  });

  // An at-most-three invariant is also satisfied by a stricter cap, so pin the cap from both sides.
  it('applies exactly three adds and ignores the fourth', async () => {
    const target = await createTestTarget({ headless: todoApp });
    try {
      for (const text of ['a', 'b', 'c']) await target.send('todos/add', { text });
      expect(((await target.state()) as TodosState).items.map((item) => item.text)).toEqual(['a', 'b', 'c']);
      await target.send('todos/add', { text: 'd' });
      expect(((await target.state()) as TodosState).items).toHaveLength(3);
      expect(((await target.state()) as TodosState).items.map((item) => item.text)).toEqual(['a', 'b', 'c']);
    } finally {
      await target.dispose();
    }
  });
});
