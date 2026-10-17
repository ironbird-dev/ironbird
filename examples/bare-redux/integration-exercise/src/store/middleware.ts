import type { Middleware } from '@reduxjs/toolkit';
import type { SyncAck, SyncPort } from '../sync/port';
import { added, renamed, saveAcked, saveFailed, saveStarted, toggled, type AppState, type Todo } from './todos';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface SyncMiddlewareOptions {
  /**
   * A number that changes whenever the whole state is replaced. A save remembers the number it
   * started under, and its acknowledgement or failure is dropped if the number has since changed:
   * it describes a to-do the replaced state may not have, or a different to-do with the same id.
   */
  generation?: () => number;
}

/**
 * Saves every to-do the user changes, at its new revision, and reports each acknowledgement or
 * failure back to the store. An edit to an id that doesn't exist throws before the reducer runs,
 * so whoever dispatched it hears about it instead of the edit vanishing.
 */
export function createSyncMiddleware(sync: SyncPort, options: SyncMiddlewareOptions = {}): Middleware<object, AppState> {
  const generation = options.generation ?? ((): number => 0);
  return (api) => (next) => (action) => {
    if ((toggled.match(action) || renamed.match(action)) && !api.getState().todos.items.some((item) => item.id === action.payload.id)) {
      throw new Error(`No to-do with id ${action.payload.id}`);
    }
    const result = next(action);

    let changed: Todo | undefined;
    if (added.match(action)) changed = api.getState().todos.items.at(-1);
    else if (toggled.match(action) || renamed.match(action)) changed = api.getState().todos.items.find((item) => item.id === action.payload.id);
    if (changed) {
      const { id, title, done, rev } = changed;
      const startedIn = generation();
      api.dispatch(saveStarted({ id, rev }));
      // The executor runs save now, and turns a throw before it returns a promise into a rejection,
      // so every save started ends in saveAcked or saveFailed and inFlight can't stick.
      void new Promise<SyncAck>((resolve) => resolve(sync.save({ id, title, done, rev }))).then(
        (ack) => {
          if (generation() === startedIn) api.dispatch(saveAcked(ack));
        },
        (error: unknown) => {
          if (generation() === startedIn) api.dispatch(saveFailed({ id, rev, reason: messageOf(error) }));
        },
      );
    }
    return result;
  };
}
