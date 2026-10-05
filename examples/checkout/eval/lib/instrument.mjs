// The grader's state history. A scenario run's events.jsonl holds the app's events (analytics and
// the fakes') but not its states, so the grader serves its own copy of a session with the session's
// headless entry wrapped: the same app, plus one recorded event per state revision. The strict
// reading (docs/evals/m3-agent-interface.md) then sees every state a held-back run passed through.
// Only the grader's copy is instrumented, never the session's project or the template.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE_EVENT } from './grading.mjs';

/** Written into the grader's copy beside the session's ironbird.config.ts, and passed to `serve --config`. */
export const GRADER_CONFIG = 'ironbird.grader.config.mjs';
export const GRADER_HEADLESS = 'ironbird.grader-headless.mjs';

/** The `headless` path a session's ironbird.config.ts names, as written. */
export function headlessEntryOf(configText) {
  const match = /\bheadless\s*:\s*(['"`])([^'"`]+)\1/.exec(configText);
  if (!match) throw new Error('ironbird.config.ts has no literal headless entry, so the grader cannot record the state history');
  return match[2];
}

/** The grader's config: the session's own, with the instrumented entry as `headless`. */
export function graderConfigSource() {
  return `// Written by the eval grader: the session's config with the instrumented headless entry.\nimport base from './ironbird.config';\n\nexport default { ...base, headless: './${GRADER_HEADLESS}' };\n`;
}

/**
 * The instrumented entry: the session's entry (`specifier`, relative to the project root), whose
 * app records `{ rev, order }` as a STATE_EVENT on boot and after every state revision. The order
 * is copied, so a later mutation cannot rewrite the history.
 */
export function graderHeadlessSource(specifier) {
  return `// Written by the eval grader: the session's headless entry, unchanged, plus one event per state revision.
import entry from ${JSON.stringify(specifier)};

export default {
  kind: entry.kind,
  async create(context) {
    const app = await entry.create(context);
    const record = () => {
      const order = app.target.getState()?.order;
      context.recorder.record(${JSON.stringify(STATE_EVENT.source)}, ${JSON.stringify(STATE_EVENT.name)}, { rev: app.target.revision(), order: order === undefined ? null : JSON.parse(JSON.stringify(order)) });
    };
    record();
    app.target.subscribe(record);
    return app;
  },
};
`;
}

/** Writes the grader's config and instrumented entry into `project` (the grader's copy) and returns the config's file name. */
export async function instrumentProject(project) {
  const entry = headlessEntryOf(await readFile(path.join(project, 'ironbird.config.ts'), 'utf8'));
  await writeFile(path.join(project, GRADER_HEADLESS), graderHeadlessSource(entry));
  await writeFile(path.join(project, GRADER_CONFIG), graderConfigSource());
  return GRADER_CONFIG;
}
