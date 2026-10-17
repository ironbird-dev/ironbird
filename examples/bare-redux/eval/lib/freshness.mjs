// Whether the proxy's template still matches the repository (M5 design D11). prepare.mjs records the
// commit and the state of the uncommitted sources it built the template from; run-session.mjs
// refuses a template once any source was committed or edited since, tracked or untracked, and a
// proxy session also refuses sources that were or are uncommitted, which match no commit.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../../checkout/eval/lib/proc.mjs';

const lines = (text) => text.split('\n').filter(Boolean);

async function git(repo, args) {
  const result = await run('git', args, { cwd: repo });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * The uncommitted state of `sources` in `repo`: `dirty`, the `git status --porcelain` lines (untracked
 * files listed one by one), and `fingerprint`, a hash of the diff against HEAD plus each untracked
 * file's path and content, which changes with every edit, even one that leaves the status lines alone.
 */
export async function sourcesState(repo, sources) {
  const dirty = lines(await git(repo, ['status', '--porcelain', '--untracked-files=all', '--', ...sources]));
  const hash = createHash('sha256');
  hash.update(await git(repo, ['diff', 'HEAD', '--binary', '--', ...sources]));
  const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...sources])).split('\0').filter(Boolean).sort();
  for (const file of untracked) {
    hash.update(`\0untracked\0${file}\0`);
    hash.update(await readFile(path.join(repo, file)).catch(() => Buffer.from('<unreadable>')));
  }
  return { dirty, fingerprint: hash.digest('hex') };
}

/** The path a `git status --porcelain` line names: the new path of a rename. */
const porcelainPath = (line) => line.slice(3).split(' -> ').at(-1);

/**
 * Why the prepared template can't be used, each ending in what to do; empty when it can. `prepared`
 * is prepare.json (or null); `changed` is the sources changed between its commit and HEAD (null when
 * git can't compare them); `fingerprint` and `dirty` are sourcesState now.
 */
export function templateStaleness({ prepared, label, changed, fingerprint, dirty }) {
  const head = prepared?.repo?.head;
  if (typeof head !== 'string' || head === '') return ['prepare.json records no commit; run prepare.mjs again'];
  if (typeof prepared.repo.fingerprint !== 'string' || prepared.repo.fingerprint === '') return ['prepare.json records no fingerprint of its sources; run prepare.mjs again'];
  const short = head.slice(0, 7);
  const problems = [];
  if (changed === null) problems.push(`cannot compare the prepared commit ${short} with HEAD; run prepare.mjs again`);
  else if (changed.length > 0) problems.push(`the template was prepared at ${short} and ${changed.length} file(s) it is built from changed since: ${changed.join(', ')}; run prepare.mjs again`);
  if (fingerprint !== prepared.repo.fingerprint) {
    problems.push(`uncommitted files the template is built from changed since prepare.mjs ran (uncommitted now: ${dirty.map(porcelainPath).join(', ') || 'none'}); run prepare.mjs again`);
  }
  if (label === 'proxy') {
    const before = (prepared.repo.dirty ?? []).map(porcelainPath);
    if (before.length > 0) problems.push(`the template was prepared with uncommitted changes (${before.join(', ')}); commit them and run prepare.mjs again`);
    if (dirty.length > 0) problems.push(`the files the template is built from have uncommitted changes now (${dirty.map(porcelainPath).join(', ')}); commit them and run prepare.mjs again`);
  }
  return problems;
}
