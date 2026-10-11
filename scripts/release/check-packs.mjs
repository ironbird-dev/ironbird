#!/usr/bin/env node
// Packs every published package and checks what it would ship (M5 design §9, item 2).
//
//   pnpm build && node scripts/release/check-packs.mjs [--expect-version 0.1.0]
//
// Prints one JSON report and exits 1 when anything is wrong. Tarballs go to a temporary folder,
// removed afterwards; nothing is published.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { manifestProblems, packProblems, publishedProblems } from './packs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { 'expect-version': { type: 'string' } } });

const packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = path.join(root, 'packages', entry.name);
    return { dir, manifest: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) };
  })
  .filter(({ manifest }) => manifest.private !== true);
const internal = packages.map(({ manifest }) => manifest.name);
const report = { problems: publishedProblems(internal), packages: [] };

const out = mkdtempSync(path.join(os.tmpdir(), 'ironbird-packs-'));
try {
  for (const { dir, manifest } of packages) {
    const stdout = execFileSync('pnpm', ['pack', '--pack-destination', out, '--json'], { cwd: dir, encoding: 'utf8' });
    const packed = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
    const tarball = path.isAbsolute(packed.filename) ? packed.filename : path.join(out, path.basename(packed.filename));
    const files = packed.files.map((file) => file.path);
    const shipped = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    const problems = [...packProblems({ name: manifest.name, manifest: shipped, files }), ...manifestProblems({ manifest: shipped, internal, expectVersion: values['expect-version'] })];
    report.packages.push({ name: manifest.name, version: shipped.version, files: files.length, problems });
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.problems.length > 0 || report.packages.some((entry) => entry.problems.length > 0)) process.exitCode = 1;
