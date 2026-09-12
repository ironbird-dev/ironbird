import { describe, expect, it } from 'vitest';
import { getAtPath, parsePath } from './paths';

describe('paths', () => {
  const state = { cart: { items: [{ sku: 'cut-45', qty: 1 }] }, payment: { status: 'idle' } };

  it('parses dot paths and treats the empty path as the whole value', () => {
    expect(parsePath('')).toEqual([]);
    expect(parsePath('cart.items.0.sku')).toEqual(['cart', 'items', '0', 'sku']);
    expect(getAtPath(state, '')).toBe(state);
  });

  it('walks objects and arrays with numeric segments', () => {
    expect(getAtPath(state, 'cart.items.0.sku')).toBe('cut-45');
    expect(getAtPath(state, 'payment.status')).toBe('idle');
  });

  it('returns undefined for missing segments and non-objects', () => {
    expect(getAtPath(state, 'cart.items.3.sku')).toBeUndefined();
    expect(getAtPath(state, 'payment.status.length.x')).toBeUndefined();
    expect(getAtPath(null, 'a')).toBeUndefined();
  });
});
