#!/usr/bin/env node
// Packs named @ironbird packages with `pnpm pack`, which turns workspace ranges into the versions on
// this branch, for installing outside the workspace: the compat legs (M5 design §8) and the
// integration exercise (examples/bare-redux/exercise/TASK.md). Run `pnpm build` first.
// Usage: node scripts/pack-packages.mjs <out-dir> <name...>, names from PACKABLE.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKABLE = ['core', 'react-native', 'redux', 'xstate', 'cli', 'testing'];

/** Packs each named package into `outDir` and returns the tarball paths, in the order of `names`. */
export function packPackages(names, outDir) {
  for (const name of names) {
    if (!PACKABLE.includes(name)) throw new Error(`Unknown package ${name}; expected one of ${PACKABLE.join(', ')}`);
  }
  mkdirSync(outDir, { recursive: true });
  return names.map((name) => {
    if (!existsSync(path.join(repo, 'packages', name, 'dist'))) throw new Error(`packages/${name}/dist is missing: run pnpm build first`);
    const result = spawnSync('pnpm', ['--filter', `@ironbird/${name}`, 'pack', '--pack-destination', outDir], { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`pnpm pack for @ironbird/${name} failed:\n${result.stdout}${result.stderr}`);
    const pattern = new RegExp(`^ironbird-${name}-\\d+\\.\\d+\\.\\d+.*\\.tgz$`);
    const tarball = readdirSync(outDir).find((file) => pattern.test(file));
    if (!tarball) throw new Error(`pnpm pack for @ironbird/${name} wrote no tarball to ${outDir}`);
    return path.join(outDir, tarball);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [outDir, ...names] = process.argv.slice(2);
  if (!outDir || names.length === 0) {
    console.error('Usage: node scripts/pack-packages.mjs <out-dir> <name...>');
    process.exit(2);
  }
  console.log(JSON.stringify({ tarballs: packPackages(names, path.resolve(outDir)) }, null, 2));
}
