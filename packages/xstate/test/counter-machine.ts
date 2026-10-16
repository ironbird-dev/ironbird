import { defineCommands } from '@ironbird/core';
import { assign, fromCallback, setup } from 'xstate';
import { z } from 'zod';

// A test fixture, never exported from the package: a counter with a note, a `busy` state that
// invokes a callback actor (whose starts and stops `lifecycle` counts), an action that throws, and
// an event no state handles.

export interface Lifecycle {
  started: number;
  stopped: number;
}

export interface CounterContext {
  count: number;
  note: string;
}

export function counterMachine(lifecycle: Lifecycle = { started: 0, stopped: 0 }) {
  const ticker = fromCallback(() => {
    lifecycle.started += 1;
    return () => {
      lifecycle.stopped += 1;
    };
  });
  return setup({
    types: {
      context: {} as CounterContext,
      events: {} as
        | { type: 'count.add'; by: number }
        | { type: 'note.set'; text: string }
        | { type: 'raw'; payload: unknown }
        | { type: 'busy.start' }
        | { type: 'busy.stop' }
        | { type: 'boom' }
        | { type: 'noop' },
    },
    actors: { ticker },
  }).createMachine({
    id: 'counter',
    initial: 'idle',
    context: { count: 0, note: '' },
    on: {
      'count.add': { actions: assign({ count: ({ context, event }) => context.count + event.by }) },
      'note.set': { actions: assign({ note: ({ event }) => event.text }) },
      raw: { actions: assign({ note: ({ event }) => JSON.stringify(event.payload) }) },
      boom: {
        actions: () => {
          throw new Error('boom');
        },
      },
    },
    states: {
      idle: { on: { 'busy.start': 'busy' } },
      busy: { invoke: { id: 'ticker', src: 'ticker' }, on: { 'busy.stop': 'idle' } },
    },
  });
}

export const counterCommands = defineCommands({
  'count.add': z.object({ by: z.number().int().min(1) }).describe('Add by'),
  // Declares a `type` key on purpose: the default event mapping must not let it rename the event.
  'note.set': z.object({ text: z.string(), type: z.string().optional() }).describe('Set the note'),
  raw: z.number().describe('A payload that is not an object'),
  'busy.start': z.object({}).describe('Enter busy, which invokes the ticker'),
  'busy.stop': z.object({}).describe('Leave busy'),
  boom: z.object({}).describe('Run an action that throws'),
  noop: z.object({}).describe('An event no state handles'),
});

/** Loose, so `children` and `historyValue` survive parsing; XState needs them to restore. */
export const counterSnapshotSchema = z.looseObject({
  status: z.literal('active'),
  value: z.string(),
  context: z.object({ count: z.number().int().min(0), note: z.string() }),
});
