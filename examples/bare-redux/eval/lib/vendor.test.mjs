import { describe, expect, it } from 'vitest';
import { installCommands, installProblems, packJson, releaseManifest, tarballName } from './vendor.mjs';

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

const INTERNAL = ['@ironbird/cli', '@ironbird/core', '@ironbird/react-native', '@ironbird/redux', '@ironbird/testing', '@ironbird/xstate', 'ironbird'];

describe('repacking at the release version', () => {
  it('reads the JSON pnpm pack prints, whatever comes before or after it', () => {
    expect(packJson('WARN something\n{\n  "name": "@ironbird/core",\n  "filename": "/t/ironbird-core-0.0.3.tgz",\n  "files": [{ "path": "LICENSE" }]\n}\n')).toEqual({ name: '@ironbird/core', filename: '/t/ironbird-core-0.0.3.tgz', files: [{ path: 'LICENSE' }] });
  });

  it('sets the version and every internal dependency to it, and moves internal peer ranges to it', () => {
    const cli = { name: '@ironbird/cli', version: '0.0.3', dependencies: { '@ironbird/core': '0.0.3', zod: '^4.2.0' }, devDependencies: { '@ironbird/react-native': '0.0.2' } };
    expect(releaseManifest(cli, '0.1.0', INTERNAL)).toEqual({ name: '@ironbird/cli', version: '0.1.0', dependencies: { '@ironbird/core': '0.1.0', zod: '^4.2.0' }, devDependencies: { '@ironbird/react-native': '0.1.0' } });
    const bridge = { name: '@ironbird/react-native', version: '0.0.2', peerDependencies: { '@ironbird/core': '>=0.0.3', 'react-native': '>=0.76' } };
    expect(releaseManifest(bridge, '0.1.0', INTERNAL).peerDependencies).toEqual({ '@ironbird/core': '>=0.1.0', 'react-native': '>=0.76' });
    expect(releaseManifest({ name: '@ironbird/redux', version: '0.0.0', peerDependencies: { '@ironbird/core': '^0.0.3', redux: '^5.0.0' } }, '0.1.0', INTERNAL).peerDependencies).toEqual({ '@ironbird/core': '^0.1.0', redux: '^5.0.0' });
  });
});

describe('installProblems', () => {
  const lock = (extra = {}) => ({
    packages: {
      '': { name: 'exercise' },
      'node_modules/@ironbird/core': { version: '0.1.0', resolved: 'file:vendor/ironbird-core-0.1.0.tgz' },
      'node_modules/@ironbird/react-native': { version: '0.1.0', resolved: 'file:vendor/ironbird-react-native-0.1.0.tgz' },
      'node_modules/@ironbird/redux': { version: '0.1.0', resolved: 'file:vendor/ironbird-redux-0.1.0.tgz' },
      'node_modules/@ironbird/cli': { version: '0.1.0', resolved: 'file:vendor/ironbird-cli-0.1.0.tgz', dev: true },
      ...extra,
    },
  });

  it('passes when each vendored package is installed once, from vendor/, at the release version', () => {
    expect(installProblems(lock(), '0.1.0')).toEqual([]);
  });

  it('names a registry copy, a wrong version, a missing package, and a second nested copy', () => {
    const bad = lock({
      'node_modules/@ironbird/core': { version: '0.0.3', resolved: 'https://registry.npmjs.org/@ironbird/core/-/core-0.0.3.tgz' },
      'node_modules/@ironbird/cli/node_modules/@ironbird/core': { version: '0.0.3' },
    });
    delete bad.packages['node_modules/@ironbird/redux'];
    expect(installProblems(bad, '0.1.0')).toEqual([
      '@ironbird/core is 0.0.3, not 0.1.0',
      '@ironbird/core was not installed from vendor/ironbird-core-0.1.0.tgz (resolved: https://registry.npmjs.org/@ironbird/core/-/core-0.0.3.tgz)',
      '@ironbird/redux is not installed',
      'a second copy of an ironbird package is installed at node_modules/@ironbird/cli/node_modules/@ironbird/core',
    ]);
  });
});
