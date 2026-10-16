import { defineCommands, defineHeadless } from '@ironbird/core';
import { assign, createActor, setup } from 'xstate';
import { z } from 'zod';
import { fromActor } from '../src/index';

// The in-repo sample for @ironbird/xstate (M5 design §10, plan 1): a counter capped at five and a
// timer that rings 100 ms after it starts. The actor takes its time from the headless clock, so
// modelTest's clock steps drive the delayed transition (AGENTS.md rule 9), and restore passes the
// same clock to the replacement through `actorOptions`. With `env.BUG === '1'`, `count.add` skips
// the cap, the planted bug the model test must find.

export const COUNT_CAP = 5;
export const RING_DELAY_MS = 100;

export interface TimerContext {
  count: number;
  rings: number;
}

export interface TimerState {
  value: 'idle' | 'running';
  context: TimerContext;
}

export function timerMachine(buggy: boolean) {
  return setup({
    types: {
      context: {} as TimerContext,
      events: {} as { type: 'count.add'; by: number } | { type: 'timer.start' } | { type: 'timer.cancel' },
    },
  }).createMachine({
    id: 'timer',
    initial: 'idle',
    context: { count: 0, rings: 0 },
    on: {
      'count.add': { actions: assign({ count: ({ context, event }) => (buggy ? context.count + event.by : Math.min(COUNT_CAP, context.count + event.by)) }) },
    },
    states: {
      idle: { on: { 'timer.start': 'running' } },
      running: {
        after: { [RING_DELAY_MS]: { target: 'idle', actions: assign({ rings: ({ context }) => context.rings + 1 }) } },
        on: { 'timer.cancel': 'idle' },
      },
    },
  });
}

export const timerCommands = defineCommands({
  'count.add': z.object({ by: z.number().int().min(1).max(3) }).describe('Add by, up to five'),
  'timer.start': z.object({}).describe('Start the timer; it rings after 100 ms'),
  'timer.cancel': z.object({}).describe('Stop the timer without ringing'),
});

/** Loose, so `children` and `historyValue` survive parsing; XState needs them to restore. */
export const timerSnapshotSchema = z.looseObject({
  status: z.literal('active'),
  value: z.enum(['idle', 'running']),
  context: z.object({ count: z.number().int().min(0), rings: z.number().int().min(0) }),
});

export const timerApp = defineHeadless(({ clock, env }) => {
  const actorOptions = { clock };
  const actor = createActor(timerMachine(env['BUG'] === '1'), actorOptions).start();
  const target = fromActor(actor, { commands: timerCommands, restore: { snapshotSchema: timerSnapshotSchema, actorOptions } });
  return {
    target,
    // After a restore the live actor is the replacement, so stop whatever actor() returns now.
    dispose: () => {
      target.actor().stop();
    },
  };
});
