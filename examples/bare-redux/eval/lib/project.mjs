// Reading the exercise and an integrated project (M5 design D11): what prepare copies, the audits
// that keep the exercise honest and standalone, and what the grader needs to find in a project.
import ts from 'typescript';
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

const BRIDGE_MODULE = '@ironbird/react-native';

const SCRIPT_KINDS = { '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX };

function scriptKind(file) {
  const ext = /\.[^./]+$/.exec(file)?.[0] ?? '';
  return SCRIPT_KINDS[ext] ?? ts.ScriptKind.JS;
}

/** `node` with parentheses, `await`, and non-null assertions taken off. */
function unwrap(node) {
  let inner = node;
  while (ts.isParenthesizedExpression(inner) || ts.isAwaitExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  return inner;
}

/** Whether `node` is `require('@ironbird/react-native')` or `import('@ironbird/react-native')`, awaited or not. */
function isBridgeLoad(node) {
  const call = unwrap(node);
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return false;
  const [specifier] = call.arguments;
  const callee = call.expression;
  const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
  return loads && ts.isStringLiteralLike(specifier) && specifier.text === BRIDGE_MODULE;
}

/** The local names `startBridge` is bound to, and the names the whole module is bound to, by value imports, requires, and dynamic imports of @ironbird/react-native. */
function bridgeBindings(source) {
  const names = new Set();
  const namespaces = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === BRIDGE_MODULE) {
      const clause = node.importClause;
      const bindings = clause && !clause.isTypeOnly ? clause.namedBindings : undefined;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'startBridge') names.add(element.name.text);
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer && isBridgeLoad(node.initializer)) {
      if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (!element.dotDotDotToken && ts.isIdentifier(property) && property.text === 'startBridge' && ts.isIdentifier(element.name)) names.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, namespaces };
}

/** Whether some call in `source` invokes startBridge through one of `bindings`: `startBridge(`, a renamed binding, `ns.startBridge(`, or `require(...).startBridge(`. */
function callsBridge(source, { names, namespaces }) {
  const invokes = (callee) => {
    const target = unwrap(callee);
    if (ts.isIdentifier(target)) return names.has(target.text);
    if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'startBridge') return false;
    const owner = unwrap(target.expression);
    return (ts.isIdentifier(owner) && namespaces.has(owner.text)) || isBridgeLoad(owner);
  };
  const visit = (node) => (ts.isCallExpression(node) && invokes(node.expression)) || ts.forEachChild(node, visit) === true;
  return visit(source);
}

/**
 * Source files (`{ file, text }`) that call startBridge as imported from @ironbird/react-native, sorted.
 * Each file is parsed with the TypeScript compiler, so comments and strings never count, type-only
 * imports bind nothing, and the call must use a binding of the module. Shadowing is not tracked.
 */
export function startBridgeCallers(sources) {
  return sources
    .filter(({ file, text }) => {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
      return callsBridge(source, bridgeBindings(source));
    })
    .map(({ file }) => file)
    .sort();
}
