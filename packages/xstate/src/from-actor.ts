import { createTarget, messageOf, type CommandOf, type CommandRegistry, type Target } from '@ironbird/core';
import type { Actor, AnyStateMachine, EventFromLogic, SnapshotFrom } from 'xstate';

export interface FromActorOptions<R extends CommandRegistry, TLogic extends AnyStateMachine> {
  commands: R;
  /** Maps a validated command to an event. Default: the payload's keys plus `type: name`; a payload that isn't an object becomes `{ type: name, payload }`. */
  toEvent?: (command: CommandOf<R>) => EventFromLogic<TLogic>;
  /** Shapes the state that `getState`, `waitFor`, and `watch` see. Default: `{ value, context }`. `persist` ignores it. */
  select?: (snapshot: SnapshotFrom<TLogic>) => unknown;
}

/** A core `Target` plus the live actor. */
export type ActorTarget<TLogic extends AnyStateMachine> = Target & {
  /** The live actor. A restore stops the old one, so read this again whenever the target notifies. */
  actor(): Actor<TLogic>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Spread first, `type` last: a payload key named `type` can't turn one command into another event. */
const defaultEvent = (command: { name: string; payload: unknown }): { type: string } & Record<string, unknown> =>
  isRecord(command.payload) ? { ...command.payload, type: command.name } : { type: command.name, payload: command.payload };

const defaultSelect = (snapshot: unknown): unknown => {
  const { value, context } = snapshot as { value: unknown; context: unknown };
  return { value, context };
};

/**
 * A core `Target` over a started XState v5 root actor (M5 design D2). The adapter owns its one
 * subscription to the actor and hands `createTarget` its own listener set.
 */
export function fromActor<R extends CommandRegistry, TLogic extends AnyStateMachine>(actor: Actor<TLogic>, options: FromActorOptions<R, TLogic>): ActorTarget<TLogic> {
  const current = actor;
  let last: unknown = current.getSnapshot();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  // XState notifies observers for every event it processes, even one that changed nothing, and
  // keeps the snapshot object when nothing changed, so comparing references keeps the revision
  // honest. The error callback matters: XState rethrows an actor's error from a timer whenever any
  // observer lacks one, so a next-only observer here would turn every actor error into an uncaught
  // exception, even in an app that handles it. The target treats the error as a state change, and
  // the next dispatch fails with it. `stop()` emits `complete` without `next` while the status
  // becomes 'stopped', so `complete` runs the same check. Each observer reads the actor it is
  // subscribed to and ignores the notification once that actor is no longer the current one.
  const observe = (source: Actor<TLogic>): void => {
    const changed = (): void => {
      if (source !== current) return;
      const next = source.getSnapshot();
      if (next === last) return;
      last = next;
      notify();
    };
    source.subscribe({ next: changed, error: changed, complete: changed });
  };
  observe(current);

  const toEvent = options.toEvent ?? ((command: CommandOf<R>) => defaultEvent(command) as EventFromLogic<TLogic>);
  const select = options.select ?? defaultSelect;

  const target = createTarget({
    commands: options.commands,
    dispatch(command) {
      const { status } = current.getSnapshot() as { status: string };
      if (status !== 'active') throw new Error(`the actor is ${status}`);
      current.send(toEvent(command));
      const after = current.getSnapshot() as { status: string; error?: unknown };
      if (after.status === 'error') throw new Error(`the actor failed: ${messageOf(after.error)}`);
    },
    getState: () => select(current.getSnapshot()),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    persist: () => current.getPersistedSnapshot(),
  });
  return Object.assign(target, { actor: () => current });
}
