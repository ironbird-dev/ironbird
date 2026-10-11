// What the published packages may and must ship (M5 design §9, item 2). Pure rules, unit-tested in
// packs.test.mjs; check-packs.mjs packs each package with `pnpm pack` and applies them.

/** Every package the release publishes. A new public package must be added here on purpose. */
export const EXPECTED_PUBLISHED = ['@ironbird/cli', '@ironbird/core', '@ironbird/react-native', '@ironbird/redux', '@ironbird/testing', '@ironbird/xstate', 'ironbird'];

/** Export keys that must ship both ESM and CommonJS builds, each with type declarations. The CLI's main entry is ESM only (AGENTS.md conventions). */
export const DUAL_ENTRIES = {
  '@ironbird/core': ['.'],
  '@ironbird/react-native': ['.'],
  '@ironbird/redux': ['.'],
  '@ironbird/xstate': ['.'],
  '@ironbird/testing': ['.'],
  '@ironbird/cli': ['./config', './runner'],
  ironbird: [],
};

/** The zod peer range the M5 design fixes (D9), and the packages that must declare it. */
export const ZOD_PEER = '^4.2.0';
export const ZOD_PEER_PACKAGES = ['@ironbird/core', '@ironbird/redux', '@ironbird/testing', '@ironbird/xstate'];

const FORBIDDEN = [
  [/(^|\/)(src|test|tests|__tests__|scripts|jest)\//, 'a source, test, or script folder'],
  [/\.test\.[cm]?[jt]sx?$/, 'a test file'],
  [/\.tsbuildinfo$/, 'a TypeScript build cache'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'a tsconfig'],
  [/(^|\/)(tsup|vitest|jest|stryker)[^/]*\.config\.[cm]?[jt]s$/, 'a tool config'],
];

const strip = (file) => file.replace(/^\.\//, '');

/** Every file package.json points at (`exports` leaves, `main`, `module`, `types`, `bin`), without `./`, sorted. */
export function exportTargets(manifest) {
  const targets = new Set();
  const add = (value) => {
    if (typeof value === 'string') targets.add(strip(value));
  };
  const walk = (node) => {
    if (typeof node === 'string') add(node);
    else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) if (key !== './package.json') walk(value);
  };
  walk(manifest.exports);
  add(manifest.main);
  add(manifest.module);
  add(manifest.types);
  if (typeof manifest.bin === 'string') add(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object') for (const value of Object.values(manifest.bin)) add(value);
  return [...targets].sort();
}

/** Problems with the files one packed package ships, given its packed manifest. */
export function packProblems({ name, manifest, files }) {
  const problems = [];
  const have = new Set(files);
  for (const required of ['package.json', 'LICENSE', 'README.md']) if (!have.has(required)) problems.push(`${required} is missing`);
  for (const file of files) {
    const hit = FORBIDDEN.find(([pattern]) => pattern.test(file));
    if (hit) problems.push(`${file} should not ship (${hit[1]})`);
    else if (/\.(ts|tsx|mts|cts)$/.test(file) && !/\.d\.(ts|mts|cts)$/.test(file)) problems.push(`${file} should not ship (TypeScript source)`);
  }
  for (const target of exportTargets(manifest)) if (!have.has(target)) problems.push(`${target} is named in package.json but not packed`);
  for (const key of DUAL_ENTRIES[name] ?? []) {
    const entry = manifest.exports?.[key];
    for (const condition of ['import', 'require']) {
      for (const field of ['types', 'default']) if (typeof entry?.[condition]?.[field] !== 'string') problems.push(`exports["${key}"].${condition}.${field} is missing`);
    }
  }
  problems.push(...formatProblems(manifest));
  return problems;
}

/**
 * Every `import` and `require` condition in `exports`, dual or not, must point at its own format:
 * `import` at ESM (`.mjs`, or `.js` in a `"type": "module"` package) with ESM declarations, `require`
 * at CommonJS (`.cjs`, or `.js` otherwise) with CommonJS declarations. This also covers the CLI's
 * ESM-only main entry, which DUAL_ENTRIES leaves out.
 */
function formatProblems(manifest) {
  const esm = manifest.type === 'module';
  const ok = {
    import: { types: (file) => file.endsWith('.d.mts') || (esm && file.endsWith('.d.ts')), default: (file) => file.endsWith('.mjs') || (esm && file.endsWith('.js')) },
    require: { types: (file) => file.endsWith('.d.cts') || (!esm && file.endsWith('.d.ts')), default: (file) => file.endsWith('.cjs') || (!esm && file.endsWith('.js')) },
  };
  const expected = {
    import: { types: 'an ESM declaration (.d.mts, or .d.ts with "type": "module")', default: 'ESM (.mjs, or .js with "type": "module")' },
    require: { types: 'a CommonJS declaration (.d.cts, or .d.ts without "type": "module")', default: 'CommonJS (.cjs, or .js without "type": "module")' },
  };
  const problems = [];
  const exports = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports : {};
  for (const [key, entry] of Object.entries(exports)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const condition of ['import', 'require']) {
      const target = typeof entry[condition] === 'string' ? { default: entry[condition] } : entry[condition];
      for (const field of ['types', 'default']) {
        const file = target?.[field];
        if (typeof file === 'string' && !ok[condition][field](file)) problems.push(`exports["${key}"].${condition}.${field} is ${file}, not ${expected[condition][field]}`);
      }
    }
  }
  return problems;
}

/**
 * Problems with a packed manifest. `internal` lists the workspace's public package names;
 * `expectVersion`, when given, is the version every package and internal dependency must carry.
 */
export function manifestProblems({ manifest, internal, expectVersion }) {
  const problems = [];
  if (manifest.license !== 'MIT') problems.push(`license is ${manifest.license ?? 'missing'}, not MIT`);
  if (expectVersion !== undefined && manifest.version !== expectVersion) problems.push(`version is ${manifest.version}, not ${expectVersion}`);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      const text = String(range);
      if (field === 'dependencies' && internal.includes(dependency) && expectVersion !== undefined && text !== expectVersion) problems.push(`dependencies.${dependency} is ${text}, not ${expectVersion}`);
      if (field === 'peerDependencies' && internal.includes(dependency) && /^\d+\.\d+\.\d+$/.test(text)) problems.push(`peerDependencies.${dependency} pins exactly ${text}; use a range`);
      if (text.startsWith('workspace:')) problems.push(`${field}.${dependency} is still ${text}`);
    }
  }
  if (ZOD_PEER_PACKAGES.includes(manifest.name) && manifest.peerDependencies?.zod !== ZOD_PEER) {
    problems.push(`peerDependencies.zod is ${manifest.peerDependencies?.zod ?? 'missing'}, not ${ZOD_PEER} (M5 design D9)`);
  }
  return problems;
}

/** Problems with the set of public package names: anything unexpected, anything missing. */
export function publishedProblems(names) {
  const problems = [];
  for (const name of names) if (!EXPECTED_PUBLISHED.includes(name)) problems.push(`${name} would be published but is not in EXPECTED_PUBLISHED`);
  for (const name of EXPECTED_PUBLISHED) if (!names.includes(name)) problems.push(`${name} is expected to publish but no public package has that name`);
  return problems;
}
