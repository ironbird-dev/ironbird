import { createTarget, type CommandOf, type CommandRegistry, type Target } from '@ironbird/core';
import type { Action, Store, UnknownAction } from 'redux';
import { RESTORE_ACTION_TYPE, isRestoreAction } from './restore';

export interface FromStoreOptions<R extends CommandRegistry, S, A extends Action = UnknownAction> {
  commands: R;
  /** Maps a validated command to an action. Default: `{ type: name, payload }`, the shape Redux Toolkit's action creators produce. */
  toAction?: (command: CommandOf<R>) => A;
  /** Shapes the state that `getState`, `waitFor`, and `watch` see. Default: the whole state. `persist` ignores it. */
  select?: (state: S) => unknown;
}

/**
 * A core `Target` over a Redux store (M5 design D1). Commands are validated by the registry before
 * `toAction` sees them. `persist` saves the root state, never the projection.
 */
export function fromStore<R extends CommandRegistry, S, A extends Action = UnknownAction>(store: Store<S, A>, options: FromStoreOptions<R, S, A>): Target {
  const toAction = options.toAction ?? ((command: CommandOf<R>): A => ({ type: command.name, payload: command.payload }) as unknown as A);
  const select = options.select ?? ((state: S): unknown => state);
  return createTarget({
    commands: options.commands,
    dispatch(command) {
      const action = toAction(command);
      // Only a schema-checked snapshot may replace the state; a command never bypasses the schema.
      if (isRestoreAction(action)) throw new Error(`${command.name} maps to ${RESTORE_ACTION_TYPE}, which only snapshotLoad may dispatch`);
      store.dispatch(action);
    },
    getState: () => select(store.getState()),
    // Redux notifies after every dispatch, even one no reducer handled. Comparing the root state by
    // reference moves the target's revision only when the state changed.
    subscribe(listener) {
      let last = store.getState();
      return store.subscribe(() => {
        const next = store.getState();
        if (next === last) return;
        last = next;
        listener();
      });
    },
    persist: () => store.getState(),
  });
}
