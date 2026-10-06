import { describe, expect, it } from 'vitest';
import { RESTORE_ACTION_TYPE, isRestoreAction, withIronbirdRestore } from './restore';

type CountState = { count: number };
const counter = (state: CountState = { count: 0 }, action: { type: string }): CountState => (action.type === 'inc' ? { count: state.count + 1 } : state);

describe('withIronbirdRestore', () => {
  it('passes every other action to the wrapped reducer', () => {
    const reducer = withIronbirdRestore(counter);
    const start = reducer(undefined, { type: '@@INIT' });
    expect(start).toEqual({ count: 0 });
    expect(reducer(start, { type: 'inc' })).toEqual({ count: 1 });
    expect(reducer(start, { type: 'other' })).toBe(start);
  });

  it('returns the restore action payload itself as the new state', () => {
    const reducer = withIronbirdRestore(counter);
    const restored = { count: 7 };
    expect(reducer({ count: 1 }, { type: RESTORE_ACTION_TYPE, payload: restored } as never)).toBe(restored);
  });

  it('recognizes only its own action type', () => {
    expect(isRestoreAction({ type: RESTORE_ACTION_TYPE, payload: 1 })).toBe(true);
    expect(isRestoreAction({ type: 'restore' })).toBe(false);
    expect(isRestoreAction(null)).toBe(false);
    expect(isRestoreAction('x')).toBe(false);
  });
});
