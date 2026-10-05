import { IronbirdError, isHeadlessDefinition, isIronbirdError, messageOf } from '@ironbird/core';
import { access, mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { loadTypeScriptModule } from '../bundle';
import { defaultConfig, findConfigFile, loadConfig, type ResolvedConfig } from '../config';
import { SKIPPED_DETAIL, SKIPPED_FIX, failCheck, oneLine, passCheck, type DoctorCheck } from './checks';

export const CONFIG_DOCS_URL = 'https://github.com/ironbird-dev/ironbird/blob/main/docs/api.md#defineconfig-p0';

const HEADLESS_CHAIN_FIX = 'Headless code runs in Node, so nothing it imports may import react-native: move that import out of this chain, for example behind a port with a fake';

/** What the later checks may use: the loaded config, the defaults when there is no config file, or only the project root when the config couldn't be loaded. */
export type ConfigOutcome = { status: 'loaded'; rootDir: string; config: ResolvedConfig } | { status: 'missing'; rootDir: string; config: ResolvedConfig } | { status: 'invalid'; rootDir: string };

export interface ProjectChecks {
  config: DoctorCheck;
  headless: DoctorCheck;
  outcome: ConfigOutcome;
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

type RemoveDir = (dir: string) => Promise<void>;

const removeRecursively: RemoveDir = (dir) => rm(dir, { recursive: true, force: true });

interface Scratch {
  dir: string;
  remove(): Promise<void>;
}

/**
 * A fresh directory under `<rootDir>/.ironbird/` for this run's bundles. It sits beside the daemon's
 * `.ironbird/cache`, so bare imports in the emitted bundles resolve from the same `node_modules`
 * (esbuild leaves packages external), but it is never `.ironbird/cache` itself, which a running
 * daemon owns (M5 design §6). `remove` deletes it, and `.ironbird/` as well when this run created
 * it, using `rmdir` so a directory something else has written into since is left alone. A failure
 * to delete the scratch directory is an internal fault, not a failed check: it throws.
 */
async function createScratch(rootDir: string, removeDir: RemoveDir): Promise<Scratch> {
  const parent = path.join(rootDir, '.ironbird');
  const created = await mkdir(parent, { recursive: true });
  const removeParent = async (): Promise<void> => {
    if (created !== undefined) await rmdir(parent).catch(() => undefined);
  };
  let dir: string;
  try {
    dir = await mkdtemp(path.join(parent, 'doctor-'));
  } catch (error) {
    await removeParent();
    throw error;
  }
  return {
    dir,
    async remove() {
      let failure: unknown;
      try {
        await removeDir(dir);
      } catch (error) {
        failure = error;
      }
      await removeParent();
      if (failure !== undefined) {
        const message = messageOf(failure);
        throw new IronbirdError('INTERNAL', `Could not remove doctor scratch directory ${dir}: ${message}`, { dir, message });
      }
    },
  };
}

function missingConfig(cwd: string, file: string | undefined): DoctorCheck {
  const target = file ?? path.join(cwd, 'ironbird.config.ts');
  const detail = file === undefined ? `No ironbird.config.ts in ${oneLine(cwd)} or any directory above it` : `${oneLine(path.relative(cwd, file))} does not exist`;
  return failCheck('config', true, detail, `Create ${target} that default-exports defineConfig({ appId: '<your app id>' }) from @ironbird/cli/config; see ${CONFIG_DOCS_URL}`);
}

/** The `INVALID_CONFIG` issues as `path: message`, joined with `; `, else the error's message. */
function issuesOf(error: unknown): string {
  if (isIronbirdError(error) && error.code === 'INVALID_CONFIG') {
    const issues = (error.details as { issues?: unknown } | undefined)?.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .map((issue: { path?: unknown; message?: unknown }) => {
          const at = Array.isArray(issue.path) ? issue.path.map(String).join('.') : '';
          const message = String(issue.message);
          return at === '' ? message : `${at}: ${message}`;
        })
        .join('; ');
    }
  }
  return messageOf(error);
}

/**
 * Loads the headless entry the way `ironbird serve` does, with `react-native` forbidden, and checks
 * its default export. Loading runs the module's top-level code; `create` is never called.
 */
async function checkHeadless(config: ResolvedConfig, cwd: string, scratchDir: string): Promise<DoctorCheck> {
  if (config.headlessPath === undefined) return passCheck('headless', true, 'not configured');
  const shown = path.relative(cwd, config.headlessPath);
  try {
    const loaded = await loadTypeScriptModule(config.headlessPath, { outDir: scratchDir, label: 'headless', forbidden: ['react-native'] });
    if (!isHeadlessDefinition(loaded.exports['default'])) return failCheck('headless', true, `${oneLine(shown)} must default-export defineHeadless(...)`, `Default-export defineHeadless(...) from @ironbird/core in ${shown}`);
    return passCheck('headless', true, `${oneLine(shown)} loads`);
  } catch (error) {
    const chain = isIronbirdError(error) ? (error.details as { importChain?: unknown } | undefined)?.importChain : undefined;
    if (Array.isArray(chain) && chain.length > 0) {
      return failCheck('headless', true, `${oneLine(String(chain[chain.length - 1]))} is imported in the headless graph: ${oneLine(chain.map(String).join(' > '))}`, HEADLESS_CHAIN_FIX);
    }
    return failCheck('headless', true, oneLine(messageOf(error)));
  }
}

/**
 * The `config` and `headless` checks (M5 design §6). The config is found as every command finds it:
 * `configPath` (`--config`), else the nearest config file walking up from `cwd`. Unlike `loadConfig`,
 * a missing file fails here; the later checks then use the defaults, rooted at `cwd`. `removeDir` is
 * a test seam for the scratch-directory cleanup.
 */
export async function checkProject(options: { cwd: string; configPath?: string | undefined; removeDir?: RemoveDir }): Promise<ProjectChecks> {
  const cwd = path.resolve(options.cwd);
  const file = options.configPath === undefined ? await findConfigFile(cwd) : path.resolve(cwd, options.configPath);
  if (file === undefined || !(await exists(file))) {
    return { config: missingConfig(cwd, file), headless: passCheck('headless', true, 'not configured'), outcome: { status: 'missing', rootDir: cwd, config: defaultConfig(cwd) } };
  }
  const rootDir = path.dirname(file);
  const shown = path.relative(cwd, file);
  const skippedHeadless = failCheck('headless', true, SKIPPED_DETAIL, SKIPPED_FIX);
  let scratch: Scratch;
  try {
    scratch = await createScratch(rootDir, options.removeDir ?? removeRecursively);
  } catch (error) {
    const parent = path.join(rootDir, '.ironbird');
    return {
      config: failCheck('config', true, `Cannot create a temporary directory under ${oneLine(parent)}: ${oneLine(messageOf(error))}`, `Make ${rootDir} writable, and remove anything at ${parent} that isn't a directory`),
      headless: skippedHeadless,
      outcome: { status: 'invalid', rootDir },
    };
  }
  try {
    let config: ResolvedConfig;
    try {
      config = await loadConfig({ cwd, configPath: file, cacheDir: scratch.dir });
    } catch (error) {
      return { config: failCheck('config', true, `${oneLine(shown)} is invalid: ${oneLine(issuesOf(error), { max: Infinity })}`, `Fix ${shown}; see ${CONFIG_DOCS_URL}`), headless: skippedHeadless, outcome: { status: 'invalid', rootDir } };
    }
    return { config: passCheck('config', true, `${oneLine(shown)} is valid`), headless: await checkHeadless(config, cwd, scratch.dir), outcome: { status: 'loaded', rootDir, config } };
  } finally {
    await scratch.remove();
  }
}
