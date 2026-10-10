import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MATERIAL_FILES, diffTrees, findLeaks, generateExercise, isIncluded, listExampleFiles, snapshotTree, transformPackageJson, transformSource, walkFiles } from './exercise.mjs';

const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lines = (...parts) => parts.join('\n');

const made = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-exercise-test-'));
  made.push(dir);
  return dir;
}

describe('transformSource', () => {
  it('leaves a file without markers byte for byte, blank runs included', () => {
    const source = lines("import a from 'a';", '', '', 'a();', '');
    expect(transformSource(source, 'x.ts')).toBe(source);
  });

  it('removes a marked block and collapses the blank lines around it', () => {
    const source = lines("import a from 'a';", '', '// exercise:begin-remove', 'wire();', '// exercise:end', '', 'a();', '');
    expect(transformSource(source, 'x.ts')).toBe(lines("import a from 'a';", '', 'a();', ''));
  });

  it('writes an else branch uncommented, keeping indentation and turning "//" into a blank line', () => {
    const source = lines('const x = 1;', '  // exercise:begin-remove', '  wired();', '  // exercise:else', '  // plain();', '  //', '  // /** doc */', '  // exercise:end', '');
    expect(transformSource(source, 'x.ts')).toBe(lines('const x = 1;', '  plain();', '', '  /** doc */', ''));
  });

  it.each([
    ['a nested begin', lines('// exercise:begin-remove', '// exercise:begin-remove', '// exercise:end'), 'x.ts:2: // exercise:begin-remove inside a block opened at line 1'],
    ['an else without a begin', lines('// exercise:else'), 'x.ts:1: // exercise:else without // exercise:begin-remove'],
    ['a second else', lines('// exercise:begin-remove', '// exercise:else', '// exercise:else', '// exercise:end'), 'x.ts:3: // exercise:else without // exercise:begin-remove'],
    ['an end without a begin', lines('// exercise:end'), 'x.ts:1: // exercise:end without // exercise:begin-remove'],
    ['a block never closed', lines('a();', '// exercise:begin-remove', 'b();'), 'x.ts: the block opened at line 2 is never closed with // exercise:end'],
    ['an unknown marker', lines('// exercise:remove'), 'x.ts:1: unknown marker // exercise:remove'],
    ['an uncommented else line', lines('// exercise:begin-remove', '// exercise:else', 'plain();', '// exercise:end'), 'x.ts:3: a line in an else branch must start with "// " or be "//"'],
  ])('fails on %s, naming the file and line', (_label, source, message) => {
    expect(() => transformSource(source, 'x.ts')).toThrow(message);
  });
});

describe('transformPackageJson', () => {
  const wired = {
    name: '@ironbird-examples/bare-redux',
    private: true,
    license: 'MIT',
    version: '0.0.0',
    scripts: {
      android: 'react-native run-android',
      ios: 'react-native run-ios',
      start: 'react-native start',
      'bundle:release': 'mkdir -p build && react-native bundle --platform ios',
      'make:exercise': 'node scripts/make-exercise.mjs',
      typecheck: 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json',
      test: 'vitest run --project unit',
    },
    dependencies: { '@ironbird/core': 'workspace:*', '@ironbird/react-native': 'workspace:*', '@ironbird/redux': 'workspace:*', '@reduxjs/toolkit': '^2.13.0', react: '19.2.3', 'react-native': '0.87.1', zod: '^4.2.0' },
    devDependencies: { '@ironbird/cli': 'workspace:*', '@ironbird/testing': 'workspace:*', '@types/react': '~19.2.18' },
    engines: { node: '>= 22.11.0' },
  };

  it('drops ironbird and Zod, renames the app, keeps the app scripts, and adds TypeScript', () => {
    const result = JSON.parse(transformPackageJson(JSON.stringify(wired)));
    expect(Object.keys(result)).toEqual(['name', 'version', 'private', 'scripts', 'dependencies', 'devDependencies', 'engines']);
    expect(result).toEqual({
      name: 'bare-redux',
      version: '0.0.0',
      private: true,
      scripts: {
        android: 'react-native run-android',
        ios: 'react-native run-ios',
        start: 'react-native start',
        'bundle:release': 'mkdir -p build && react-native bundle --platform ios',
        typecheck: 'tsc --noEmit -p tsconfig.json',
      },
      dependencies: { '@reduxjs/toolkit': '^2.13.0', react: '19.2.3', 'react-native': '0.87.1' },
      devDependencies: { '@types/react': '~19.2.18', typescript: '^6.0.3' },
      engines: { node: '>= 22.11.0' },
    });
  });

  it('refuses an ironbird or workspace dependency it does not know how to drop', () => {
    const extra = { ...wired, dependencies: { ...wired.dependencies, '@ironbird/xstate': 'workspace:*' } };
    expect(() => transformPackageJson(JSON.stringify(extra))).toThrow('package.json: unexpected ironbird dependency @ironbird/xstate');
  });
});

describe('isIncluded', () => {
  it.each([
    ['App.tsx', true],
    ['src/store/todos.ts', true],
    ['src/app/instance.ts', true],
    ['ios/Podfile', true],
    ['.gitignore', true],
    ['src/ironbird/headless.ts', false],
    ['ironbird/scenarios/ack-reorder.yaml', false],
    ['ironbird.config.ts', false],
    ['test/cli.test.ts', false],
    ['src/store/todos.test.ts', false],
    ['src/test/manual-timers.ts', false],
    ['scripts/make-exercise.mjs', false],
    ['exercise/TASK.md', false],
    ['integration-exercise/App.tsx', false],
    ['eval/run.mjs', false],
    ['README.md', false],
    ['tsconfig.test.json', false],
  ])('%s → %s', (file, expected) => {
    expect(isIncluded(file)).toBe(expected);
  });
});

describe('findLeaks', () => {
  it('names every line that mentions ironbird, in any case, or an exercise marker', () => {
    const files = [
      { file: 'a.ts', text: lines('ok', 'import x from "@ironbird/core";', '') },
      { file: 'b.js', text: lines('// exercise:end', '// IronBird was here') },
      { file: 'c.md', text: 'clean' },
    ];
    expect(findLeaks(files)).toEqual(['a.ts:2: import x from "@ironbird/core";', 'b.js:1: // exercise:end', 'b.js:2: // IronBird was here']);
  });
});

describe('diffTrees', () => {
  it('lists missing, extra, changed, and re-moded files by path', () => {
    const entry = (hash, executable = false) => ({ hash, executable });
    const committed = new Map([
      ['a', entry('1')],
      ['b', entry('2')],
      ['c', entry('3')],
    ]);
    const generated = new Map([
      ['a', entry('1', true)],
      ['c', entry('4')],
      ['d', entry('5')],
    ]);
    expect(diffTrees(committed, generated)).toEqual(['a: executable bit differs', 'b: missing from the generated copy', 'c: content differs', 'd: not in the committed copy']);
  });
});

describe('generateExercise on this app', () => {
  it('writes the app without ironbird, with the exercise material and the template intact', async () => {
    const outDir = await tmp();
    const { files } = await generateExercise({ exampleDir, outDir });
    expect(files).toEqual(
      expect.arrayContaining(['App.tsx', 'index.js', 'metro.config.js', 'package.json', 'tsconfig.json', 'src/app/instance.ts', 'src/store/store.ts', 'src/sync/server.ts', 'src/sync/real-timers.ts', 'README.md', 'TASK.md', 'CHECKLIST.md', 'RESULTS.md', 'acceptance.yaml', 'ios/Podfile', 'android/gradlew']),
    );
    expect(files.filter((file) => /ironbird|\.test\.|^test\/|^scripts\/|^exercise\//.test(file))).toEqual([]);
    // exercise/ is the material's single source: each copy is byte for byte its source.
    for (const file of ['README.md', ...MATERIAL_FILES]) {
      expect(await readFile(path.join(outDir, file)), file).toEqual(await readFile(path.join(exampleDir, 'exercise', file)));
    }

    // Rule 9 in the exercise too: the store's simulated server gets an injected real clock, and the
    // platform timer is called only inside that clock's implementation.
    const instance = await readFile(path.join(outDir, 'src/app/instance.ts'), 'utf8');
    expect(instance).toContain('createSimulatedServer(createRealTimers())');
    expect(instance).not.toMatch(/ironbird|__DEV__|setTimeout/i);
    const timers = await readFile(path.join(outDir, 'src/sync/real-timers.ts'), 'utf8');
    expect(timers).toContain('return { setTimeout: (callback, ms) => setTimeout(callback, ms) };');
    expect(timers).not.toMatch(/ironbird/i);
    const appCode = files.filter((file) => file === 'App.tsx' || file === 'index.js' || /^src\/.*\.tsx?$/.test(file));
    const callsPlatformTimer = [];
    for (const file of appCode) {
      if (/(?<![.\w])(?:setTimeout|setInterval)\(/.test(await readFile(path.join(outDir, file), 'utf8'))) callsPlatformTimer.push(file);
    }
    expect(callsPlatformTimer).toEqual(['src/sync/real-timers.ts']);
    const index = await readFile(path.join(outDir, 'index.js'), 'utf8');
    expect(index).not.toContain('__DEV__');
    expect(index).toContain('AppRegistry.registerComponent(appName, () => App);');
    const metro = await readFile(path.join(outDir, 'metro.config.js'), 'utf8');
    expect(metro).toContain('const config = {};');
    expect(metro).not.toContain('watchFolders');
    expect(JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8')).dependencies).not.toHaveProperty('zod');
    expect((await stat(path.join(outDir, 'android/gradlew'))).mode & 0o111).not.toBe(0);
  }, 60_000);

  it('matches the committed integration-exercise byte for byte', async () => {
    const outDir = await tmp();
    await generateExercise({ exampleDir, outDir });
    const committedDir = path.join(exampleDir, 'integration-exercise');
    const committed = await snapshotTree(committedDir, listExampleFiles(committedDir));
    const generated = await snapshotTree(outDir, await walkFiles(outDir));
    expect(diffTrees(committed, generated), 'integration-exercise is stale: run `pnpm --filter @ironbird-examples/bare-redux make:exercise` and commit the result').toEqual([]);
  }, 60_000);
});
