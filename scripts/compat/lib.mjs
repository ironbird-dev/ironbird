// Pure helpers for the compat job's legs (M5 design D8 and §8). bare-leg.mjs and expo-leg.mjs do the I/O.

const EXACT = /^\d+\.\d+\.\d+$/;

/** `--react-native 0.87.1 --cli 20.2.0` → `{ reactNative, cli }`. Both pins are exact versions. */
export function parseLegArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--react-native' && flag !== '--cli') throw new Error(`Unknown option ${flag}; expected --react-native <x.y.z> --cli <x.y.z>`);
    if (value === undefined || !EXACT.test(value)) throw new Error(`${flag} needs an exact x.y.z version, got ${value ?? 'nothing'}`);
    options[flag === '--cli' ? 'cli' : 'reactNative'] = value;
  }
  if (!options.reactNative || !options.cli) throw new Error('Both --react-native and --cli are required');
  return options;
}

/** Throws unless `actual` is `wanted` or lies under it: '0.87.1' is exact, '0.86' a minor, '57' a major. */
export function assertVersion(name, actual, wanted) {
  if (actual === wanted || actual.startsWith(`${wanted}.`)) return;
  throw new Error(`${name} resolved to ${actual}, but this leg needs ${wanted}`);
}

/**
 * Time limits for the fetch steps, in milliseconds. A stalled registry fetch is killed at its limit
 * and retried once, so it can't use up the job (spec §12). Task 5 Step 6 measures cold runs and
 * raises a limit that leaves less than three times the measured time.
 */
export const STEP_TIMEOUT_MS = { init: 10 * 60_000, install: 5 * 60_000 };

const FETCH_FAILURE = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|E429|E500|E502|E503|E504)\b|socket hang up|network timeout/i;

/** A registry or network failure, worth one retry (spec §12). A 404, a peer conflict, or a compile error is not. */
export const isFetchFailure = (output) => FETCH_FAILURE.test(output);

/**
 * Why a fetch step's attempt failed: null when it didn't, `fetch-timeout` when it was killed at its
 * time limit, `fetch` for a registry or network error in its output, `other` for anything else. Only
 * fetch steps (template init, npm install) are run with a limit and a retry, so a timeout there is a
 * stalled fetch.
 */
export function classifyFailure(result) {
  if (result.status === 0) return null;
  if (result.timedOut) return 'fetch-timeout';
  return isFetchFailure(result.output) ? 'fetch' : 'other';
}

/**
 * Runs `attempt(1)` and, only when it failed with a fetch failure or a fetch timeout, `attempt(2)`.
 * `attempt` returns `{ status, timedOut?, output }`; the last result is returned for the caller to judge.
 */
export function retryOnFetchFailure(attempt) {
  const first = attempt(1);
  const kind = classifyFailure(first);
  if (kind === null || kind === 'other') return first;
  return attempt(2);
}

/** The minimal wiring a user adds to a bare app (§8 step 4): a target over a counter, and the bridge. */
export const WIRING_FILE = 'ironbird-wiring.ts';
export const WIRING_SOURCE = [
  "import { createTarget, defineCommands } from '@ironbird/core';",
  "import { startBridge, type BridgeHandle } from '@ironbird/react-native';",
  "import { Platform } from 'react-native';",
  "import { z } from 'zod';",
  '',
  'const commands = defineCommands({',
  "  'counter.add': z.object({ by: z.number().int() }).describe('Add to the counter'),",
  '});',
  '',
  'let count = 0;',
  'const listeners = new Set<() => void>();',
  '',
  'export const target = createTarget({',
  '  commands,',
  '  dispatch: ({ payload }) => {',
  '    count += payload.by;',
  '    for (const listener of listeners) listener();',
  '  },',
  '  getState: () => ({ count }),',
  '  subscribe: (listener) => {',
  '    listeners.add(listener);',
  '    return () => {',
  '      listeners.delete(listener);',
  '    };',
  '  },',
  '});',
  '',
  'export function startIronbird(): BridgeHandle {',
  "  return startBridge({ target, appId: 'com.example.compat', appName: `Compat (${Platform.OS})` });",
  '}',
  '',
].join('\n');

/** Typechecks only the wiring, against the generated project's own tsconfig and TypeScript (§8 step 5). */
export const WIRING_TSCONFIG = `${JSON.stringify({ extends: './tsconfig.json', include: [WIRING_FILE] }, null, 2)}\n`;

const BRIDGE_BLOCK = ['if (__DEV__) {', `  require('./${WIRING_FILE.replace(/\.ts$/, '')}').startIronbird();`, '}', ''].join('\n');

/** Adds the dev-only bridge start to a template index.js, right before the app registers. */
export function patchIndex(source) {
  if (source.includes(WIRING_FILE.replace(/\.ts$/, ''))) throw new Error('index.js is already wired');
  const at = source.indexOf('AppRegistry.registerComponent(');
  if (at === -1) throw new Error('index.js has no AppRegistry.registerComponent call to wire before');
  return `${source.slice(0, at)}${BRIDGE_BLOCK}\n${source.slice(at)}`;
}

const TEMPLATE_CONFIG = 'const config = {};';
const ZOD_CONFIG = [
  'const config = {',
  '  resolver: {',
  '    // zod resolves to its CommonJS build (docs/api.md): its "import" condition is ESM that uses',
  "    // `export * as`, which the React Native Babel preset doesn't transform inside node_modules.",
  '    resolveRequest: (context, moduleName, platform) =>',
  "      context.resolveRequest(moduleName === 'zod' || moduleName.startsWith('zod/') ? { ...context, isESMImport: false } : context, moduleName, platform),",
  '  },',
  '};',
].join('\n');

/**
 * Applies the Metro setting docs/api.md tells bare apps to add once their code imports zod: a fresh
 * template's first bundle otherwise fails on zod's ESM build. Throws on any metro.config.js that isn't
 * the template's shape, so a template change fails the leg loudly instead of bundling unpatched.
 */
export function patchMetroConfig(source) {
  if (source.includes('isESMImport')) throw new Error('metro.config.js already resolves zod');
  if (source.split(TEMPLATE_CONFIG).length !== 2) {
    throw new Error(`metro.config.js does not have the template's \`${TEMPLATE_CONFIG}\`; the template changed, so update patchMetroConfig`);
  }
  return source.replace(TEMPLATE_CONFIG, ZOD_CONFIG);
}

/** Null when verify-bundle's exit code is what the bundle needs, else why not. */
export function checkVerify(result, expectation) {
  const output = result.stdout.trim();
  if (expectation === 'clean') return result.status === 0 ? null : `expected a clean bundle (exit 0), got exit ${result.status}: ${output}`;
  return result.status === 1 ? null : `expected the bridge marker (exit 1), got exit ${result.status}: ${output}`;
}

/** A Markdown table under a heading, for the log and the GitHub step summary. */
export function summaryTable(title, rows) {
  const columns = Object.keys(rows[0] ?? {});
  return [
    `### ${title}`,
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((column) => String(row[column])).join(' | ')} |`),
    '',
  ].join('\n');
}
