import { IronbirdError, messageOf } from '@ironbird/core';
import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LoadModuleOptions {
  /** Directory for the emitted bundle; keep it inside the app so bare imports resolve from the app's node_modules. */
  outDir: string;
  label: string;
  /** Bare specifiers that must not appear anywhere in the graph, such as 'react-native'. */
  forbidden?: string[];
  /** Bare specifier → JavaScript source that replaces it, used for '@ironbird/cli/config'. */
  shims?: Record<string, string>;
  /**
   * Error code for a load failure. Defaults to `HEADLESS_LOAD_FAILED`; config loading passes
   * `INVALID_CONFIG` so a config file that fails to bundle reports the code and `{ file, issues }`
   * details that docs/protocol.md §6 promises for a bad `ironbird.config.ts`.
   */
  errorCode?: 'HEADLESS_LOAD_FAILED' | 'INVALID_CONFIG';
}

const matchesForbidden = (specifier: string, forbidden: string[]): boolean =>
  forbidden.some((name) => specifier === name || specifier.startsWith(`${name}/`));

export function findImportChain(metafile: esbuild.Metafile, entryInput: string, forbidden: string[]): string[] | undefined {
  const parents = new Map<string, string>();
  const queue = [entryInput];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const input = metafile.inputs[current];
    if (!input) continue;
    for (const imported of input.imports) {
      if (imported.external && matchesForbidden(imported.path, forbidden)) {
        const chain = [imported.path];
        for (let node: string | undefined = current; node !== undefined; node = parents.get(node)) chain.unshift(node);
        return chain;
      }
      if (!imported.external && !seen.has(imported.path)) {
        seen.add(imported.path);
        parents.set(imported.path, current);
        queue.push(imported.path);
      }
    }
  }
  return undefined;
}

function shimPlugin(shims: Record<string, string>): esbuild.Plugin {
  return {
    name: 'ironbird-shims',
    setup(build) {
      const names = Object.keys(shims);
      if (names.length === 0) return;
      const filter = new RegExp(`^(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'ironbird-shim' }));
      build.onLoad({ filter: /.*/, namespace: 'ironbird-shim' }, (args) => ({ contents: shims[args.path] ?? '', loader: 'js' }));
    },
  };
}

let loadSequence = 0;

/**
 * Bundles `entryPath` with esbuild and imports the result as a fresh ES module.
 *
 * Each call evaluates a fresh module instance that Node keeps for the life of the process;
 * callers load an entry once per process (the daemon does this at start, and `reset` re-runs
 * the factory without reloading).
 */
export async function loadTypeScriptModule(entryPath: string, options: LoadModuleOptions): Promise<{ exports: Record<string, unknown>; bundlePath: string }> {
  const { outDir, label, forbidden = [], shims = {}, errorCode = 'HEADLESS_LOAD_FAILED' } = options;
  const entry = path.resolve(entryPath);
  const absWorkingDir = path.dirname(entry);
  await mkdir(outDir, { recursive: true });
  const bundlePath = path.join(outDir, `${label}.mjs`);
  // `basename`, not a cwd-relative path: the daemon's cwd is not the caller's, so a relative path
  // can walk out of the tree entirely (`../../../app/ironbird.config.ts`) and read as noise.
  const fail = (message: string, extra: Record<string, unknown> = {}): IronbirdError => {
    const text = `Failed to load ${path.basename(entry)}: ${message}`;
    if (errorCode === 'INVALID_CONFIG') return new IronbirdError('INVALID_CONFIG', text, { file: entry, issues: [{ path: [], message }] });
    return new IronbirdError('HEADLESS_LOAD_FAILED', text, { entry, message, ...extra });
  };

  let result: esbuild.BuildResult<{ metafile: true }>;
  try {
    result = await esbuild.build({
      entryPoints: [entry],
      absWorkingDir,
      outfile: bundlePath,
      bundle: true,
      write: true,
      metafile: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      sourcemap: 'inline',
      logLevel: 'silent',
      plugins: [shimPlugin(shims)],
    });
  } catch (error) {
    const first = (error as { errors?: Array<{ text: string; location?: { file: string; line: number } | null }> }).errors?.[0];
    const where = first?.location ? ` (${first.location.file}:${first.location.line})` : '';
    throw fail(first ? `${first.text}${where}` : messageOf(error));
  }

  const entryInput = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint)?.[1].entryPoint ?? path.relative(absWorkingDir, entry);
  const importChain = findImportChain(result.metafile, entryInput, forbidden);
  if (importChain) {
    const offender = importChain[importChain.length - 1] as string;
    throw fail(`${offender} is imported in the headless graph`, { importChain });
  }

  try {
    const exports = (await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}-${++loadSequence}`)) as Record<string, unknown>;
    return { exports, bundlePath };
  } catch (error) {
    throw fail(messageOf(error));
  }
}
