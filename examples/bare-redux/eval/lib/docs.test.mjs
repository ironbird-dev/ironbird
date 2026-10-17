import { describe, expect, it } from 'vitest';
import { docsRead, docsSet, mentions } from './docs.mjs';

describe('docsSet', () => {
  it('keeps the README, package READMEs, and docs/, without design plans, eval records, or other files', () => {
    const listed = ['README.md', 'AGENTS.md', 'docs/api.md', 'docs/guides/getting-started.md', 'docs/adr/0004-zod-4-schemas.md', 'docs/superpowers/plans/x.md', 'docs/evals/m5.md', 'docs/images/a.png', 'packages/redux/README.md', 'packages/redux/src/notes.md', 'examples/bare-redux/README.md'];
    expect(docsSet(listed)).toEqual(['README.md', 'docs/adr/0004-zod-4-schemas.md', 'docs/api.md', 'docs/guides/getting-started.md', 'packages/redux/README.md']);
  });
});

describe('docsRead', () => {
  it('lists the docs the agent read, relative to the docs folder under any spelling of it, and counts searches there', () => {
    const calls = [
      { name: 'Read', input: { file_path: '/s/docs/docs/api.md' } },
      { name: 'Read', input: { file_path: '/private/s/docs/docs/guides/getting-started.md' } },
      { name: 'Read', input: { file_path: '/s/docs/docs/api.md' } },
      { name: 'Read', input: { file_path: '/s/project/package.json' } },
      { name: 'Grep', input: { path: '/s/docs', pattern: 'fromStore' } },
      { name: 'Glob', input: { pattern: '**/*.md', path: '/s/docs/docs' } },
      { name: 'Grep', input: { path: '/s/project', pattern: 'store' } },
    ];
    expect(docsRead(calls, ['/s/docs', '/private/s/docs'])).toEqual({ read: ['docs/api.md', 'docs/guides/getting-started.md'], searches: 2 });
  });
});

describe('mentions', () => {
  it('finds a term with its file, line, and trimmed line', () => {
    const files = [
      { file: 'docs/a.md', text: 'one\n  see examples/bare-redux here  \n' },
      { file: 'docs/b.md', text: 'nothing' },
    ];
    expect(mentions(files, 'bare-redux')).toEqual([{ file: 'docs/a.md', line: 2, excerpt: 'see examples/bare-redux here' }]);
  });
});
