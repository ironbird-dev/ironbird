import { isIronbirdError } from '@ironbird/core';
import { modelTest, type ModelStep } from '@ironbird/testing';
import { describe, expect, it } from 'vitest';
import { MAX_TODOS, todoApp, type TodosState } from './sample-app';

const STEPS: ModelStep[] = ['todos/add', 'todos/toggle', 'todos/clearDone'];
const CAP = 'the list holds at most three to-dos';
const INVARIANTS = { [CAP]: (state: TodosState) => state.items.length <= MAX_TODOS };

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
    expect(details.steps.map((step) => step.send)).toEqual(Array.from({ length: MAX_TODOS + 1 }, () => 'todos/add'));
  });
});
