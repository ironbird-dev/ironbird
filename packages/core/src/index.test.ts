import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './index';

describe('@ironbird/core', () => {
  it('exports the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
