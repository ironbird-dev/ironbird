import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const require = createRequire(import.meta.url);
const expected = ['fromActor'];
const allowed = new Set(['@ironbird/core', 'xstate']);

const builds = [['cjs', require('../dist/index.cjs')], ['esm', await import('../dist/index.js')]];
for (const [format, mod] of builds) {
  const names = Object.keys(mod).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`the ${format} build exports ${names.join(', ')}; expected ${expected.join(', ')}`);
  for (const name of names) {
    if (typeof mod[name] !== 'function') throw new Error(`${name} is not a function in the ${format} build`);
  }
}

for (const file of readdirSync(dist)) {
  if (!file.endsWith('.js') && !file.endsWith('.cjs')) continue;
  const source = readFileSync(join(dist.pathname, file), 'utf8');
  for (const match of source.matchAll(/(?:from\s+|require\()["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) continue;
    if (!allowed.has(specifier)) throw new Error(`${file} imports ${specifier}; @ironbird/xstate may import only @ironbird/core and xstate at runtime (M5 design D3)`);
  }
  if (source.includes('__IRONBIRD_BRIDGE')) throw new Error(`${file} contains the bridge marker; it must live only in @ironbird/react-native`);
}
console.log(`@ironbird/xstate build verified: esm and cjs export ${expected.join(', ')}; runtime imports only @ironbird/core and xstate`);
