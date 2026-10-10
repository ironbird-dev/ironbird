// Generates examples/bare-redux/integration-exercise: this app with every ironbird file and line
// removed (M5 design D7), plus the exercise's README, task sheet, checklist, results sheet, and
// acceptance scenario, copied from exercise/, their single source. Lines that exist only for
// ironbird, or only because this app lives in the monorepo, sit between markers:
//
//   // exercise:begin-remove    removed, through the matching end marker
//   // exercise:else            optional: the lines up to the end marker are commented out here and
//                               written to the exercise uncommented ("// " stripped once; "//" alone
//                               becomes a blank line)
//   // exercise:end
//
// The copy is committed, and exercise.test.mjs regenerates it and compares, so the two can't drift.
// The comparison covers the material copies too: edit exercise/, never integration-exercise/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Paths, relative to the app, that never reach the exercise: ironbird, tests and their helpers
 * (src/test), tooling, and the material's sources.
 */
export const EXCLUDED_PATHS = ['integration-exercise', 'exercise', 'eval', 'scripts', 'test', 'src/test', 'ironbird', 'src/ironbird', 'ironbird.config.ts', 'tsconfig.test.json', 'README.md'];
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
const TRANSFORMED = new Set(['.js', '.ts', '.tsx']);

/**
 * The exercise's material: about ironbird, so exempt from the leak check, and the only exercise
 * files that may name it (plan 5's eval/lib/paths.mjs MATERIALS must equal this list).
 */
export const MATERIAL_FILES = ['TASK.md', 'CHECKLIST.md', 'RESULTS.md', 'acceptance.yaml'];

/**
 * Overlay sources in this app → path in the exercise. exercise/ is the single source of truth for
 * these files: change them there and regenerate, never in integration-exercise/. The app's README
 * is leak-checked like app code; the four materials are not.
 */
export const OVERLAY_FILES = Object.fromEntries(['README.md', ...MATERIAL_FILES].map((file) => [`exercise/${file}`, file]));

export const IRONBIRD_DEPENDENCIES = ['@ironbird/core', '@ironbird/react-native', '@ironbird/redux', 'zod'];
export const IRONBIRD_DEV_DEPENDENCIES = ['@ironbird/cli', '@ironbird/testing'];
export const KEPT_SCRIPTS = ['android', 'ios', 'start', 'bundle:release'];
/** The exercise is a standalone app, so it brings the TypeScript the 0.87 template declares. */
export const TYPESCRIPT_RANGE = '^6.0.3';

const BEGIN = '// exercise:begin-remove';
const ELSE = '// exercise:else';
const END = '// exercise:end';

export function isIncluded(file) {
  if (TEST_FILE.test(file)) return false;
  return !EXCLUDED_PATHS.some((excluded) => file === excluded || file.startsWith(`${excluded}/`));
}

export function transformSource(source, file) {
  const out = [];
  let state = 'keep';
  let openedAt = 0;
  let marked = false;
  source.split('\n').forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    const trimmed = line.trim();
    if (trimmed === BEGIN) {
      if (state !== 'keep') throw new Error(`${where}: ${BEGIN} inside a block opened at line ${openedAt}`);
      state = 'remove';
      openedAt = index + 1;
      marked = true;
      return;
    }
    if (trimmed === ELSE) {
      if (state !== 'remove') throw new Error(`${where}: ${ELSE} without ${BEGIN}`);
      state = 'else';
      return;
    }
    if (trimmed === END) {
      if (state === 'keep') throw new Error(`${where}: ${END} without ${BEGIN}`);
      state = 'keep';
      return;
    }
    if (trimmed.startsWith('// exercise:')) throw new Error(`${where}: unknown marker ${trimmed}`);
    if (state === 'remove') return;
    if (state === 'else') {
      const indent = /^\s*/.exec(line)[0];
      const rest = line.slice(indent.length);
      if (rest === '//') out.push('');
      else if (rest.startsWith('// ')) out.push(indent + rest.slice(3));
      else throw new Error(`${where}: a line in an else branch must start with "// " or be "//"`);
      return;
    }
    out.push(line);
  });
  if (state !== 'keep') throw new Error(`${file}: the block opened at line ${openedAt} is never closed with ${END}`);
  const result = out.join('\n');
  // Removing a block leaves the blank lines that framed it; one is enough.
  return marked ? result.replace(/\n{3,}/g, '\n\n') : result;
}

function withoutDependencies(dependencies = {}, drop) {
  const kept = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (drop.includes(name)) continue;
    if (name.startsWith('@ironbird/') || String(range).startsWith('workspace:')) {
      throw new Error(`package.json: unexpected ironbird dependency ${name}; add it to the generator's dependency lists or remove it`);
    }
    kept[name] = range;
  }
  return kept;
}

export function transformPackageJson(source) {
  const pkg = JSON.parse(source);
  const scripts = {};
  for (const name of KEPT_SCRIPTS) {
    if (pkg.scripts?.[name] === undefined) throw new Error(`package.json: the exercise needs the script ${name}`);
    scripts[name] = pkg.scripts[name];
  }
  scripts.typecheck = 'tsc --noEmit -p tsconfig.json';
  const devDependencies = { ...withoutDependencies(pkg.devDependencies, IRONBIRD_DEV_DEPENDENCIES), typescript: TYPESCRIPT_RANGE };
  const result = {
    name: 'bare-redux',
    version: pkg.version,
    private: true,
    scripts,
    dependencies: withoutDependencies(pkg.dependencies, IRONBIRD_DEPENDENCIES),
    devDependencies: Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    engines: pkg.engines,
  };
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** Lines that still mention ironbird, in any case, or an exercise marker, as `file:line: text`. */
export function findLeaks(files) {
  const leaks = [];
  for (const { file, text } of files) {
    text.split('\n').forEach((line, index) => {
      if (/ironbird|exercise:/i.test(line)) leaks.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return leaks;
}

/**
 * Files under `dir` that git tracks or would track (ignored files left out), relative to `dir`,
 * sorted. A missing `dir` has none, so a copy never generated shows up as files to add.
 */
export function listExampleFiles(dir) {
  if (!existsSync(dir)) return [];
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output
    .split('\0')
    .filter((file) => file !== '' && existsSync(path.join(dir, file)))
    .sort();
}

/** Every file under `dir`, relative to it with forward slashes, sorted. */
export async function walkFiles(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full, base)));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

export async function generateExercise({ exampleDir, outDir }) {
  const written = [];
  const put = async (relative, content, mode) => {
    const target = path.join(outDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    await chmod(target, mode);
    written.push(relative);
  };

  for (const file of listExampleFiles(exampleDir).filter(isIncluded)) {
    const source = path.join(exampleDir, file);
    const mode = (await stat(source)).mode & 0o777;
    const bytes = await readFile(source);
    if (file === 'package.json') await put(file, transformPackageJson(bytes.toString('utf8')), mode);
    else if (TRANSFORMED.has(path.extname(file))) await put(file, transformSource(bytes.toString('utf8'), file), mode);
    else await put(file, bytes, mode);
  }
  for (const [from, to] of Object.entries(OVERLAY_FILES)) {
    const source = path.join(exampleDir, from);
    await put(to, await readFile(source), (await stat(source)).mode & 0o777);
  }

  const exempt = new Set(MATERIAL_FILES);
  const texts = [];
  for (const file of written) {
    if (exempt.has(file)) continue;
    const bytes = await readFile(path.join(outDir, file));
    if (!bytes.subarray(0, 8_000).includes(0)) texts.push({ file, text: bytes.toString('utf8') });
  }
  const leaks = findLeaks(texts);
  if (leaks.length > 0) throw new Error(`The exercise copy still mentions ironbird or an exercise marker:\n${leaks.join('\n')}`);
  return { files: written.sort() };
}

/** Content hash and executable bit of each file, keyed by its relative path. */
export async function snapshotTree(dir, files) {
  const tree = new Map();
  for (const file of files) {
    const full = path.join(dir, file);
    const hash = createHash('sha256').update(await readFile(full)).digest('hex');
    tree.set(file, { hash, executable: ((await stat(full)).mode & 0o111) !== 0 });
  }
  return tree;
}

/** What differs between the committed copy and a fresh one, one line per path, sorted by path. */
export function diffTrees(committed, generated) {
  const problems = [];
  for (const file of [...new Set([...committed.keys(), ...generated.keys()])].sort()) {
    const before = committed.get(file);
    const after = generated.get(file);
    if (!after) problems.push(`${file}: missing from the generated copy`);
    else if (!before) problems.push(`${file}: not in the committed copy`);
    else if (before.hash !== after.hash) problems.push(`${file}: content differs`);
    else if (before.executable !== after.executable) problems.push(`${file}: executable bit differs`);
  }
  return problems;
}
