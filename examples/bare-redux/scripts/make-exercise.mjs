#!/usr/bin/env node
// Regenerates integration-exercise/ from this app and the material in exercise/ (M5 design D7). Run
// it after any change to either, then commit the result: scripts/lib/exercise.test.mjs fails while
// the committed copy is stale. It replaces the whole copy, so a hand edit there is lost by design.
// It generates into a temporary directory first, so a leak or a bad marker never half-writes the copy.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateExercise } from './lib/exercise.mjs';

const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(exampleDir, 'integration-exercise');

const trial = await mkdtemp(path.join(os.tmpdir(), 'ironbird-exercise-'));
try {
  await generateExercise({ exampleDir, outDir: trial });
} finally {
  await rm(trial, { recursive: true, force: true });
}
await rm(outDir, { recursive: true, force: true });
const { files } = await generateExercise({ exampleDir, outDir });
console.log(`Wrote ${files.length} files to ${path.relative(process.cwd(), outDir) || '.'}`);
