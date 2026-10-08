import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const coreOnlyZod = {
  patterns: [
    {
      group: ['react-native', 'react-native/*', 'react', 'react/*', 'node:*', 'fs', 'path', 'os', 'http', 'https', 'net', 'child_process', 'url', 'util', 'events', 'stream', 'crypto', 'worker_threads'],
      message: '@ironbird/core may import only zod (AGENTS.md hard rule 1).',
    },
  ],
};

const coreForbiddenGlobals = [
  { name: 'window', message: 'core has no DOM' },
  { name: 'document', message: 'core has no DOM' },
  { name: 'process', message: 'core runs in Hermes; there is no process' },
];

const coreForbiddenTimers = [
  { name: 'setTimeout', message: 'Take time from the injected Clock (AGENTS.md hard rule 9). Only clock.ts and scheduler.ts may use global timers.' },
  { name: 'setInterval', message: 'Take time from the injected Clock (AGENTS.md hard rule 9).' },
  { name: 'clearTimeout', message: 'Take time from the injected Clock (AGENTS.md hard rule 9).' },
  { name: 'clearInterval', message: 'Take time from the injected Clock (AGENTS.md hard rule 9).' },
  { name: 'setImmediate', message: 'Take time from the injected Clock (AGENTS.md hard rule 9). Only clock.ts and scheduler.ts may use global timers.' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.ironbird/**', '**/coverage/**', '**/.superpowers/**', '**/.claude/**', '**/test/fixtures/**', '**/.stryker-tmp/**', 'reports/**', '**/ios/Pods/**', '**/ios/build/**', '**/android/build/**', '**/android/app/build/**', '**/vendor/bundle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{js,mjs,cjs}'], languageOptions: { globals: { ...globals.node } } },
  {
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', coreOnlyZod],
      'no-restricted-globals': ['error', ...coreForbiddenGlobals],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/clock.ts', 'packages/core/src/scheduler.ts', 'packages/core/src/**/*.test.ts'],
    rules: {
      // Flat config replaces a rule's options rather than merging them, so this list repeats the
      // DOM and process entries above: dropping them here would un-ban them for every core file
      // this block covers.
      'no-restricted-globals': ['error', ...coreForbiddenGlobals, ...coreForbiddenTimers],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use clock.now() or scheduler.now() (AGENTS.md hard rule 9).' },
      ],
    },
  },
  {
    files: ['packages/react-native/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'fs', 'path', 'os', 'http', 'https', 'net', 'child_process', 'url', 'util', 'events', 'stream', 'crypto', 'worker_threads'], message: 'The bridge runs in Hermes.' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/react-native/src/**/*.ts'],
    ignores: ['packages/react-native/src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', ...coreForbiddenTimers.filter((entry) => entry.name !== 'setImmediate')],
      'no-restricted-properties': ['error', { object: 'Date', property: 'now', message: 'Use the Clock passed to startBridge (AGENTS.md hard rule 9).' }],
    },
  },
  {
    // Metro's own entry point, not a Node script: `__DEV__` is a Metro-injected global, and the
    // require() call is deliberately synchronous so Metro can statically drop it in production.
    files: ['examples/checkout/index.js'],
    languageOptions: { globals: { ...globals['react-native'] } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // The bare React Native example and its generated exercise copy: Metro's entry, where `__DEV__`
    // is a Metro-injected global and the dev-only require() must stay synchronous so release bundles
    // drop it, and the CommonJS config files Metro and Babel load.
    files: [
      'examples/bare-redux/index.js',
      'examples/bare-redux/*.config.js',
      'examples/bare-redux/integration-exercise/index.js',
      'examples/bare-redux/integration-exercise/*.config.js',
    ],
    languageOptions: { globals: { ...globals.node, ...globals['react-native'] } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // AGENTS.md rule 9 for the bare example's app logic, wired and generated: time comes from an
    // injected clock. The one platform-timer call allowed is the exercise copy's real-clock adapter,
    // src/sync/real-timers.ts; in the wired app that file uses @ironbird/core's real clock instead.
    files: ['examples/bare-redux/App.tsx', 'examples/bare-redux/src/**/*.ts', 'examples/bare-redux/integration-exercise/App.tsx', 'examples/bare-redux/integration-exercise/src/**/*.ts'],
    ignores: ['examples/bare-redux/**/*.test.ts', 'examples/bare-redux/integration-exercise/src/sync/real-timers.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate'].map((name) => ({
          name,
          message: 'Take time from the injected clock (AGENTS.md hard rule 9); only the real-clock adapter, src/sync/real-timers.ts, may call the platform timer.',
        })),
      ],
      'no-restricted-properties': ['error', { object: 'Date', property: 'now', message: 'Take time from the injected clock (AGENTS.md hard rule 9).' }],
    },
  },
  {
    // The adapters run in Node and Hermes. At runtime they import only @ironbird/core and, for
    // @ironbird/xstate, the xstate peer; redux and zod are type imports (M5 design D3). Library code
    // takes no time from globals (AGENTS.md rule 9). This block covers packages/xstate too.
    files: ['packages/redux/src/**/*.ts', 'packages/xstate/src/**/*.ts'],
    ignores: ['packages/redux/src/**/*.test.ts', 'packages/xstate/src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'zod', allowTypeImports: true, message: 'Adapters reach zod only through the schemas the app passes (M5 design D3).' },
            { name: 'redux', allowTypeImports: true, message: '@ironbird/redux imports redux for types only (M5 design D3).' },
            { name: '@reduxjs/toolkit', message: 'The adapter works with any Redux 5 store; Redux Toolkit is a test dependency only.' },
          ],
          patterns: [
            {
              group: ['node:*', 'react-native', 'react-native/*', 'react', 'react/*', 'fs', 'path', 'os', 'http', 'https', 'net', 'child_process', 'url', 'util', 'events', 'stream', 'crypto', 'worker_threads'],
              message: 'Adapters run in Hermes too.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...coreForbiddenTimers],
      'no-restricted-properties': ['error', { object: 'Date', property: 'now', message: 'Adapters take no time from globals (AGENTS.md rule 9).' }],
    },
  },
  {
    // @ironbird/testing reaches the CLI only through the dual-format runner subpath, and its
    // library code imports no test framework, so it behaves the same under Vitest and Jest
    // (M4 design D1, D9).
    files: ['packages/testing/src/**/*.ts'],
    ignores: ['packages/testing/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@ironbird/cli', message: 'Import the CLI through @ironbird/cli/runner, which ships CommonJS too (M4 design D1).' }],
          patterns: [
            { group: ['@ironbird/cli/*', '!@ironbird/cli/runner'], message: 'Import the CLI through @ironbird/cli/runner (M4 design D1).' },
            { group: ['vitest', 'vitest/*', 'jest', '@jest/*'], message: '@ironbird/testing imports no test framework (M4 design D9).' },
          ],
        },
      ],
    },
  },
  {
    // The Jest smoke is CommonJS on purpose: it requires the built package the way a Jest user does.
    files: ['packages/testing/jest/**/*.cjs', 'packages/testing/jest.config.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.jest } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
