#!/usr/bin/env node
// The Expo SDK 57 leg of the compat job (M5 design D8 and §8): the checkout example, on React Native
// 0.86 as SDK 57 pins it. Checks the resolved expo and react-native versions, exports a production
// build, and requires verify-bundle to find no bridge. It then exports again with
// EXPO_PUBLIC_FORCE_BRIDGE=1, the checkout's deliberate "broken build" switch (examples/checkout/index.js),
// and requires the marker, so the clean result isn't vacuous.
// Usage: node scripts/compat/expo-leg.mjs   (after pnpm install and pnpm build)
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVersion, checkVerify, summaryTable } from './lib.mjs';
import { run, verifyBundle, writeSummary } from './proc.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliBin = path.join(repo, 'packages/cli/dist/bin.js');
const checkout = path.join(repo, 'examples/checkout');
const started = Date.now();

const requireFromCheckout = createRequire(path.join(checkout, 'package.json'));
const expo = requireFromCheckout('expo/package.json').version;
const reactNative = requireFromCheckout('react-native/package.json').version;
assertVersion('expo', expo, '57');
assertVersion('react-native', reactNative, '0.86');

const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'ironbird-compat-expo-'));
const exports = [
  { name: 'release', env: { EXPO_PUBLIC_FORCE_BRIDGE: '0' }, expectation: 'clean' },
  { name: 'forced-bridge', env: { EXPO_PUBLIC_FORCE_BRIDGE: '1' }, expectation: 'marker' },
];
const rows = [];
for (const { name, env, expectation } of exports) {
  const out = path.join(work, name);
  run('pnpm', ['exec', 'expo', 'export', '--platform', 'all', '--output-dir', out, '--clear'], { cwd: checkout, env: { CI: '1', EXPO_NO_TELEMETRY: '1', ...env } });
  const verify = verifyBundle(cliBin, out);
  rows.push({ export: name, 'verify-bundle exit': verify.status, expected: expectation === 'clean' ? 0 : 1 });
  const problem = checkVerify(verify, expectation);
  if (problem) throw new Error(`${name} export: ${problem}`);
}

writeSummary(summaryTable(`compat: Expo SDK 57 (expo ${expo}, react-native ${reactNative}), ${Math.round((Date.now() - started) / 1000)} s`, rows));
