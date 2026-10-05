import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bugSightings, STATE_EVENT } from './grading.mjs';
import { GRADER_CONFIG, GRADER_HEADLESS, graderConfigSource, graderHeadlessSource, headlessEntryOf, instrumentProject } from './instrument.mjs';

const TEMPLATE_CONFIG = `import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({
  appId: 'com.example.checkout',
  headless: './src/ironbird/headless.ts',
  defaultTarget: 'headless',
});
`;

const dirs = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-instrument-'));
  dirs.push(dir);
  return dir;
}

/** A stand-in headless entry: a target whose order passes through completed at 0 before its total arrives. */
const FAKE_ENTRY = `
export default {
  kind: 'ironbird.headless',
  async create() {
    let state = { order: { status: 'none', totalCents: 0 } };
    let rev = 0;
    const listeners = new Set();
    const set = (order) => { state = { order }; rev += 1; for (const listener of listeners) listener(); };
    return {
      target: {
        getState: () => state,
        revision: () => rev,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        dispatch: async () => { set({ status: 'completed', totalCents: 0 }); set({ status: 'completed', totalCents: 4500 }); },
      },
    };
  },
};
`;

describe('the headless entry', () => {
  it("reads the session config's headless path", () => {
    expect(headlessEntryOf(TEMPLATE_CONFIG)).toBe('./src/ironbird/headless.ts');
    expect(headlessEntryOf('export default { headless: "./entry.ts" };')).toBe('./entry.ts');
  });

  it('refuses a config with no literal headless path', () => {
    expect(() => headlessEntryOf("export default { appId: 'x' };")).toThrow(/no literal headless entry/);
  });
});

describe('the instrumented entry', () => {
  it('records the initial state and every revision as a grader state event with its own copy of the order', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'entry.mjs'), FAKE_ENTRY);
    await writeFile(path.join(dir, 'wrapped.mjs'), graderHeadlessSource('./entry.mjs'));
    const { default: wrapped } = await import(pathToFileURL(path.join(dir, 'wrapped.mjs')).href);
    const events = [];
    const recorder = { record: (source, name, data) => events.push({ seq: events.length + 1, source, name, data }) };
    expect(wrapped.kind).toBe('ironbird.headless');
    const app = await wrapped.create({ recorder });
    await app.target.dispatch('pay');
    expect(events).toEqual([
      { seq: 1, ...STATE_EVENT, data: { rev: 0, order: { status: 'none', totalCents: 0 } } },
      { seq: 2, ...STATE_EVENT, data: { rev: 1, order: { status: 'completed', totalCents: 0 } } },
      { seq: 3, ...STATE_EVENT, data: { rev: 2, order: { status: 'completed', totalCents: 4500 } } },
    ]);
    expect(bugSightings({ state: app.target.getState(), events })).toEqual(['the state at seq 2 has the order completed with totalCents 0']);
  });

  it("writes a grader config beside the session's that swaps in the instrumented entry", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'ironbird.config.ts'), TEMPLATE_CONFIG);
    expect(await instrumentProject(dir)).toBe(GRADER_CONFIG);
    expect(await readFile(path.join(dir, GRADER_CONFIG), 'utf8')).toBe(graderConfigSource());
    expect(graderConfigSource()).toContain(`headless: './${GRADER_HEADLESS}'`);
    expect(await readFile(path.join(dir, GRADER_HEADLESS), 'utf8')).toBe(graderHeadlessSource('./src/ironbird/headless.ts'));
  });
});
