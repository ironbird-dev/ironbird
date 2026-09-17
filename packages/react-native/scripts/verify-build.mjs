import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const marker = ['__IRONBIRD', 'BRIDGE', 'v1__'].join('_');
const allowed = new Set(['react-native', '@ironbird/core']);

for (const file of readdirSync(dist)) {
  if (!file.endsWith('.js') && !file.endsWith('.cjs')) continue;
  const source = readFileSync(join(dist.pathname, file), 'utf8');
  for (const match of source.matchAll(/(?:from\s+|require\()["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) continue;
    if (!allowed.has(specifier)) throw new Error(`${file} imports ${specifier}; the bridge may import only react-native and @ironbird/core`);
  }
  if (/from\s+["']node:|require\(["']node:/.test(source)) throw new Error(`${file} imports a node: module`);
  if (!source.includes(marker)) throw new Error(`${file} does not contain the bridge marker`);
  if (source.includes('__BRIDGE_VERSION__')) throw new Error(`${file} still references __BRIDGE_VERSION__; tsup define did not run`);
}
console.log('@ironbird/react-native build verified');
