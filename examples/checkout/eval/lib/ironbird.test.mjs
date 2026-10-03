import { describe, expect, it } from 'vitest';
import { metroEnv } from './ironbird.mjs';

describe('metroEnv', () => {
  it("turns Expo's TypeScript setup off so Metro leaves the copy's tsconfig.json alone", () => {
    const base = { PATH: '/usr/bin', IRONBIRD_SIM_UDID: 'abc' };
    expect(metroEnv(base)).toEqual({ PATH: '/usr/bin', IRONBIRD_SIM_UDID: 'abc', EXPO_NO_TYPESCRIPT_SETUP: '1' });
    expect(base).not.toHaveProperty('EXPO_NO_TYPESCRIPT_SETUP');
  });
});
