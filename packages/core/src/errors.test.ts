import { describe, expect, it } from 'vitest';
import { ERROR_CODES, IronbirdError, PROTOCOL_VERSION, isIronbirdError, toErrorShape } from './errors';

describe('IronbirdError', () => {
  it('carries a code, message, and details', () => {
    const error = new IronbirdError('UNKNOWN_COMMAND', 'Unknown command cart.add', { name: 'cart.add', suggestions: ['cart.addItem'] });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('IronbirdError');
    expect(error.code).toBe('UNKNOWN_COMMAND');
    expect(error.message).toBe('Unknown command cart.add');
    expect(error.details).toEqual({ name: 'cart.add', suggestions: ['cart.addItem'] });
  });

  it('serializes to the protocol error shape and omits absent details', () => {
    expect(new IronbirdError('UNAUTHORIZED', 'Token missing').toJSON()).toEqual({ code: 'UNAUTHORIZED', message: 'Token missing' });
    expect(new IronbirdError('INTERNAL', 'boom', { message: 'boom' }).toJSON()).toEqual({ code: 'INTERNAL', message: 'boom', details: { message: 'boom' } });
  });

  it('is recognized by duck typing so another copy of core interoperates', () => {
    const foreign = { name: 'IronbirdError', code: 'WAIT_TIMEOUT', message: 'x', details: undefined };
    expect(isIronbirdError(foreign)).toBe(true);
    expect(isIronbirdError(new Error('plain'))).toBe(false);
    expect(isIronbirdError(null)).toBe(false);
  });

  it('wraps unknown errors as INTERNAL', () => {
    expect(toErrorShape(new Error('disk on fire'))).toEqual({ code: 'INTERNAL', message: 'disk on fire', details: { message: 'disk on fire' } });
    expect(toErrorShape('a string')).toEqual({ code: 'INTERNAL', message: 'a string', details: { message: 'a string' } });
    expect(toErrorShape(new IronbirdError('NO_TARGET', 'none', { available: [] }))).toEqual({ code: 'NO_TARGET', message: 'none', details: { available: [] } });
  });

  it('lists every documented code once', () => {
    expect(new Set(ERROR_CODES).size).toBe(18);
    expect(ERROR_CODES).toContain('APP_MISMATCH');
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
