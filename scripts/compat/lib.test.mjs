import { describe, expect, it } from 'vitest';
import { STEP_TIMEOUT_MS, WIRING_FILE, WIRING_SOURCE, WIRING_TSCONFIG, assertVersion, checkVerify, classifyFailure, isFetchFailure, parseLegArgs, patchIndex, patchMetroConfig, retryOnFetchFailure, summaryTable } from './lib.mjs';

// The 0.86.3 and 0.87.2 community templates' index.js, verbatim.
const TEMPLATE_INDEX = [
  '/**',
  ' * @format',
  ' */',
  '',
  "import { AppRegistry } from 'react-native';",
  "import App from './App';",
  "import { name as appName } from './app.json';",
  '',
  'AppRegistry.registerComponent(appName, () => App);',
  '',
].join('\n');

describe('parseLegArgs', () => {
  it('reads both pins', () => {
    expect(parseLegArgs(['--react-native', '0.87.1', '--cli', '20.2.0'])).toEqual({ reactNative: '0.87.1', cli: '20.2.0' });
  });

  it.each([
    [['--react-native', '0.87'], '--react-native needs an exact x.y.z version, got 0.87'],
    [['--cli'], '--cli needs an exact x.y.z version, got nothing'],
    [['--react-native', '0.87.1'], 'Both --react-native and --cli are required'],
    [['--rn', '0.87.1', '--cli', '20.2.0'], 'Unknown option --rn; expected --react-native <x.y.z> --cli <x.y.z>'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseLegArgs(argv)).toThrow(message);
  });
});

describe('assertVersion', () => {
  it('accepts an exact pin, a minor, and a major', () => {
    expect(() => assertVersion('react-native', '0.87.1', '0.87.1')).not.toThrow();
    expect(() => assertVersion('react-native', '0.86.3', '0.86')).not.toThrow();
    expect(() => assertVersion('expo', '57.0.23', '57')).not.toThrow();
  });

  it.each([
    ['react-native', '0.87.10', '0.87.1'],
    ['react-native', '0.86.3', '0.87'],
    ['expo', '570.0.0', '57'],
  ])('refuses %s %s for %s', (name, actual, wanted) => {
    expect(() => assertVersion(name, actual, wanted)).toThrow(`${name} resolved to ${actual}, but this leg needs ${wanted}`);
  });
});

describe('fetch failures', () => {
  it.each([
    'npm error code ETIMEDOUT',
    'npm error network request to https://registry.npmjs.org/react-native failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org',
    'npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/metro',
    'npm error code ECONNRESET',
    'Error: socket hang up',
  ])('counts %j as a fetch failure', (output) => {
    expect(isFetchFailure(output)).toBe(true);
  });

  it.each([
    "error TS2307: Cannot find module '@ironbird/core'",
    'react-native resolved to 0.86.3, but this leg needs 0.87.1',
    'npm error code ERESOLVE',
    'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@ironbird%2fnope',
    'error Unable to resolve module ./ironbird-wiring',
  ])('does not count %j', (output) => {
    expect(isFetchFailure(output)).toBe(false);
  });

  it('classifies a fetch step that hit its time limit as a fetch timeout, and registry errors as fetch failures', () => {
    expect(classifyFailure({ status: 0, output: '' })).toBeNull();
    expect(classifyFailure({ status: 1, timedOut: true, output: '[compat] npx timed out after 600000 ms' })).toBe('fetch-timeout');
    expect(classifyFailure({ status: 1, output: 'npm error code ETIMEDOUT' })).toBe('fetch');
    expect(classifyFailure({ status: 1, output: 'error TS2307' })).toBe('other');
    // The limits are finite and the install's is the shorter: init fetches the template and installs it.
    expect(STEP_TIMEOUT_MS.init).toBeGreaterThan(STEP_TIMEOUT_MS.install);
    expect(Number.isFinite(STEP_TIMEOUT_MS.init + STEP_TIMEOUT_MS.install)).toBe(true);
  });

  it('retries once after a fetch failure or a fetch timeout and never after any other failure', () => {
    const attempts = (results) => {
      const calls = [];
      const attempt = (n) => {
        calls.push(n);
        return results[n - 1];
      };
      return { calls, attempt };
    };
    const ok = { status: 0, output: '' };
    const blip = { status: 1, output: 'npm error code ETIMEDOUT' };
    const real = { status: 1, output: 'error TS2307' };

    let run = attempts([ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(ok);
    expect(run.calls).toEqual([1]);

    run = attempts([blip, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(ok);
    expect(run.calls).toEqual([1, 2]);

    run = attempts([real, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(real);
    expect(run.calls).toEqual([1]);

    run = attempts([blip, blip, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(blip);
    expect(run.calls).toEqual([1, 2]);

    const stalled = { status: 1, timedOut: true, output: '[compat] npx timed out after 600000 ms' };
    run = attempts([stalled, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(ok);
    expect(run.calls).toEqual([1, 2]);

    run = attempts([stalled, stalled, ok]);
    expect(retryOnFetchFailure(run.attempt)).toBe(stalled);
    expect(run.calls).toEqual([1, 2]);
  });
});

describe('the wiring', () => {
  it('starts the bridge from index.js in dev builds only, right before the app registers', () => {
    expect(patchIndex(TEMPLATE_INDEX)).toBe(
      [
        '/**',
        ' * @format',
        ' */',
        '',
        "import { AppRegistry } from 'react-native';",
        "import App from './App';",
        "import { name as appName } from './app.json';",
        '',
        'if (__DEV__) {',
        "  require('./ironbird-wiring').startIronbird();",
        '}',
        '',
        'AppRegistry.registerComponent(appName, () => App);',
        '',
      ].join('\n'),
    );
  });

  it('refuses an index.js it already wired or cannot place the wiring in', () => {
    expect(() => patchIndex(patchIndex(TEMPLATE_INDEX))).toThrow('index.js is already wired');
    expect(() => patchIndex("import App from './App';\n")).toThrow('index.js has no AppRegistry.registerComponent call to wire before');
  });

  it('builds a target and starts the bridge, typechecked on its own', () => {
    expect(WIRING_FILE).toBe('ironbird-wiring.ts');
    expect(WIRING_SOURCE).toContain("from '@ironbird/core'");
    expect(WIRING_SOURCE).toContain('startBridge({');
    expect(WIRING_SOURCE).toContain("from 'react-native'");
    expect(JSON.parse(WIRING_TSCONFIG)).toEqual({ extends: './tsconfig.json', include: ['ironbird-wiring.ts'] });
  });
});

describe('patchMetroConfig', () => {
  // The 0.86.3, 0.87.1, and 0.87.2 community templates' metro.config.js, verbatim.
  const TEMPLATE_METRO_CONFIG = [
    "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');",
    '',
    '/**',
    ' * Metro configuration',
    ' * https://reactnative.dev/docs/metro',
    ' *',
    " * @type {import('@react-native/metro-config').MetroConfig}",
    ' */',
    'const config = {};',
    '',
    'module.exports = mergeConfig(getDefaultConfig(__dirname), config);',
    '',
  ].join('\n');

  it('resolves zod to its CommonJS build, as docs/api.md tells bare apps to', () => {
    expect(patchMetroConfig(TEMPLATE_METRO_CONFIG)).toBe(
      [
        "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');",
        '',
        '/**',
        ' * Metro configuration',
        ' * https://reactnative.dev/docs/metro',
        ' *',
        " * @type {import('@react-native/metro-config').MetroConfig}",
        ' */',
        'const config = {',
        '  resolver: {',
        "    // zod resolves to its CommonJS build (docs/api.md): its \"import\" condition is ESM that uses",
        "    // `export * as`, which the React Native Babel preset doesn't transform inside node_modules.",
        '    resolveRequest: (context, moduleName, platform) =>',
        "      context.resolveRequest(moduleName === 'zod' || moduleName.startsWith('zod/') ? { ...context, isESMImport: false } : context, moduleName, platform),",
        '  },',
        '};',
        '',
        'module.exports = mergeConfig(getDefaultConfig(__dirname), config);',
        '',
      ].join('\n'),
    );
  });

  it('refuses a metro.config.js it already patched or does not recognise', () => {
    expect(() => patchMetroConfig(patchMetroConfig(TEMPLATE_METRO_CONFIG))).toThrow('metro.config.js already resolves zod');
    expect(() => patchMetroConfig("module.exports = { resolver: {} };\n")).toThrow('metro.config.js does not have the template\'s `const config = {};`; the template changed, so update patchMetroConfig');
    expect(() => patchMetroConfig('const config = {};\nconst config = {};\n')).toThrow('metro.config.js does not have the template\'s `const config = {};`');
  });
});

describe('checkVerify', () => {
  const output = (found) => JSON.stringify({ scanned: 1, found });
  it('wants exit 0 for a clean bundle and exit 1 for the marker', () => {
    expect(checkVerify({ status: 0, stdout: output([]) }, 'clean')).toBeNull();
    expect(checkVerify({ status: 1, stdout: output([{ file: 'a', offset: 1 }]) }, 'marker')).toBeNull();
    expect(checkVerify({ status: 1, stdout: output([{ file: 'a', offset: 1 }]) }, 'clean')).toBe('expected a clean bundle (exit 0), got exit 1: {"scanned":1,"found":[{"file":"a","offset":1}]}');
    expect(checkVerify({ status: 0, stdout: output([]) }, 'marker')).toBe('expected the bridge marker (exit 1), got exit 0: {"scanned":1,"found":[]}');
    expect(checkVerify({ status: 2, stdout: '' }, 'clean')).toBe('expected a clean bundle (exit 0), got exit 2: ');
  });
});

describe('summaryTable', () => {
  it('renders a Markdown table under a heading', () => {
    expect(summaryTable('compat', [{ bundle: 'ios release', exit: 0 }, { bundle: 'ios dev', exit: 1 }])).toBe(
      ['### compat', '', '| bundle | exit |', '| --- | --- |', '| ios release | 0 |', '| ios dev | 1 |', ''].join('\n'),
    );
  });
});
