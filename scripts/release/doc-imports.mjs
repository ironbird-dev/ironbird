// Named imports of ironbird packages in the docs' code blocks must exist in the built packages, so
// the 0.1 README, the guides, and the package READMEs can't drift from the code. Pure helpers;
// doc-imports.test.mjs applies them to the real docs against dist/.

/** The names a declaration file exports: its `export { ... };` statements (tsup's form) and `export declare` lines. `type` prefixes are dropped; aliases count by their exported name. */
export function exportedNames(dts) {
  const names = new Set();
  for (const match of dts.matchAll(/export\s*\{([^}]*)\}\s*;/g)) {
    for (const part of match[1].split(',')) {
      const item = part.trim().replace(/^type\s+/, '');
      if (item) names.add(item.split(/\s+as\s+/).at(-1).trim());
    }
  }
  for (const match of dts.matchAll(/export\s+(?:declare\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  return [...names].sort();
}

const OPEN = /^\s*```(ts|tsx|js|jsx|mjs|cjs)\s*$/;
const CLOSE = /^\s*```\s*$/;
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](@ironbird\/[^'"]+|ironbird)['"]/g;

/** `import { ... } from '@ironbird/...'` statements inside TypeScript and JavaScript fences, as `{ specifier, names, line }` (1-based line of the `import`). */
export function importsInMarkdown(text) {
  const lines = text.split('\n');
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!OPEN.test(lines[index])) continue;
    const start = index + 1;
    let end = start;
    while (end < lines.length && !CLOSE.test(lines[end])) end += 1;
    const code = lines.slice(start, end).join('\n');
    for (const match of code.matchAll(IMPORT)) {
      const names = match[1]
        .split(',')
        .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      found.push({ specifier: match[2], names, line: start + 1 + (code.slice(0, match.index).split('\n').length - 1) });
    }
    index = end;
  }
  return found;
}

/**
 * The declaration file a subpath (`.`, `./config`) of a manifest resolves to, or undefined. When an
 * `exports` map is present it decides what is importable: a subpath it leaves out is undefined even
 * if `types` names a file. Top-level `types` only fills in for an exported (or export-less) `.`.
 */
export function declarationFile(manifest, subpath) {
  const { exports } = manifest;
  if (exports === undefined || exports === null) return subpath === '.' ? manifest.types : undefined;
  const sugar = typeof exports === 'string' || Object.keys(exports).every((key) => !key.startsWith('.'));
  const entry = sugar ? (subpath === '.' ? exports : undefined) : exports[subpath];
  if (entry === undefined || entry === null) return undefined;
  const types = typeof entry === 'object' ? (entry.import?.types ?? entry.types ?? entry.require?.types) : undefined;
  return types ?? (subpath === '.' ? manifest.types : undefined);
}

/** `{ dir, types }` for a specifier such as `@ironbird/cli/config`, among `packages` (`{ dir, manifest }`), or undefined. */
export function resolveSpecifier(specifier, packages) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const rest = specifier.slice(name.length);
  const found = packages.find((candidate) => candidate.manifest.name === name);
  if (!found) return undefined;
  const types = declarationFile(found.manifest, rest === '' ? '.' : `.${rest}`);
  return types ? { dir: found.dir, types } : undefined;
}

/** The docs whose imports are checked: the README, each package's README, and docs/ except design plans and eval records. */
export function isCheckedDoc(rel) {
  if (rel === 'README.md' || /^packages\/[^/]+\/README\.md$/.test(rel)) return true;
  return rel.startsWith('docs/') && rel.endsWith('.md') && !rel.startsWith('docs/superpowers/') && !rel.startsWith('docs/evals/');
}
