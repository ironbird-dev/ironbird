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

/**
 * `text` with its line and block comments blanked out, leaving string and template literals intact so
 * a `//` inside a URL is not taken for a comment. Regular expression literals are not recognised; the
 * grader reads app entry code, where that is good enough.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== char) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

const BRIDGE_MODULE = String.raw`['"]@ironbird/react-native['"]`;
const escape = (name) => name.replace(/\$/g, '\\$');

/** The local names that `startBridge` is bound to, and the namespaces it can be reached through, by value imports and requires of @ironbird/react-native in comment-free `code`. */
function bridgeBindings(code) {
  const names = new Set();
  const namespaces = new Set();
  for (const [, typeOnly, clause] of code.matchAll(new RegExp(String.raw`\bimport\s+(type\s+)?([^'";]*?)\s*from\s*${BRIDGE_MODULE}`, 'g'))) {
    if (typeOnly) continue;
    const namespace = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (namespace) namespaces.add(namespace[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    for (const spec of named ? named[1].split(',') : []) {
      const match = /^\s*(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(spec);
      if (match && !match[1] && match[2] === 'startBridge') names.add(match[3] ?? match[2]);
    }
  }
  const loaded = String.raw`=\s*(?:await\s+)?(?:require|import)\s*\(\s*${BRIDGE_MODULE}\s*\)`;
  for (const [, specs] of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*${loaded}`, 'g'))) {
    for (const spec of specs.split(',')) {
      const match = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/.exec(spec);
      if (match && match[1] === 'startBridge') names.add(match[2] ?? match[1]);
    }
  }
  for (const [, name] of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([\w$]+)\s*${loaded}`, 'g'))) namespaces.add(name);
  return { names, namespaces };
}

/**
 * Source files (`{ file, text }`) that call startBridge as imported from @ironbird/react-native, sorted:
 * comments are ignored, type-only imports bind nothing, and the call must use the imported binding
 * (renamed, `ns.startBridge(` through a namespace import, or a `require` of the module).
 */
export function startBridgeCallers(sources) {
  return sources
    .filter(({ text }) => {
      const code = stripComments(text);
      const { names, namespaces } = bridgeBindings(code);
      const calls = [...[...names].map((name) => `${escape(name)}\\s*\\(`), ...[...namespaces].map((ns) => `${escape(ns)}\\s*\\??\\.\\s*startBridge\\s*\\(`)];
      return calls.some((call) => new RegExp(`(?<![\\w$.])${call}`).test(code));
    })
    .map(({ file }) => file)
    .sort();
}
