// The ironbird packages the exercise installs from its vendor/ folder (M5 design D11). The proxy and
// the human trial get them repacked at RELEASE_VERSION, the version users will install, so `doctor`'s
// version check and the CLI's exact internal pins agree.

export const RELEASE_VERSION = '0.1.0';

/** Packed from packages/<dir>, in install order; `dev` packages are installed with --save-dev. */
export const VENDORED = [
  { name: '@ironbird/core', dir: 'core', dev: false },
  { name: '@ironbird/react-native', dir: 'react-native', dev: false },
  { name: '@ironbird/redux', dir: 'redux', dev: false },
  { name: '@ironbird/cli', dir: 'cli', dev: true },
];

export const INSTALL_FLAGS = ['--no-audit', '--no-fund'];

/** The file name `pnpm pack` gives a package: `@ironbird/core` at 0.1.0 is `ironbird-core-0.1.0.tgz`. */
export function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** The two install commands TASK.md gives, exactly; prepare.mjs runs them in its template check. */
export function installCommands(version) {
  const files = (dev) => VENDORED.filter((entry) => entry.dev === dev).map((entry) => `./vendor/${tarballName(entry.name, version)}`);
  return [`npm install ${files(false).join(' ')}`, `npm install --save-dev ${files(true).join(' ')}`];
}
