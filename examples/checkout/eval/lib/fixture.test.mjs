import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEdits, copyExample, findHints, FIXTURE_README, hintsInText, isAllowedHint, KNOWN_FIX, replaceExactlyOnce, transformFixture } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, '../..');

const AWAITING_ECHO = [
  { type: 'cart.addItem', sku: 'cut-45', qty: 1 },
  { type: 'payment.start', method: 'saved' },
  { type: 'api.submitted', paymentId: 'pay_1' },
];
const CONFIRMED = { type: 'server.event', event: { type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 } };
const SUCCEEDED = { type: 'server.event', event: { type: 'payment.succeeded', paymentId: 'pay_1' } };

/** Loads the copy's reducer; `tag` makes Vitest load the file again after an edit instead of reusing the cached module. */
async function reducerOf(dir, tag) {
  const { initialState, reduce } = await import(`${pathToFileURL(path.join(dir, 'src/core/checkout.ts')).href}?${tag}`);
  return { reduce, order: (events) => events.reduce((state, event) => reduce(state, event), initialState).order };
}

describe('replaceExactlyOnce', () => {
  it('replaces the one occurrence and keeps $ patterns literal', () => {
    expect(replaceExactlyOnce('a b c', 'b', '$&$1', 'x')).toBe('a $&$1 c');
  });

  it('names the edit when the anchor is missing or repeated', () => {
    expect(() => replaceExactlyOnce('a b c', 'z', 'y', 'the label')).toThrow('"the label": anchor not found');
    expect(() => replaceExactlyOnce('b b', 'b', 'y', 'the label')).toThrow('"the label": anchor occurs more than once');
  });
});

describe('the hint scan', () => {
  it('finds every term occurrence on a line, each with the text around it', () => {
    const hits = hintsInText('ok\nA duplicated event can reorder things; payment succeeded before the order confirmation.', 'notes.md');
    expect(hits.map((hit) => [hit.line, hit.term])).toEqual([
      [2, 'duplicate'],
      [2, 'succeeded before'],
      [2, 'before (the )?(order )?confirm'],
      [2, 'reorder'],
    ]);
    expect(hits[0].excerpt).toContain('A duplicated event');
  });

  it('allows a hit only when an entry matches both its file and the text around it', () => {
    const [initial] = hintsInText("  order: { status: 'none', totalCents: 0, paymentSucceeded: false },", 'src/core/checkout.ts');
    expect(isAllowedHint(initial)).toBe(true);
    expect(isAllowedHint({ ...initial, file: 'src/core/app.ts' })).toBe(false);
    const [completed] = hintsInText("  order: { status: 'completed', totalCents: 0 },", 'src/core/checkout.ts');
    expect(isAllowedHint(completed)).toBe(false);
  });

  it('allows only the occurrence an entry covers, not a neighbor on the same or the next line', () => {
    const file = 'src/core/checkout.ts';
    const initial = "  order: { status: 'none', totalCents: 0, paymentSucceeded: false },";
    const hits = hintsInText(`${initial}\n  order: { status: 'completed', totalCents: 0 },`, file);
    expect(hits.map((hit) => [hit.line, isAllowedHint(hit)])).toEqual([
      [1, true],
      [2, false],
    ]);
    const twice = hintsInText(`${initial} // totalCents: 0`, file);
    expect(twice.map((hit) => isAllowedHint(hit))).toEqual([true, false]);
  });

  it('judges each occurrence on a long line by its own surroundings', () => {
    const line = `${'x'.repeat(10)}await Promise.race([a, b]);${'y'.repeat(300)}completes with a zero total${'z'.repeat(10)}`;
    const hits = hintsInText(line, 'node_modules/@ironbird/core/dist/index.js.map');
    expect(hits.map((hit) => [hit.term, isAllowedHint(hit)])).toEqual([
      ['\\brace\\b', true],
      ['zero total', false],
    ]);
  });
});

describe('the fixture transform on the real example', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ironbird-eval-fixture-'));
    await copyExample(example, dir);
    await transformFixture(dir);
    // The copied tsconfig still extends the monorepo's base, which does not exist next to this
    // temporary copy (prepare replaces it; see manifest.mjs). An empty one lets Vitest load the copy.
    await writeFile(path.join(dir, 'tsconfig.json'), '{}\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the app without dependencies, build output, caches, artifacts, the harness, the scripts, or the device tests', async () => {
    expect((await readdir(dir)).sort()).toEqual(['App.tsx', 'README.md', 'app.json', 'assets', 'index.js', 'ironbird', 'ironbird.config.ts', 'package.json', 'src', 'tsconfig.json']);
    expect((await readdir(path.join(dir, 'ironbird/scenarios'))).sort()).toEqual(['checkout-saved-card.yaml', 'missing-echo-times-out.yaml', 'reader-disconnect.yaml']);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe(FIXTURE_README);
  });

  it('leaves nothing that names the race', async () => {
    expect(await findHints(dir)).toEqual([]);
  });

  it('leaves no test that delivers the success before the confirmation', async () => {
    const api = await readFile(path.join(dir, 'src/ironbird/fakes/api.test.ts'), 'utf8');
    const manual = api.slice(api.indexOf("it('holds the echo in manual mode"));
    expect(manual.indexOf("event: 'order.confirmed'")).toBeLessThan(manual.indexOf("event: 'payment.succeeded'"));
    const reducer = await readFile(path.join(dir, 'src/core/checkout.test.ts'), 'utf8');
    expect(reducer).not.toMatch(/succeeded, confirmed/);
  });

  it('makes the race unconditional: success before confirmation completes the order with a zero total', async () => {
    const { reduce, order } = await reducerOf(dir, 'raced');
    expect(reduce.length).toBe(2);
    expect(order([...AWAITING_ECHO, SUCCEEDED, CONFIRMED])).toMatchObject({ status: 'completed', totalCents: 0 });
    expect(order([...AWAITING_ECHO, CONFIRMED, SUCCEEDED])).toMatchObject({ status: 'completed', totalCents: 4_500 });
  });

  it('KNOWN_FIX completes the order only once both server events have arrived, in either order', async () => {
    await applyEdits(dir, [KNOWN_FIX]);
    const { order } = await reducerOf(dir, 'fixed');
    expect(order([...AWAITING_ECHO, SUCCEEDED]).status).toBe('none');
    expect(order([...AWAITING_ECHO, SUCCEEDED, CONFIRMED])).toMatchObject({ status: 'completed', totalCents: 4_500 });
  });
});
