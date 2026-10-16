import { describe, expect, it } from 'vitest';
import { entryFile, ironbirdMentions, isSourceFile, isTextFile, shouldCopy, standaloneProblems, startBridgeCallers } from './project.mjs';

describe('copying the exercise', () => {
  it('skips dependencies, native build output, pods, git, ironbird artifacts, build/, and vendor/', () => {
    for (const rel of ['', 'App.tsx', 'src/store.ts', 'ios/App/AppDelegate.swift', 'android/app/src/main/AndroidManifest.xml', 'TASK.md']) expect(shouldCopy(rel)).toBe(true);
    for (const rel of ['node_modules', 'node_modules/react/index.js', 'ios/Pods', 'ios/build/x', 'android/build/x', 'android/app/build/x', '.git/HEAD', '.ironbird/runs', 'build/main.jsbundle', 'vendor/x.tgz']) expect(shouldCopy(rel)).toBe(false);
  });

  it('treats images, fonts, and archives as binary', () => {
    expect(isTextFile('App.tsx')).toBe(true);
    expect(isTextFile('.gitignore')).toBe(true);
    for (const rel of ['assets/logo.png', 'fonts/a.ttf', 'android/gradle/wrapper/gradle-wrapper.jar', 'vendor/a.tgz']) expect(isTextFile(rel)).toBe(false);
  });
});

describe('standaloneProblems', () => {
  it('names monorepo-only ranges, a tsconfig that extends outside the folder, and a .gitignore without node_modules', () => {
    const manifest = { dependencies: { a: 'workspace:*', b: '^1.0.0' }, devDependencies: { c: 'file:../c', d: 'file:vendor/d.tgz', e: 'link:../e' } };
    expect(standaloneProblems({ manifest, tsconfig: { extends: '../../tsconfig.base.json' }, gitignore: 'build/\n' })).toEqual([
      'package.json dependencies.a is workspace:*, which only resolves inside the monorepo',
      'package.json devDependencies.c is file:../c, which only resolves inside the monorepo',
      'package.json devDependencies.e is link:../e, which only resolves inside the monorepo',
      'tsconfig.json extends ../../tsconfig.base.json, outside the exercise folder',
      '.gitignore does not ignore node_modules',
    ]);
  });

  it('passes the community template shape', () => {
    expect(standaloneProblems({ manifest: { dependencies: { react: '19.2.3' } }, tsconfig: { extends: '@react-native/typescript-config' }, gitignore: '# deps\nnode_modules/\n' })).toEqual([]);
    expect(standaloneProblems({ manifest: {}, tsconfig: null, gitignore: 'node_modules\n' })).toEqual([]);
  });
});

describe('ironbirdMentions', () => {
  it('finds ironbird anywhere except the materials and vendor/', () => {
    const files = [
      { file: 'App.tsx', text: 'a\n// IronBird was here' },
      { file: 'TASK.md', text: 'ironbird' },
      { file: 'acceptance.yaml', text: 'ironbird' },
      { file: 'vendor/x/README.md', text: 'ironbird' },
      { file: '.gitignore', text: 'node_modules\n.ironbird/' },
    ];
    expect(ironbirdMentions(files)).toEqual([
      { file: 'App.tsx', line: 2, excerpt: '// IronBird was here' },
      { file: '.gitignore', line: 2, excerpt: '.ironbird/' },
    ]);
  });
});

describe('what the grader reads', () => {
  it('picks the entry file React Native bundles from', () => {
    expect(entryFile(['App.tsx', 'index.ts', 'index.js'])).toBe('index.js');
    expect(entryFile(['index.tsx'])).toBe('index.tsx');
    expect(entryFile(['App.tsx'])).toBeUndefined();
  });

  it('finds the source files that call startBridge from @ironbird/react-native', () => {
    const sources = [
      { file: 'src/ironbird/device.ts', text: "import { startBridge } from '@ironbird/react-native';\nexport const go = () => startBridge({ target });" },
      { file: 'src/other.ts', text: 'startBridge(x)' },
      { file: 'src/types.ts', text: "import type { BridgeOptions } from '@ironbird/react-native';" },
    ];
    expect(startBridgeCallers(sources)).toEqual(['src/ironbird/device.ts']);
    expect(isSourceFile('src/a.tsx')).toBe(true);
    expect(isSourceFile('src/a.json')).toBe(false);
  });

  it('does not count a commented-out call, a type-only import, or a call of something else named startBridge', () => {
    const sources = [
      { file: 'line-comment.ts', text: "import { startBridge } from '@ironbird/react-native';\n// startBridge({ target });" },
      { file: 'block-comment.ts', text: "import { startBridge } from '@ironbird/react-native';\n/*\n startBridge({ target });\n*/" },
      { file: 'type-only.ts', text: "import type { startBridge } from '@ironbird/react-native';\nstartBridge({ target });" },
      { file: 'type-specifier.ts', text: "import { type startBridge } from '@ironbird/react-native';\nstartBridge({ target });" },
      { file: 'renamed-away.ts', text: "import { startBridge as sb } from '@ironbird/react-native';\nstartBridge({ target });" },
      { file: 'member.ts', text: "import { startBridge } from '@ironbird/react-native';\nother.startBridge({ target });" },
      { file: 'url.ts', text: "import { startBridge } from '@ironbird/react-native';\nconst u = 'http://x'; // startBridge()" },
      { file: 'literal.ts', text: "import { startBridge } from '@ironbird/react-native';\nconst s = 'startBridge({ target })';\nconst t = \"x\"; const u = `startBridge()`;" },
      { file: 'template-comment.ts', text: "import { startBridge } from '@ironbird/react-native';\nconst s = `${/* startBridge() */ 1}`;\nconst t = `${1 // startBridge()\n}`;" },
      { file: 'other-module.ts', text: "import { startBridge } from './bridge';\nstartBridge({ target });" },
    ];
    expect(startBridgeCallers(sources)).toEqual([]);
  });

  it('counts a renamed import, a namespace import, and a require, called after a string with slashes', () => {
    const sources = [
      { file: 'renamed.ts', text: "import { type BridgeOptions, startBridge as sb } from '@ironbird/react-native';\nconst u = 'http://x';\nsb({ target });" },
      { file: 'namespace.ts', text: "import * as ib from '@ironbird/react-native';\nib.startBridge({ target });" },
      { file: 'index.js', text: "if (__DEV__) {\n  const { startBridge } = require('@ironbird/react-native');\n  startBridge({ target });\n}" },
      { file: 'require-renamed.js', text: "const { startBridge: go } = require('@ironbird/react-native');\ngo({ target });" },
      { file: 'required.js', text: "const rn = require('@ironbird/react-native');\nrn.startBridge({ target });" },
      { file: 'require-inline.js', text: "require('@ironbird/react-native').startBridge({ target });" },
      { file: 'dynamic.tsx', text: "export async function go() {\n  const { startBridge } = await import('@ironbird/react-native');\n  startBridge({ target });\n  return <View />;\n}" },
    ];
    expect(startBridgeCallers(sources)).toEqual(['dynamic.tsx', 'index.js', 'namespace.ts', 'renamed.ts', 'require-inline.js', 'require-renamed.js', 'required.js']);
  });
});
