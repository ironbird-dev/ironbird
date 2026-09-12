import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'examples/*/src/**/*.test.ts'],
          exclude: ['**/*.device.test.ts', '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'device',
          include: ['**/*.device.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
});
