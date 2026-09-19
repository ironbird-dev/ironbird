import { describe, expect, it } from 'vitest';
import { parseInbound } from './messages';

describe('parseInbound', () => {
  it('accepts the four daemon frames', () => {
    expect(parseInbound(JSON.stringify({ type: 'welcome', protocol: 1, targetId: 'ios' }))).toEqual({ type: 'welcome', protocol: 1, targetId: 'ios' });
    expect(parseInbound(JSON.stringify({ type: 'reject', code: 'APP_MISMATCH', message: 'nope' }))).toEqual({ type: 'reject', code: 'APP_MISMATCH', message: 'nope' });
    expect(parseInbound(JSON.stringify({ type: 'request', id: 'r-1', op: 'getState', params: { path: 'cart' } }))).toEqual({ type: 'request', id: 'r-1', op: 'getState', params: { path: 'cart' } });
    expect(parseInbound(JSON.stringify({ type: 'ping', t: 5 }))).toEqual({ type: 'ping', t: 5 });
  });

  it('defaults missing request params to an empty object', () => {
    expect(parseInbound(JSON.stringify({ type: 'request', id: 'r-2', op: 'describe' }))).toEqual({ type: 'request', id: 'r-2', op: 'describe', params: {} });
    expect(parseInbound(JSON.stringify({ type: 'request', id: 'r-3', op: 'describe', params: [1] }))).toEqual({ type: 'request', id: 'r-3', op: 'describe', params: {} });
  });

  it('drops anything malformed', () => {
    for (const raw of [
      undefined,
      42,
      '{not json',
      '[]',
      'null',
      JSON.stringify({ type: 'welcome', protocol: '1', targetId: 'ios' }),
      JSON.stringify({ type: 'reject', code: 'NOT_A_CODE', message: 'x' }),
      JSON.stringify({ type: 'request', id: 7, op: 'getState' }),
      JSON.stringify({ type: 'request', id: 'r', op: 9 }),
      JSON.stringify({ type: 'ping', t: 'now' }),
      JSON.stringify({ type: 'surprise' }),
    ]) {
      expect(parseInbound(raw)).toBeUndefined();
    }
  });
});
