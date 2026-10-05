// Whether the template still matches the repository (M3 design §7.1): prepare.mjs records the commit
// it built the template from, and run-session.mjs refuses to start a session once anything the
// template is built from has been committed since, so a session never runs a stale skill, CLI, or fixture.
import { run } from './proc.mjs';

/**
 * Repository paths the template is built from, or that decide how a session runs: the example and
 * its eval harness, the packed packages (the CLI carries the skill), and the root build inputs.
 */
export const TEMPLATE_SOURCES = ['examples/checkout', 'packages', 'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json'];

const underSources = (file) => TEMPLATE_SOURCES.some((source) => file === source || file.startsWith(`${source}/`));

/** The path a `git status --porcelain` line names: the new path of a rename. */
const porcelainPath = (line) => line.slice(3).split(' -> ').at(-1);

/**
 * The template sources changed between `from` and HEAD in `repo`, or null when git cannot compare
 * them (an unknown commit, say).
 */
export async function changedSince(repo, from) {
  const diff = await run('git', ['diff', '--name-only', from, 'HEAD', '--', ...TEMPLATE_SOURCES], { cwd: repo });
  if (diff.code !== 0) return null;
  return diff.stdout.split('\n').filter(Boolean);
}

/**
 * Why the prepared template cannot be used, each ending in what to do; empty when it can.
 * `prepared` is prepare.json (or null), `changed` is what `changedSince` returned for its commit.
 * A gate session also refuses a template prepared with uncommitted changes to its sources, which
 * match no commit.
 */
export function templateFreshness({ prepared, changed, label }) {
  const head = prepared?.repo?.head;
  if (typeof head !== 'string' || head === '') return ['prepare.json records no commit; run prepare.mjs again'];
  const short = head.slice(0, 7);
  const problems = [];
  if (changed === null) problems.push(`cannot compare the prepared commit ${short} with HEAD; run prepare.mjs again`);
  else if (changed.length > 0) problems.push(`the template was prepared at ${short} and ${changed.length} file(s) it is built from changed since: ${changed.join(', ')}; run prepare.mjs again`);
  if (label === 'gate') {
    const dirty = (prepared.repo.dirty ?? []).map(porcelainPath).filter(underSources);
    if (dirty.length > 0) problems.push(`the template was prepared with uncommitted changes to ${dirty.join(', ')}; commit them and run prepare.mjs again`);
  }
  return problems;
}
