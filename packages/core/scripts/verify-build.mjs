import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const require = createRequire(import.meta.url);

const cjs = require('../dist/index.cjs');
const esm = await import('../dist/index.js');
for (const name of ['defineCommands', 'createTarget', 'createManualClock', 'createTracker', 'createEventRecorder', 'defineHeadless', 'IronbirdError']) {
  if (typeof cjs[name] !== 'function') throw new Error(`CJS build is missing ${name}`);
  if (typeof esm[name] !== 'function') throw new Error(`ESM build is missing ${name}`);
}

for (const file of readdirSync(dist)) {
  if (!file.endsWith('.js') && !file.endsWith('.cjs')) continue;
  const source = readFileSync(join(dist.pathname, file), 'utf8');
  if (/from\s+["']node:|require\(["']node:/.test(source)) throw new Error(`${file} imports a node: module`);
  // Loading zod costs tens of milliseconds, and every CLI client command imports core. Core reaches
  // zod only through the schema instances it is handed (registry.ts imports it as a type), so a
  // static import here would put that cost back on the client startup path.
  if (/from\s+["']zod(?:\/[^"']*)?["']|require\(["']zod(?:\/[^"']*)?["']\)/.test(source)) {
    throw new Error(`${file} imports zod at load time; core must only use zod through the schemas it is given`);
  }
  if (source.includes('__IRONBIRD_BRIDGE')) throw new Error(`${file} contains the bridge marker; it must live only in @ironbird/react-native`);
}
console.log('core build verified: esm+cjs load, no node: imports, no zod at load time, no bridge marker');
