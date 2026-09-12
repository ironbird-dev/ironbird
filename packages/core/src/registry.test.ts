import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isIronbirdError } from './errors';
import type { CommandRegistry } from './registry';
import { defineCommands, suggestNames } from './registry';

const commands = defineCommands({
  'cart.addItem': z.object({ sku: z.string(), qty: z.number().int().positive() }).describe('Add an item to the current cart'),
  'cart.clear': z.object({}).describe('Remove every item from the cart'),
  'payment.start': z.object({ method: z.enum(['card', 'saved']) }),
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('defineCommands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists names and answers has()', () => {
    expect(commands.names()).toEqual(['cart.addItem', 'cart.clear', 'payment.start']);
    expect(commands.has('cart.clear')).toBe(true);
    expect(commands.has('nope')).toBe(false);
  });

  it('parses a valid payload and returns the typed output', () => {
    const parsed = commands.parse('cart.addItem', { sku: 'cut-45', qty: 1 });
    expect(parsed).toEqual({ sku: 'cut-45', qty: 1 });
  });

  it('treats an omitted payload as {}', () => {
    expect(commands.parse('cart.clear', undefined)).toEqual({});
  });

  it('fails unknown names with UNKNOWN_COMMAND and up to three suggestions', () => {
    const error = catchError(() => commands.parse('cart.addItems' as 'cart.addItem', {}));
    expect(isIronbirdError(error) && error.code).toBe('UNKNOWN_COMMAND');
    expect(isIronbirdError(error) && error.details).toEqual({ name: 'cart.addItems', suggestions: ['cart.addItem', 'cart.clear', 'payment.start'] });
  });

  it('fails invalid payloads with INVALID_PAYLOAD and the issue path', () => {
    const error = catchError(() => commands.parse('cart.addItem', { sku: 'x', qty: 0 }));
    expect(isIronbirdError(error) && error.code).toBe('INVALID_PAYLOAD');
    const details = (error as { details: { name: string; issues: Array<{ path: unknown[]; message: string }> } }).details;
    expect(details.name).toBe('cart.addItem');
    expect(details.issues).toHaveLength(1);
    expect(details.issues[0]?.path).toEqual(['qty']);
  });

  it('describes every command as JSON Schema with its description', () => {
    const described = commands.describe();
    expect(described['cart.addItem']?.description).toBe('Add an item to the current cart');
    expect(described['payment.start']?.description).toBeUndefined();
    const payload = described['cart.addItem']?.payload as { type: string; properties: Record<string, { type: string }>; required: string[] };
    expect(payload.type).toBe('object');
    expect(payload.properties['qty']?.type).toBe('integer');
    expect(payload.required).toEqual(['sku', 'qty']);
    expect(described['cart.addItem']?.payload).not.toHaveProperty('$schema');
  });

  it('is assignable to the untyped registry shape used by targets and the daemon', () => {
    const widened: CommandRegistry = commands;
    expect(widened.names()).toEqual(['cart.addItem', 'cart.clear', 'payment.start']);
    expect(widened.parse('cart.clear', undefined)).toEqual({});
  });

  it('keeps literal precision while staying covariant', () => {
    const names: Array<'cart.addItem' | 'cart.clear' | 'payment.start'> = commands.names();
    const parsed: { sku: string; qty: number } = commands.parse('cart.addItem', { sku: 'x', qty: 1 });
    // @ts-expect-error unknown command names are rejected at compile time
    const rejected = () => commands.parse('cart.addItems', {});
    const widened: CommandRegistry = commands;
    expect(names).toHaveLength(3);
    expect(parsed.qty).toBe(1);
    expect(typeof rejected).toBe('function');
    expect(widened.has('cart.clear')).toBe(true);
  });

  it('warns once per command whose schema uses transforms or refinements', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withTransforms = defineCommands({
      'a.transform': z.object({ n: z.string().transform((s) => Number(s)) }),
      'b.refine': z.object({ n: z.number() }).refine((v) => v.n > 0),
      'c.plain': z.object({ n: z.number() }),
    });
    withTransforms.describe();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain('a.transform');
    expect(warn.mock.calls[1]?.[0]).toContain('b.refine');
  });
});

describe('suggestNames', () => {
  it('orders candidates by edit distance and caps the count', () => {
    const ranked = suggestNames('paymnt.start', ['cart.addItem', 'payment.start', 'payment.cancel', 'cart.clear']);
    expect(ranked[0]).toBe('payment.start');
    expect(ranked).toHaveLength(3);
    expect(ranked).not.toContain('cart.addItem');
    expect(suggestNames('x', ['a', 'b'], 1)).toEqual(['a']);
    expect(suggestNames('x', [])).toEqual([]);
  });
});
