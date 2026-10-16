// The published docs a proxy session gets (M5 design D11: "only the published docs"), and what it
// read of them. Published means what a developer finds on GitHub and npm: the README, each package's
// README, and docs/, without the design plans and specs under docs/superpowers/ and the eval records
// under docs/evals/, which are working notes, not documentation. Never examples/.
import path from 'node:path';

export function isPublishedDoc(rel) {
  if (rel === 'README.md' || /^packages\/[^/]+\/README\.md$/.test(rel)) return true;
  return rel.startsWith('docs/') && rel.endsWith('.md') && !rel.startsWith('docs/superpowers/') && !rel.startsWith('docs/evals/');
}

/** The published docs among `relPaths` (git ls-files output, repository-relative), sorted. */
export function docsSet(relPaths) {
  return relPaths.filter(isPublishedDoc).sort();
}

const within = (file, root) => file === root || file.startsWith(root + path.sep);

/** The docs files the session read with Read, relative to the docs folder (any of `roots`), sorted and unique; and how many Grep or Glob calls searched in it. */
export function docsRead(calls, roots) {
  const read = new Set();
  let searches = 0;
  for (const call of calls) {
    const input = call.input ?? {};
    if (call.name === 'Read' && typeof input.file_path === 'string') {
      const root = roots.find((candidate) => within(input.file_path, candidate));
      if (root) read.add(path.relative(root, input.file_path).split(path.sep).join('/'));
    } else if ((call.name === 'Grep' || call.name === 'Glob') && typeof input.path === 'string' && roots.some((root) => within(input.path, root))) {
      searches += 1;
    }
  }
  return { read: [...read].sort(), searches };
}

/** Every line of `files` (`{ file, text }`) that contains `term`, trimmed to 160 characters. */
export function mentions(files, term) {
  const found = [];
  for (const { file, text } of files) {
    text.split('\n').forEach((line, index) => {
      if (line.includes(term)) found.push({ file, line: index + 1, excerpt: line.trim().slice(0, 160) });
    });
  }
  return found;
}
