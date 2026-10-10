#!/usr/bin/env node
// Regenerates integration-exercise/ from this app and the material in exercise/ (M5 design D7). Run
// it after any change to either, then commit the result: scripts/lib/exercise.test.mjs fails while
// the committed copy is stale. It replaces the whole copy, so a hand edit there is lost by design.
// It generates into a temporary folder and swaps the result in only once it passes, so a leak or a
// bad marker never half-writes the copy and a failed swap puts the old copy back.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceExercise } from './lib/exercise.mjs';

const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(exampleDir, 'integration-exercise');

const { files } = await replaceExercise({ exampleDir, outDir });
console.log(`Wrote ${files.length} files to ${path.relative(process.cwd(), outDir) || '.'}`);
