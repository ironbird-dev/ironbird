import { IronbirdError } from '@ironbird/core';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadTypeScriptModule } from './bundle';

export const configSchema = z.object({
  appId: z.string().default('app'),
  headless: z.string().optional(),
  defaultTarget: z.string().optional(),
  daemon: z.object({ host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65_535).default(4567) }).prefault({}),
  bridge: z.object({ port: z.number().int().min(0).max(65_535).default(4568) }).prefault({}),
  clock: z.object({ start: z.iso.datetime().optional() }).prefault({}),
  settle: z.object({ timeoutMs: z.number().int().positive().default(5_000) }).prefault({}),
  boot: z.object({ timeoutMs: z.number().int().positive().default(30_000) }).prefault({}),
  scenarios: z.string().default('ironbird/scenarios'),
  artifactsDir: z.string().default('.ironbird'),
  devices: z.object({ ios: z.string().optional(), android: z.string().optional() }).prefault({}),
})
  // A typo such as `artifactDir` must fail loudly rather than being silently ignored.
  .strict();

export type IronbirdConfigInput = z.input<typeof configSchema>;
export type IronbirdConfig = z.output<typeof configSchema>;

export interface ResolvedConfig extends IronbirdConfig {
  rootDir: string;
  configPath: string | undefined;
  headlessPath: string | undefined;
  artifactsPath: string;
  defaultTarget: string | undefined;
}

export function defineConfig(input: IronbirdConfigInput): IronbirdConfigInput {
  return input;
}

const CONFIG_NAMES = ['ironbird.config.ts', 'ironbird.config.mts', 'ironbird.config.js', 'ironbird.config.mjs'];

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

export async function findConfigFile(cwd: string): Promise<string | undefined> {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const CONFIG_SHIMS = { '@ironbird/cli/config': 'export const defineConfig = (config) => config;' };

function resolve(parsed: IronbirdConfig, rootDir: string, configPath: string | undefined): ResolvedConfig {
  return {
    ...parsed,
    rootDir,
    configPath,
    headlessPath: parsed.headless === undefined ? undefined : path.resolve(rootDir, parsed.headless),
    artifactsPath: path.resolve(rootDir, parsed.artifactsDir),
    defaultTarget: parsed.defaultTarget ?? (parsed.headless === undefined ? undefined : 'headless'),
  };
}

export async function loadConfig(options: { cwd: string; configPath?: string }): Promise<ResolvedConfig> {
  const configPath = options.configPath ? path.resolve(options.cwd, options.configPath) : await findConfigFile(options.cwd);
  if (!configPath) return resolve(configSchema.parse({}), path.resolve(options.cwd), undefined);
  const rootDir = path.dirname(configPath);
  const loaded = await loadTypeScriptModule(configPath, { outDir: path.join(rootDir, '.ironbird', 'cache'), label: 'config', shims: CONFIG_SHIMS, errorCode: 'INVALID_CONFIG' });
  const relativePath = path.relative(options.cwd, configPath);
  if (loaded.exports['default'] === undefined) {
    throw new IronbirdError('INVALID_CONFIG', `${relativePath} must default-export defineConfig(...)`, {
      file: configPath,
      issues: [{ path: [], message: 'missing default export' }],
    });
  }
  const parsed = configSchema.safeParse(loaded.exports['default']);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new IronbirdError('INVALID_CONFIG', `Invalid ${relativePath}: ${problems}`, {
      file: configPath,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  return resolve(parsed.data, rootDir, configPath);
}
