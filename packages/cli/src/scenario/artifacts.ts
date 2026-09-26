import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const SLUG_MAX = 60;

/** A filesystem-safe form of a scenario name: lowercase, dashes for anything else, at most 60 characters. */
export function scenarioSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug === '' ? 'scenario' : slug;
}

/** `<root>/runs/<UTC stamp with milliseconds>-<slug>`, the stamp with `:` and `.` replaced so it is a valid name everywhere. */
export function runDirectoryPath(root: string, name: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.resolve(root, 'runs', `${stamp}-${scenarioSlug(name)}`);
}

export async function createRunDirectory(root: string, name: string): Promise<string> {
  const dir = runDirectoryPath(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}
