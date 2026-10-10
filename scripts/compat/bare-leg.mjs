#!/usr/bin/env node
// One React Native leg of the compat job (M5 design D8 and §8), in a temporary directory outside the
// workspace: generate a bare project with the community CLI this leg pins, check that react-native
// resolved to the pinned version, install @ironbird/core and @ironbird/react-native from tarballs
// packed in this run, add the minimal wiring and the Metro setting docs/api.md gives bare apps that
// import zod, typecheck the wiring with the project's own TypeScript, and bundle for iOS and Android
// in release and dev mode. Release bundles must be clean; dev bundles must carry the bridge marker,
// so a clean release result isn't vacuous. This is JavaScript-bundle evidence, not a native build.
// Usage: node scripts/compat/bare-leg.mjs --react-native 0.87.1 --cli 20.2.0   (after pnpm build)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackages } from '../pack-packages.mjs';
import { STEP_TIMEOUT_MS, WIRING_FILE, WIRING_SOURCE, WIRING_TSCONFIG, assertVersion, checkVerify, parseLegArgs, patchIndex, patchMetroConfig, summaryTable } from './lib.mjs';
import { run, verifyBundle, writeSummary } from './proc.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliBin = path.join(repo, 'packages/cli/dist/bin.js');
const { reactNative, cli } = parseLegArgs(process.argv.slice(2));
const started = Date.now();
const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `ironbird-compat-rn-${reactNative}-`));
const project = path.join(work, 'CompatApp');
const bin = (name) => path.join(project, 'node_modules', '.bin', name);
console.log(`compat leg: react-native ${reactNative}, @react-native-community/cli ${cli}, in ${work}`);

// 1. A fresh project from the template this React Native version resolves to. A stalled fetch is
// killed at its limit and retried once, after clearing the half-written project.
run('npx', ['--yes', `@react-native-community/cli@${cli}`, 'init', 'CompatApp', '--version', reactNative, '--directory', project, '--pm', 'npm', '--skip-git-init', '--install-pods', 'false'], {
  cwd: work,
  retry: true,
  timeoutMs: STEP_TIMEOUT_MS.init,
  beforeRetry: () => rmSync(project, { recursive: true, force: true }),
});

// 2. The leg is about this version, so prove that is what got installed.
const resolved = createRequire(path.join(project, 'package.json'))('react-native/package.json').version;
assertVersion('react-native', resolved, reactNative);

// 3. The packages as they would be published from this commit.
const tarballs = packPackages(['core', 'react-native'], path.join(work, 'packs'));
run('npm', ['install', '--no-audit', '--no-fund', ...tarballs, 'zod@^4.2.0'], { cwd: project, retry: true, timeoutMs: STEP_TIMEOUT_MS.install });

// 4. The wiring, started from index.js in dev builds only, and the Metro setting docs/api.md gives
// bare apps that import zod: resolve it to its CommonJS build.
writeFileSync(path.join(project, WIRING_FILE), WIRING_SOURCE);
writeFileSync(path.join(project, 'tsconfig.ironbird.json'), WIRING_TSCONFIG);
const indexFile = path.join(project, 'index.js');
writeFileSync(indexFile, patchIndex(readFileSync(indexFile, 'utf8')));
const metroFile = path.join(project, 'metro.config.js');
writeFileSync(metroFile, patchMetroConfig(readFileSync(metroFile, 'utf8')));

// 5. Typecheck against this React Native version's types.
run(bin('tsc'), ['--noEmit', '-p', 'tsconfig.ironbird.json'], { cwd: project });

// 6 and 7. Release bundles must be clean; dev bundles must carry the marker.
const rows = [];
for (const platform of ['ios', 'android']) {
  for (const mode of ['release', 'dev']) {
    const out = path.join(work, 'bundles', `${platform}-${mode}.jsbundle`);
    mkdirSync(path.dirname(out), { recursive: true });
    run(bin('react-native'), ['bundle', '--platform', platform, '--dev', String(mode === 'dev'), '--entry-file', 'index.js', '--bundle-output', out], { cwd: project });
    const verify = verifyBundle(cliBin, out);
    const expectation = mode === 'dev' ? 'marker' : 'clean';
    rows.push({ bundle: `${platform} ${mode}`, 'verify-bundle exit': verify.status, expected: expectation === 'clean' ? 0 : 1 });
    const problem = checkVerify(verify, expectation);
    if (problem) throw new Error(`${platform} ${mode} bundle: ${problem}`);
  }
}

writeSummary(summaryTable(`compat: react-native ${resolved} (CLI ${cli}), typecheck passed, ${Math.round((Date.now() - started) / 1000)} s`, rows));
