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

/** The one JSON object `pnpm pack --json` prints, ignoring anything around it. */
export function packJson(stdout) {
  return JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
}

const SEMVER = /\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/g;

/**
 * A packed manifest moved to `version`: its own version, every internal dependency and dev
 * dependency (which pnpm pack pins exactly), and the version inside every internal peer range
 * (`>=0.0.3` becomes `>=0.1.0`), as `changeset version` would leave them. Fields that are absent stay absent.
 */
export function releaseManifest(manifest, version, internal) {
  const exact = (deps) => Object.fromEntries(Object.entries(deps).map(([name, range]) => [name, internal.includes(name) ? version : range]));
  const ranged = (deps) => Object.fromEntries(Object.entries(deps).map(([name, range]) => [name, internal.includes(name) ? String(range).replace(SEMVER, version) : range]));
  const next = { ...manifest, version };
  if (manifest.dependencies) next.dependencies = exact(manifest.dependencies);
  if (manifest.devDependencies) next.devDependencies = exact(manifest.devDependencies);
  if (manifest.optionalDependencies) next.optionalDependencies = exact(manifest.optionalDependencies);
  if (manifest.peerDependencies) next.peerDependencies = ranged(manifest.peerDependencies);
  return next;
}

/** Problems with an npm lockfile after the TASK.md install: each vendored package once, from vendor/, at `version`. */
export function installProblems(lock, version) {
  const problems = [];
  const packages = lock.packages ?? {};
  for (const { name } of VENDORED) {
    const entry = packages[`node_modules/${name}`];
    if (!entry) {
      problems.push(`${name} is not installed`);
      continue;
    }
    if (entry.version !== version) problems.push(`${name} is ${entry.version}, not ${version}`);
    const file = `vendor/${tarballName(name, version)}`;
    if (!String(entry.resolved ?? '').includes(file)) problems.push(`${name} was not installed from ${file} (resolved: ${entry.resolved})`);
  }
  for (const key of Object.keys(packages)) {
    if (/node_modules\/@ironbird\/[^/]+\/node_modules\/@ironbird\//.test(key)) problems.push(`a second copy of an ironbird package is installed at ${key}`);
  }
  return problems;
}
