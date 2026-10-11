import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { declarationFile, exportedNames, importsInMarkdown, isCheckedDoc, resolveSpecifier } from './doc-imports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('exportedNames', () => {
  it('reads tsup export statements, dropping type prefixes and taking aliases', () => {
    const dts = 'declare function startBridge(): void;\nexport declare function extra(): void;\nexport { BRIDGE_MARKER, type BridgeHandle, startBridge, x as y };\n';
    expect(exportedNames(dts)).toEqual(['BRIDGE_MARKER', 'BridgeHandle', 'extra', 'startBridge', 'y']);
  });
});

describe('importsInMarkdown', () => {
  it('finds named imports of ironbird packages in code fences, with their line, including indented and multi-line ones', () => {
    const md = [
      '# Title',
      '',
      '```ts',
      "import { a, type B } from '@ironbird/core';",
      "import { z } from 'zod';",
      '```',
      '',
      '   ```tsx',
      '   import {',
      '     startBridge as start,',
      "   } from '@ironbird/react-native';",
      '   ```',
      '```sh',
      "import { no } from '@ironbird/core'",
      '```',
    ].join('\n');
    expect(importsInMarkdown(md)).toEqual([
      { specifier: '@ironbird/core', names: ['a', 'B'], line: 4 },
      { specifier: '@ironbird/react-native', names: ['startBridge'], line: 9 },
    ]);
  });
});

describe('resolving a specifier to its declarations', () => {
  const packages = [
    { dir: '/r/packages/cli', manifest: { name: '@ironbird/cli', exports: { '.': { import: { types: './dist/index.d.ts' } }, './config': { import: { types: './dist/config-entry.d.ts' } } } } },
    { dir: '/r/packages/core', manifest: { name: '@ironbird/core', types: './dist/index.d.ts' } },
  ];

  it('follows exports subpaths, falls back to types for the main entry, and returns undefined otherwise', () => {
    expect(resolveSpecifier('@ironbird/cli/config', packages)).toEqual({ dir: '/r/packages/cli', types: './dist/config-entry.d.ts' });
    expect(resolveSpecifier('@ironbird/core', packages)).toEqual({ dir: '/r/packages/core', types: './dist/index.d.ts' });
    expect(resolveSpecifier('@ironbird/cli/nope', packages)).toBeUndefined();
    expect(resolveSpecifier('@ironbird/mobx', packages)).toBeUndefined();
    expect(declarationFile({ exports: { '.': { require: { types: './x.d.cts' } } } }, '.')).toBe('./x.d.cts');
  });

  it('does not fall back to types for a subpath an exports map leaves out', () => {
    const configOnly = { types: './dist/index.d.ts', exports: { './config': { import: { types: './dist/config.d.ts' } } } };
    expect(declarationFile(configOnly, '.')).toBeUndefined();
    expect(declarationFile(configOnly, './config')).toBe('./dist/config.d.ts');
    expect(resolveSpecifier('@ironbird/x', [{ dir: '/r/packages/x', manifest: { name: '@ironbird/x', ...configOnly } }])).toBeUndefined();
    expect(declarationFile({ types: './dist/index.d.ts', exports: { '.': './dist/index.js' } }, '.')).toBe('./dist/index.d.ts');
    expect(declarationFile({ types: './dist/index.d.ts', exports: './dist/index.js' }, '.')).toBe('./dist/index.d.ts');
    expect(declarationFile({ types: './dist/index.d.ts', exports: './dist/index.js' }, './config')).toBeUndefined();
    expect(declarationFile({ types: './dist/index.d.ts', exports: {} }, '.')).toBeUndefined();
    expect(declarationFile({ types: './dist/index.d.ts', exports: {} }, './config')).toBeUndefined();
  });

  it('checks the README, package READMEs, and docs, but not design plans or eval records', () => {
    expect(['README.md', 'packages/redux/README.md', 'docs/api.md', 'docs/guides/getting-started.md', 'docs/superpowers/plans/x.md', 'docs/evals/m5.md', 'AGENTS.md', 'docs/a.png'].filter(isCheckedDoc)).toEqual([
      'README.md',
      'packages/redux/README.md',
      'docs/api.md',
      'docs/guides/getting-started.md',
    ]);
  });
});

async function walk(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full, base)));
    else found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

describe('the docs (run pnpm build first)', () => {
  it('import only names the built packages export', async () => {
    const packageDirs = (await readdir(path.join(root, 'packages'), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const packages = await Promise.all(packageDirs.map(async (entry) => ({ dir: path.join(root, 'packages', entry.name), manifest: JSON.parse(await readFile(path.join(root, 'packages', entry.name, 'package.json'), 'utf8')) })));
    const files = ['README.md', ...packageDirs.map((entry) => `packages/${entry.name}/README.md`), ...(await walk(path.join(root, 'docs'))).map((file) => `docs/${file}`)].filter(isCheckedDoc);
    const problems = [];
    for (const file of files) {
      if (!(await stat(path.join(root, file)).catch(() => null))) continue;
      for (const found of importsInMarkdown(await readFile(path.join(root, file), 'utf8'))) {
        const target = resolveSpecifier(found.specifier, packages);
        if (!target) {
          problems.push(`${file}:${found.line}: ${found.specifier} is not an entry of a workspace package`);
          continue;
        }
        const declarations = path.join(target.dir, target.types);
        const text = await readFile(declarations, 'utf8').catch(() => undefined);
        if (text === undefined) {
          problems.push(`${file}:${found.line}: ${path.relative(root, declarations)} is missing; run pnpm build first`);
          continue;
        }
        const names = exportedNames(text);
        for (const name of found.names) if (!names.includes(name)) problems.push(`${file}:${found.line}: ${found.specifier} does not export ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
