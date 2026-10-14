// Reading the exercise and an integrated project (M5 design D11): what prepare copies, the audits
// that keep the exercise honest and standalone, and what the grader needs to find in a project.
import { MATERIALS } from './paths.mjs';

/** Folders never copied into the template: dependencies, git, native build output and pods, ironbird's artifacts, build output, and vendor/ (prepare packs it fresh). */
export const COPY_SKIP = ['node_modules', '.git', '.ironbird', 'build', 'vendor', 'ios/Pods', 'ios/build', 'android/build', 'android/app/build'];

/** Whether prepare copies the exercise path `rel` (relative, forward slashes; '' is the folder itself). */
export function shouldCopy(rel) {
  return !COPY_SKIP.some((skip) => rel === skip || rel.startsWith(`${skip}/`));
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|ttf|otf|woff2?|jar|keystore|zip|tgz|gz|pdf|mp4|mov)$/i;

export function isTextFile(rel) {
  return !BINARY.test(rel);
}

/** Why the exercise would not install and build outside the monorepo. `tsconfig` may be null (absent or not plain JSON); `gitignore` is the text of .gitignore, or '' when there is none. */
export function standaloneProblems({ manifest, tsconfig, gitignore }) {
  const problems = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest?.[field] ?? {})) {
      const text = String(range);
      if (/^(workspace|link|portal):/.test(text) || /^file:\.\.\//.test(text)) problems.push(`package.json ${field}.${name} is ${text}, which only resolves inside the monorepo`);
    }
  }
  for (const base of [tsconfig?.extends].flat().filter(Boolean)) {
    if (String(base).startsWith('..')) problems.push(`tsconfig.json extends ${base}, outside the exercise folder`);
  }
  if (!/^\/?node_modules\/?\s*$/m.test(gitignore)) problems.push('.gitignore does not ignore node_modules');
  return problems;
}

/** Lines that name ironbird (any case) in exercise files other than the materials and vendor/: the exercise must not hint at the wiring. */
export function ironbirdMentions(files) {
  const found = [];
  for (const { file, text } of files) {
    if (MATERIALS.includes(file) || file.startsWith('vendor/')) continue;
    text.split('\n').forEach((line, index) => {
      if (/ironbird/i.test(line)) found.push({ file, line: index + 1, excerpt: line.trim().slice(0, 160) });
    });
  }
  return found;
}

/** Folders the grader never searches for the app's JavaScript. */
export const SOURCE_SKIP = new Set(['node_modules', '.git', '.ironbird', 'vendor', 'build', 'ios', 'android', 'dist', '.expo']);

export function isSourceFile(rel) {
  return /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(rel);
}

/** The entry React Native bundles from, among the project's top-level files, or undefined. */
export function entryFile(rootFiles) {
  return ['index.js', 'index.ts', 'index.tsx', 'index.jsx'].find((name) => rootFiles.includes(name));
}

/** Source files (`{ file, text }`) that import from @ironbird/react-native and call startBridge, sorted. */
export function startBridgeCallers(sources) {
  return sources
    .filter(({ text }) => /['"]@ironbird\/react-native['"]/.test(text) && /\bstartBridge\s*\(/.test(text))
    .map(({ file }) => file)
    .sort();
}
