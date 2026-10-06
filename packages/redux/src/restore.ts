import type { Action, Reducer } from 'redux';

/** The one action `withIronbirdRestore` answers. Only `fromStore`'s `restore` dispatches it. */
export const RESTORE_ACTION_TYPE = '@@ironbird/restore';

export interface RestoreAction extends Action<typeof RESTORE_ACTION_TYPE> {
  payload: unknown;
}

export function isRestoreAction(action: unknown): action is RestoreAction {
  return typeof action === 'object' && action !== null && (action as { type?: unknown }).type === RESTORE_ACTION_TYPE;
}

/**
 * Wraps the app's root reducer so `fromStore`'s `restore` can replace the whole state (M5 design
 * D1). The restore action carries a value `fromStore` already parsed with the app's schema, so the
 * reducer never receives an unvalidated snapshot (AGENTS.md rule 4). Every other action goes to
 * `reducer` unchanged.
 */
export function withIronbirdRestore<S, A extends Action, P = S>(reducer: Reducer<S, A, P>): Reducer<S, A, P> {
  return (state, action) => (isRestoreAction(action) ? (action.payload as S) : reducer(state, action));
}
