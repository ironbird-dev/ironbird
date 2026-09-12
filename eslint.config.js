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

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.ironbird/**', '**/coverage/**', '**/.superpowers/**'] },
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
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'core has no DOM' },
        { name: 'document', message: 'core has no DOM' },
        { name: 'process', message: 'core runs in Hermes; there is no process' },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/clock.ts', 'packages/core/src/scheduler.ts', 'packages/core/src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Take time from the injected Clock (AGENTS.md hard rule 9). Only clock.ts and scheduler.ts may use global timers.' },
        { name: 'setInterval', message: 'Take time from the injected Clock (AGENTS.md hard rule 9).' },
        { name: 'clearTimeout', message: 'Take time from the injected Clock (AGENTS.md hard rule 9).' },
        { name: 'clearInterval', message: 'Take time from the injected Clock (AGENTS.md hard rule 9).' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use clock.now() or scheduler.now() (AGENTS.md hard rule 9).' },
      ],
    },
  },
  {
    files: ['packages/react-native/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'The bridge runs in Hermes.' }] }],
    },
  },
);
