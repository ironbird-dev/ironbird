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
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.ironbird/**', '**/coverage/**', '**/.superpowers/**', '**/.claude/**', '**/test/fixtures/**'] },
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
);
