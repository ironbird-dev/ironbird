import { IronbirdError, deepEqual, messageOf } from '@ironbird/core';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AgentSetupOptions {
  /** The project root: `.mcp.json` lives here and a relative `skillsDir` resolves against it. */
  cwd: string;
  /** Where Agent Skills live; default `.claude/skills`. The skill goes in `<skillsDir>/ironbird/`. */
  skillsDir?: string;
  /** The installed `@ironbird/cli` package, which holds `skills/ironbird/`. */
  packageRoot: string;
}

export interface AgentSetupResult {
  /** `dir` is absolute; `files` are the skill's files relative to it, with `/` separators. */
  skill: { dir: string; files: string[] };
  /** `updated` is false when `.mcp.json` already held this exact entry and was left untouched. */
  mcp: { file: string; updated: boolean };
}

const DEFAULT_SKILLS_DIR = '.claude/skills';
const MCP_ENTRY = { command: 'npx', args: ['ironbird', 'mcp'] };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const invalid = (file: string, at: string[], message: string): IronbirdError =>
  new IronbirdError('INVALID_CONFIG', `Invalid ${file}: ${at.length === 0 ? '' : `${at.join('.')}: `}${message}`, { file, issues: [{ path: at, message }] });

/**
 * Reads and checks `.mcp.json` before anything is written, so an invalid file leaves the project
 * exactly as it was (spec §6.2). Undefined means the file does not exist.
 */
async function readMcpConfig(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new IronbirdError('INTERNAL', `Could not read ${file}: ${messageOf(error)}`, { file, message: messageOf(error) });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(file, [], `not valid JSON: ${messageOf(error)}`);
  }
  if (!isObject(parsed)) throw invalid(file, [], 'expected a JSON object');
  // Replacing a non-object here would throw away whatever the user keeps in it.
  if (parsed['mcpServers'] !== undefined && !isObject(parsed['mcpServers'])) throw invalid(file, ['mcpServers'], 'expected an object');
  return parsed;
}

/** Every file under `root`, relative to it with `/` separators, in name order. */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(prefix === '' ? root : path.join(root, ...prefix.split('/')), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** Runs one filesystem write, turning a Node error into `INTERNAL` naming the file, so no raw fs error leaves this public API (AGENTS.md hard rule 8). */
async function writing(file: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    throw new IronbirdError('INTERNAL', `Could not write ${file}: ${messageOf(error)}`, { file, message: messageOf(error) });
  }
}

/**
 * Installs the packaged skill into `<skillsDir>/ironbird/`, replacing the files it owns and leaving
 * others alone, and adds or replaces only `mcpServers.ironbird` in `.mcp.json` (spec §6.2).
 *
 * Everything that can be checked is checked before the first write: `.mcp.json` is read and
 * validated and the packaged skill is listed first, so an invalid config or a broken install
 * writes nothing. `.mcp.json` is written last, so a skill folder that can't be written leaves it
 * untouched. Every failure is an `IronbirdError`.
 */
export async function agentSetup(options: AgentSetupOptions): Promise<AgentSetupResult> {
  const mcpFile = path.resolve(options.cwd, '.mcp.json');
  const existing = await readMcpConfig(mcpFile);

  const source = path.join(options.packageRoot, 'skills', 'ironbird');
  let files: string[];
  try {
    files = await listFiles(source);
  } catch (error) {
    throw new IronbirdError('INTERNAL', `The ironbird skill is missing from ${source}; reinstall @ironbird/cli`, { file: source, message: messageOf(error) });
  }
  if (files.length === 0) throw new IronbirdError('INTERNAL', `The ironbird skill is missing from ${source}; reinstall @ironbird/cli`, { file: source, message: 'no files' });

  const dir = path.resolve(options.cwd, options.skillsDir ?? DEFAULT_SKILLS_DIR, 'ironbird');
  for (const file of files) {
    const to = path.join(dir, ...file.split('/'));
    await writing(to, async () => {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(path.join(source, ...file.split('/')), to);
    });
  }

  const servers = (existing?.['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  const updated = !deepEqual(servers['ironbird'], MCP_ENTRY);
  if (updated) {
    // Spreading keeps every other key, and an existing key keeps its position in the file.
    const next = { ...(existing ?? {}), mcpServers: { ...servers, ironbird: MCP_ENTRY } };
    await writing(mcpFile, () => writeFile(mcpFile, `${JSON.stringify(next, null, 2)}\n`));
  }
  return { skill: { dir, files }, mcp: { file: mcpFile, updated } };
}

/** The directory of the `@ironbird/cli` package that holds `start`, found by walking up to its `package.json`. */
export async function findPackageRoot(start: string): Promise<string> {
  let dir = path.resolve(start);
  for (;;) {
    const manifest = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => undefined);
    if (manifest !== undefined) {
      try {
        if ((JSON.parse(manifest) as { name?: unknown }).name === '@ironbird/cli') return dir;
      } catch {
        // Not a manifest we can read; keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new IronbirdError('INTERNAL', `Could not find the @ironbird/cli package above ${start}`, { message: `no @ironbird/cli package.json above ${start}` });
    dir = parent;
  }
}
