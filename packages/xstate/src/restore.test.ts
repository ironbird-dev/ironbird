import { createManualClock, defineCommands, isIronbirdError, type IronbirdError } from '@ironbird/core';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { fromActor } from './from-actor';
import { counterCommands, counterMachine, counterSnapshotSchema, type Lifecycle } from '../test/counter-machine';

async function failure(promise: Promise<unknown>): Promise<IronbirdError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return error;
}

const pastXStateErrorTimer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

/** A started actor, its target, and a snapshot saved at count 2, as the wire carries it (JSON). */
async function restorable(lifecycle?: Lifecycle) {
  const original = createActor(counterMachine(lifecycle)).start();
  const target = fromActor(original, { commands: counterCommands, restore: { snapshotSchema: counterSnapshotSchema } });
  await target.dispatch('count.add', { by: 2 });
  const saved = JSON.parse(JSON.stringify(target.persist?.())) as Record<string, unknown>;
  await target.dispatch('count.add', { by: 5 });
  return { original, target, saved };
}

describe('fromActor restore', () => {
  it('is offered only with the restore option', () => {
    const target = fromActor(createActor(counterMachine()).start(), { commands: counterCommands, restore: { snapshotSchema: counterSnapshotSchema } });
    expect(target.capabilities).toEqual(['persist', 'restore']);
    expect(typeof target.restore).toBe('function');
  });

  it('replaces the actor with one started from the snapshot, stops the old one, and notifies once', async () => {
    const { original, target, saved } = await restorable();
    const listener = vi.fn();
    target.subscribe(listener);
    const rev = target.revision();
    await target.restore?.(saved);
    expect(target.actor()).not.toBe(original);
    expect(original.getSnapshot().status).toBe('stopped');
    expect(target.actor().getSnapshot().status).toBe('active');
    expect(target.getState()).toEqual({ value: 'idle', context: { count: 2, note: '' } });
    expect(target.revision()).toBe(rev + 1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispatches to, reads, persists, and watches the replacement afterwards', async () => {
    const { original, target, saved } = await restorable();
    await target.restore?.(saved);
    const listener = vi.fn();
    target.subscribe(listener);
    const rev = target.revision();
    await target.dispatch('count.add', { by: 1 });
    expect(target.actor().getSnapshot().context.count).toBe(3);
    expect(target.getState()).toEqual({ value: 'idle', context: { count: 3, note: '' } });
    expect(target.persist?.()).toEqual(target.actor().getPersistedSnapshot());
    expect(target.revision()).toBe(rev + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    // A change on the replacement made outside ironbird notifies too; the stopped original is ignored.
    target.actor().send({ type: 'busy.start' });
    original.send({ type: 'count.add', by: 100 });
    expect(target.revision()).toBe(rev + 2);
    expect(target.getState()).toEqual({ value: 'busy', context: { count: 3, note: '' } });
  });

  it('fails INVALID_SNAPSHOT at the first bad path and keeps the old actor live and subscribed', async () => {
    const { original, target, saved } = await restorable();
    const rev = target.revision();
    const error = await failure(target.restore!({ ...saved, context: { count: -1, note: '' } }));
    expect(error.code).toBe('INVALID_SNAPSHOT');
    expect(error.details).toMatchObject({ path: 'context.count' });
    expect(target.actor()).toBe(original);
    expect(target.revision()).toBe(rev);
    await target.dispatch('count.add', { by: 1 });
    expect(original.getSnapshot().context.count).toBe(8);
    expect(target.revision()).toBe(rev + 1);
  });

  it('fails INVALID_SNAPSHOT when a snapshot that passes the schema fails to start, and keeps the old actor', async () => {
    const { original, target, saved } = await restorable();
    const rev = target.revision();
    const error = await failure(target.restore!({ ...saved, value: 'nowhere' }));
    expect(error.code).toBe('INVALID_SNAPSHOT');
    expect(error.details).toEqual({ path: '', reason: "actor failed to start: State 'nowhere' does not exist on 'counter'" });
    expect(target.actor()).toBe(original);
    expect(original.getSnapshot().status).toBe('active');
    expect(target.revision()).toBe(rev);
    await target.dispatch('count.add', { by: 1 });
    expect(target.getState()).toEqual({ value: 'idle', context: { count: 8, note: '' } });
    expect(target.revision()).toBe(rev + 1);
    // The failed replacement's error went to the adapter's observer, not XState's unhandled-error timer.
    await pastXStateErrorTimer();
  });

  it('fails INVALID_SNAPSHOT, keeping the old actor, when the schema strips the children XState needs', async () => {
    // z.object drops keys it doesn't declare, so this schema passes a snapshot without `children`,
    // which XState can't restore. api.md tells apps to use z.looseObject for that reason.
    const original = createActor(counterMachine()).start();
    const stripping = z.object({ status: z.literal('active'), value: z.string(), context: z.object({ count: z.number(), note: z.string() }) });
    const target = fromActor(original, { commands: counterCommands, restore: { snapshotSchema: stripping } });
    const error = await failure(target.restore!(JSON.parse(JSON.stringify(target.persist?.()))));
    expect(error.code).toBe('INVALID_SNAPSHOT');
    expect(error.details).toMatchObject({ path: '' });
    expect((error.details as { reason: string }).reason).toMatch(/^actor failed to start: /);
    expect(target.actor()).toBe(original);
    expect(original.getSnapshot().status).toBe('active');
    await pastXStateErrorTimer();
  });

  it('restarts the invoked actors of the restored state and stops the old ones', async () => {
    // XState persistence restarts invoked and spawned children; entry actions don't re-run. Effects
    // that start with the child (here, the ticker's start) run once more than in the original
    // timeline. api.md documents this.
    const lifecycle: Lifecycle = { started: 0, stopped: 0 };
    const original = createActor(counterMachine(lifecycle)).start();
    const target = fromActor(original, { commands: counterCommands, restore: { snapshotSchema: counterSnapshotSchema } });
    await target.dispatch('busy.start');
    expect(lifecycle).toEqual({ started: 1, stopped: 0 });
    const saved = JSON.parse(JSON.stringify(target.persist?.())) as unknown;
    await target.restore?.(saved);
    expect(lifecycle).toEqual({ started: 2, stopped: 1 });
    expect(Object.keys(target.actor().getSnapshot().children)).toEqual(['ticker']);
  });

  it('passes actorOptions to the replacement', async () => {
    const original = createActor(counterMachine()).start();
    const target = fromActor(original, { commands: counterCommands, restore: { snapshotSchema: counterSnapshotSchema, actorOptions: { id: 'restored' } } });
    await target.restore?.(JSON.parse(JSON.stringify(target.persist?.())));
    expect(target.actor().id).toBe('restored');
  });

  it('stops the old actor before swapping, so a send through actor() during its completion reaches the stopped old actor', async () => {
    // Spec §3 step 3's order: move the subscription, stop the old actor, swap `current`, notify once.
    // An app observer that reacts to the old actor completing and sends through `actor()` still gets
    // the old, now stopped, actor. XState drops that event (its development build warns, which is
    // silenced here), so it never reaches the replacement, and the revision moves by exactly one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { original, target, saved } = await restorable();
    const listener = vi.fn();
    target.subscribe(listener);
    const rev = target.revision();
    let seen: AnyActorRef | undefined;
    original.subscribe({
      complete: () => {
        seen = target.actor();
        target.actor().send({ type: 'count.add', by: 100 });
      },
    });
    await target.restore?.(saved);
    expect(seen).toBe(original);
    expect(target.actor()).not.toBe(original);
    expect(original.getSnapshot().status).toBe('stopped');
    expect(original.getSnapshot().context.count).toBe(7);
    expect(target.getState()).toEqual({ value: 'idle', context: { count: 2, note: '' } });
    expect(target.revision()).toBe(rev + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('fromActor restore and delayed transitions', () => {
  it('does not reschedule a delayed transition that was pending when the snapshot was saved', async () => {
    // XState's persisted snapshot holds no scheduled events and entry actions don't re-run, so a
    // restored state waiting on `after` never fires it. api.md documents this; the test records it.
    const clock = createManualClock();
    const machine = createMachine({ initial: 'idle', states: { idle: { on: { go: 'waiting' } }, waiting: { after: { 100: 'done' } }, done: {} } });
    const original = createActor(machine, { clock }).start();
    const target = fromActor(original, { commands: defineCommands({ go: z.object({}) }), restore: { snapshotSchema: z.looseObject({}), actorOptions: { clock } } });
    await target.dispatch('go');
    expect(clock.timers()).toHaveLength(1);
    await target.restore?.(JSON.parse(JSON.stringify(target.persist?.())));
    // Stopping the old actor cancelled its timer; the replacement scheduled none.
    expect(clock.timers()).toHaveLength(0);
    await clock.advance(200);
    expect(target.getState()).toMatchObject({ value: 'waiting' });
  });
});
