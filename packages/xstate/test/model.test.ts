import { isIronbirdError } from '@ironbird/core';
import { createTestTarget, modelTest, type ModelStep } from '@ironbird/testing';
import { describe, expect, it } from 'vitest';
import { timerApp, type TimerState } from './sample-app';

const STEPS: ModelStep[] = ['count.add', 'timer.start', 'timer.cancel', { clock: { maxMs: 250 } }];
const CAP = 'count stays at or below five';
// The contract's literal five, independent of the sample's COUNT_CAP, so changing the sample's cap fails these tests.
const INVARIANTS = {
  [CAP]: (state: TimerState) => state.context.count <= 5,
  'the state is idle or running': (state: TimerState) => state.value === 'idle' || state.value === 'running',
};

describe('@ironbird/xstate under modelTest', () => {
  it('holds the invariants over generated sequences, clock steps included', async () => {
    const result = await modelTest<TimerState>({ headless: timerApp, steps: STEPS, invariants: INVARIANTS, numRuns: 50, maxSteps: 12, seed: 1, artifacts: false });
    expect(result.runs).toBe(50);
    expect(result.stepsApplied).toBeGreaterThan(0);
  });

  it('finds the planted bug through the target state', async () => {
    const error = await modelTest<TimerState>({ headless: timerApp, env: { BUG: '1' }, steps: STEPS, invariants: INVARIANTS, numRuns: 100, seed: 1, artifacts: false }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isIronbirdError(error) ? error.code : error).toBe('INVARIANT_FAILED');
    expect((error as { details: { invariant: string } }).details.invariant).toBe(CAP);
  });

  // An at-most-five invariant is also satisfied by a stricter cap, so pin the cap from both sides.
  it('clamps the count at exactly five', async () => {
    const target = await createTestTarget({ headless: timerApp });
    try {
      await target.send('count.add', { by: 3 });
      await target.send('count.add', { by: 1 });
      expect(await target.state('context.count')).toBe(4);
      await target.send('count.add', { by: 1 });
      expect(await target.state('context.count')).toBe(5);
      await target.send('count.add', { by: 3 });
      expect(await target.state('context.count')).toBe(5);
    } finally {
      await target.dispose();
    }
  });

  // The clock steps only matter if the ring lands at exactly the contract's 100 ms, so pin it from both sides.
  it('runs the delayed transition on the headless clock, ringing at exactly 100 ms', async () => {
    const target = await createTestTarget({ headless: timerApp });
    try {
      await target.send('timer.start');
      await target.advance(99);
      expect(await target.state()).toEqual({ value: 'running', context: { count: 0, rings: 0 } });
      await target.advance(1);
      expect(await target.state()).toEqual({ value: 'idle', context: { count: 0, rings: 1 } });
    } finally {
      await target.dispose();
    }
  });
});
