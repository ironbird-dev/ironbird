import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const dist = new URL('../dist/', import.meta.url);
const require = createRequire(import.meta.url);

const cjs = require('../dist/index.cjs');
const esm = await import('../dist/index.js');
const names = Object.keys(esm).sort();
const cjsNames = Object.keys(cjs).sort();
if (names.length === 0) throw new Error('the ESM build exports nothing');
if (JSON.stringify(cjsNames) !== JSON.stringify(names)) throw new Error(`the builds export different names: cjs ${cjsNames.join(', ')}; esm ${names.join(', ')}`);
for (const name of names) {
  if (typeof esm[name] !== 'function' || typeof cjs[name] !== 'function') throw new Error(`${name} is not a function in both builds`);
}

for (const file of readdirSync(dist)) {
  if (!file.endsWith('.js') && !file.endsWith('.cjs')) continue;
  const source = readFileSync(new URL(file, dist), 'utf8');
  for (const match of source.matchAll(/(?:from\s+|require\()["'](@ironbird\/cli(?:\/[^"']*)?)["']/g)) {
    if (match[1] !== '@ironbird/cli/runner') throw new Error(`${file} imports ${match[1]}; @ironbird/testing may reach the CLI only through @ironbird/cli/runner`);
  }
  if (/(?:from\s+|require\()["'](?:vitest|jest|@jest\/[^"']+)["']/.test(source)) throw new Error(`${file} imports a test framework`);
}
console.log(`@ironbird/testing build verified: esm and cjs both export ${names.join(', ')}`);
