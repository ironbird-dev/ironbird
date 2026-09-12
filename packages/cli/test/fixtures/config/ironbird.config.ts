import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({ headless: './src/ironbird/headless.ts', appId: 'com.example.fixture', clock: { start: '2026-01-01T00:00:00.000Z' } });
