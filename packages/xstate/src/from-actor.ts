import { IronbirdError, createTarget, messageOf, type CommandOf, type CommandRegistry, type Target } from '@ironbird/core';
import { createActor, type Actor, type ActorOptions, type AnyActorLogic, type AnyStateMachine, type EventFromLogic, type SnapshotFrom, type Subscription } from 'xstate';
import type { z } from 'zod';
import { invalidSnapshot } from './errors';

export interface FromActorOptions<R extends CommandRegistry, TLogic extends AnyStateMachine> {
  commands: R;
  /** Maps a validated command to an event. Default: the payload's keys plus `type: name`; a payload that isn't an object becomes `{ type: name, payload }`. */
  toEvent?: (command: CommandOf<R>) => EventFromLogic<TLogic>;
  /** Shapes the state that `getState`, `waitFor`, and `watch` see. Default: `{ value, context }`. `persist` ignores it. */
  select?: (snapshot: SnapshotFrom<TLogic>) => unknown;
  /**
   * Enables `restore` (M5 design §3). `snapshotSchema` validates a persisted snapshot before any
   * actor sees it; `actorOptions` (a clock, an inspector, an id) are passed to the replacement actor.
   */
  restore?: {
    snapshotSchema: z.ZodType;
    actorOptions?: Omit<ActorOptions<TLogic>, 'snapshot' | 'state'>;
  };
}

/** A core `Target` plus the live actor, which a restore replaces. */
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
 * subscription to the live actor and hands `createTarget` its own listener set, so a restore can
 * swap actors without leaving the target on a stopped one.
 */
export function fromActor<R extends CommandRegistry, TLogic extends AnyStateMachine>(actor: Actor<TLogic>, options: FromActorOptions<R, TLogic>): ActorTarget<TLogic> {
  let current = actor;
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
  // subscribed to and ignores the notification unless that actor is the current one. During a
  // restore the replacement is observed before the swap; anything it does in that window is folded
  // into the restore's single notification instead of notifying early.
  const observe = (source: Actor<TLogic>): Subscription => {
    const changed = (): void => {
      if (source !== current) return;
      const next = source.getSnapshot();
      if (next === last) return;
      last = next;
      notify();
    };
    return source.subscribe({ next: changed, error: changed, complete: changed });
  };
  let subscription = observe(current);

  const toEvent = options.toEvent ?? ((command: CommandOf<R>) => defaultEvent(command) as EventFromLogic<TLogic>);
  const select = options.select ?? defaultSelect;
  const restoreOptions = options.restore;

  const restore = (snapshot: unknown): void => {
    if (!restoreOptions) return;
    const parsed = restoreOptions.snapshotSchema.safeParse(snapshot);
    if (!parsed.success) throw invalidSnapshot(parsed.error.issues);
    const replacement = startReplacement(current.logic, { ...restoreOptions.actorOptions, snapshot: parsed.data } as ActorOptions<TLogic>);
    // Only now is the live actor touched, in spec §3 step 3's order. The old subscription goes first,
    // so stopping the old actor notifies nothing (its `complete` no longer reaches `changed`). While
    // it stops, `actor()` still returns it: an app observer that sends through `actor()` from the old
    // actor's `complete` reaches a stopped actor, which XState drops. Then `current` moves, and the
    // listener set hears about it exactly once.
    subscription.unsubscribe();
    subscription = observe(replacement);
    current.stop();
    current = replacement;
    last = replacement.getSnapshot();
    notify();
  };

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
    ...(restoreOptions ? { restore } : {}),
  });
  return Object.assign(target, { actor: () => current });
}

/**
 * Builds and starts the actor that will replace the live one (M5 design §3 step 2). Throws
 * `INVALID_SNAPSHOT` and leaves nothing running when construction or `start()` throws or the
 * started actor's status is `error`.
 */
function startReplacement<TLogic extends AnyStateMachine>(logic: TLogic, options: ActorOptions<TLogic>): Actor<TLogic> {
  let replacement: Actor<TLogic> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    replacement = createActor(logic as AnyActorLogic, options as ActorOptions<AnyActorLogic>) as unknown as Actor<TLogic>;
    // Subscribed before start(), so a failed start reaches this observer rather than XState's
    // unhandled-error timer.
    const probe = replacement.subscribe({
      error: (error: unknown) => {
        failure = { error };
      },
    });
    replacement.start();
    probe.unsubscribe();
    const started = replacement.getSnapshot() as { status: string; error?: unknown };
    if (started.status === 'error') failure ??= { error: started.error };
  } catch (error) {
    failure = { error };
  }
  if (failure !== undefined || replacement === undefined) {
    replacement?.stop();
    const reason = `actor failed to start: ${messageOf(failure?.error)}`;
    throw new IronbirdError('INVALID_SNAPSHOT', `Invalid snapshot: ${reason}`, { path: '', reason });
  }
  return replacement;
}
