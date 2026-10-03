// File-tree helpers for prepare, run-session, and grade.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Folders that never count as the agent's work: dependencies, git, ironbird's artifacts, Metro's cache, build output. */
export const NOT_WORK = new Set(['node_modules', '.git', '.ironbird', '.expo', 'dist']);

/** Every file under `dir`, relative to it with forward slashes, skipping `skip` folder names at any depth. */
export async function listFiles(dir, skip = NOT_WORK, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full, skip, base)));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

/** Scenario files (`*.yaml`, `*.yml`) under `<project>/ironbird/scenarios`, at any depth, relative to the project. */
export async function scenarioFiles(project) {
  const root = path.join(project, 'ironbird', 'scenarios');
  return (await listFiles(root)).filter((file) => /\.ya?ml$/i.test(file)).map((file) => `ironbird/scenarios/${file}`);
}

/** Scenario files the agent added: in the session, not in the template. An edited template scenario is not an addition. */
export function addedScenarios(sessionFiles, templateFiles) {
  const known = new Set(templateFiles);
  return sessionFiles.filter((file) => !known.has(file));
}

/** AGENTS.md or CLAUDE.md files in `dir` or any of its ancestors, which the built-in agents-md plugin would load. */
export async function ancestorInstructionFiles(dir) {
  const found = [];
  let current = path.resolve(dir);
  for (;;) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const candidate = path.join(current, name);
      if (await stat(candidate).then((info) => info.isFile()).catch(() => false)) found.push(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

/** Whether `child` is `parent` or inside it. */
export function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
