import { describe, expect, it } from 'vitest';
import { installCommands, tarballName } from './vendor.mjs';

describe('vendored tarballs', () => {
  it('names tarballs as pnpm pack does', () => {
    expect(tarballName('@ironbird/react-native', '0.1.0')).toBe('ironbird-react-native-0.1.0.tgz');
    expect(tarballName('ironbird', '0.1.0')).toBe('ironbird-0.1.0.tgz');
  });

  it('installs core, the bridge, and the Redux adapter as dependencies and the CLI as a dev dependency', () => {
    expect(installCommands('0.1.0')).toEqual([
      'npm install ./vendor/ironbird-core-0.1.0.tgz ./vendor/ironbird-react-native-0.1.0.tgz ./vendor/ironbird-redux-0.1.0.tgz',
      'npm install --save-dev ./vendor/ironbird-cli-0.1.0.tgz',
    ]);
  });
});
