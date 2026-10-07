import { isIronbirdError, type IronbirdError } from '@ironbird/core';
import { createActor } from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import { fromActor } from './from-actor';
import { counterCommands, counterMachine } from '../test/counter-machine';

async function failure(promise: Promise<unknown>): Promise<IronbirdError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return error;
}

// XState rethrows an unhandled actor error from a zero-delay timer; waiting past it lets Vitest
// report one as an unhandled error and fail the run.
const pastXStateErrorTimer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const started = () => createActor(counterMachine()).start();

describe('fromActor', () => {
  it('validates, then sends the payload keys plus type: name by default', async () => {
    const actor = started();
    const target = fromActor(actor, { commands: counterCommands });
    await target.dispatch('count.add', { by: 2 });
    expect(actor.getSnapshot().context.count).toBe(2);
  });

  it('never lets a payload key named type rename the event', async () => {
    const actor = started();
    const target = fromActor(actor, { commands: counterCommands });
    await target.dispatch('note.set', { text: 'hi', type: 'boom' });
    expect(actor.getSnapshot().context.note).toBe('hi');
    expect(actor.getSnapshot().status).toBe('active');
  });

  it('sends a payload that is not an object as { type, payload }', async () => {
    const actor = started();
    await fromActor(actor, { commands: counterCommands }).dispatch('raw', 3);
    expect(actor.getSnapshot().context.note).toBe('3');
  });

  it('rejects an invalid payload and an unknown command before the actor sees them', async () => {
    const actor = started();
    const before = actor.getSnapshot();
    const target = fromActor(actor, { commands: counterCommands });
    expect((await failure(target.dispatch('count.add', { by: 0 }))).code).toBe('INVALID_PAYLOAD');
    expect((await failure(target.dispatch('count.sub', {}))).code).toBe('UNKNOWN_COMMAND');
    expect(actor.getSnapshot()).toBe(before);
  });

  it('uses toEvent when given', async () => {
    const actor = started();
    const toEvent = vi.fn(() => ({ type: 'count.add' as const, by: 10 }));
    await fromActor(actor, { commands: counterCommands, toEvent }).dispatch('noop');
    expect(toEvent).toHaveBeenCalledWith({ name: 'noop', payload: {} });
    expect(actor.getSnapshot().context.count).toBe(10);
  });

  it('shows { value, context } by default and the projection with select', () => {
    const actor = started();
    expect(fromActor(actor, { commands: counterCommands }).getState()).toEqual({ value: 'idle', context: { count: 0, note: '' } });
    expect(fromActor(actor, { commands: counterCommands, select: (snapshot) => snapshot.context.count }).getState()).toBe(0);
  });

  it('moves the revision and notifies only when the snapshot changes', async () => {
    const actor = started();
    const target = fromActor(actor, { commands: counterCommands });
    const listener = vi.fn();
    target.subscribe(listener);
    await target.dispatch('count.add', { by: 1 });
    expect(target.revision()).toBe(1);
    // XState notifies its observers for this event too, but the snapshot is the same object.
    await target.dispatch('noop');
    expect(target.revision()).toBe(1);
    // A change made outside ironbird counts too: the target watches the actor, not its own dispatches.
    actor.send({ type: 'busy.start' });
    expect(target.revision()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('fails DISPATCH_FAILED on a stopped actor', async () => {
    const actor = started();
    const target = fromActor(actor, { commands: counterCommands });
    actor.stop();
    const error = await failure(target.dispatch('count.add', { by: 1 }));
    expect(error.code).toBe('DISPATCH_FAILED');
    expect(error.message).toContain('the actor is stopped');
  });

  it('fails DISPATCH_FAILED with the error when an event makes the actor fail, without an uncaught exception', async () => {
    const actor = started();
    const target = fromActor(actor, { commands: counterCommands });
    const error = await failure(target.dispatch('boom'));
    expect(error.code).toBe('DISPATCH_FAILED');
    expect(error.message).toContain('the actor failed: boom');
    expect(target.revision()).toBe(1);
    expect((await failure(target.dispatch('count.add', { by: 1 }))).message).toContain('the actor is error');
    await pastXStateErrorTimer();
  });

  it('persists getPersistedSnapshot() and returns the live actor from actor()', async () => {
    const actor = started();
    const target = fromActor(actor, { commands: counterCommands, select: (snapshot) => snapshot.context.count });
    await target.dispatch('count.add', { by: 4 });
    expect(target.persist?.()).toEqual(actor.getPersistedSnapshot());
    expect(target.actor()).toBe(actor);
  });

  it('offers persist but not restore without the restore option', () => {
    const target = fromActor(started(), { commands: counterCommands });
    expect(target.capabilities).toEqual(['persist']);
    expect(target.restore).toBeUndefined();
  });
});
