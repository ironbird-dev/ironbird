// The eval fixture (M3 design §7.1 steps 1 and 2): a copy of examples/checkout with the race always
// on and nothing left that names it. A scripted transform rather than a .patch file: every edit is
// an exact anchor that must match exactly once, so a later change to the example fails `prepare`
// with the file and the edit's label instead of a fuzzy patch hunk, and the README is replaced
// whole rather than patched line by line.
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Top-level entries of examples/checkout that never reach the fixture (spec §7.1 step 1). */
export const EXCLUDED = ['node_modules', 'dist', '.expo', '.ironbird', 'eval', 'scripts'];

/**
 * Paths the transform deletes: the held-back race and duplicate-success scenarios, which the grader
 * runs from the repository, and the device tests, which name the race and reach into the monorepo
 * for the CLI binary (`../../packages/cli/dist/bin.js`).
 */
export const REMOVED_PATHS = ['ironbird/scenarios/race-success-before-confirmation.yaml', 'ironbird/scenarios/duplicate-success.yaml', 'test'];

/**
 * Words and phrases that would give the race away. Every session-visible text surface is scanned
 * for them (prepare: the fixture, its installed skill, node_modules/@ironbird, and the vendored
 * tarballs' contents); each hit must match an entry of HINT_ALLOWED or prepare fails.
 */
export const HINT_TERMS = [
  /plant/i,
  /\brace\b/i,
  /zero total/i,
  /duplicate/i,
  /succeeded before/i,
  /before (the )?(order )?confirm/i,
  /arrives? before/i,
  /reorder/i,
  /out[ -]of[ -]order/i,
  /\btotalCents"?:\s?0\b/i,
];

/**
 * Expected hits, each with the reason it gives nothing away. An entry matches a hit when `file`
 * matches the hit's path (relative to the scanned surface, with the surface's prefix) and `text`
 * matches the text around the hit. Add an entry only after checking the hit against D7: it must not
 * name this app's commands, fakes, state paths, or the order of its server events.
 */
export const HINT_ALLOWED = [
  {
    file: /^src\/core\/checkout(\.test)?\.ts$/,
    text: /status: 'none', totalCents: 0, paymentSucceeded: false/,
    reason: 'the order before any server confirmation (the initial state, and the reset on payment.start): no order exists, it is not a completed one',
  },
  {
    file: /skills\/ironbird\//,
    text: /delayed, duplicated, reordered, and missing/i,
    reason: "the skill's generic list of orderings the outside world produces (M3 design §6.1); it names nothing in this app",
  },
  { file: /(^|\/)dist\//, text: /Promise\.race\(/, reason: "JavaScript's Promise.race in ironbird's own library code" },
  { file: /(^|\/)dist\//, text: /win the race to the wire/, reason: "a comment in ironbird's own transport code about socket message order; library code cannot name the app" },
  { file: /(^|\/)dist\//, text: /would reorder the circular wiring/, reason: "a comment in ironbird's own code about module initialization order" },
];

const lines = (...parts) => parts.join('\n');

/** Exact-anchor edits, applied in order. Each `find` must occur exactly once in its file. */
export const FIXTURE_EDITS = [
  {
    file: 'src/core/checkout.ts',
    label: 'reduce loses its options parameter',
    find: 'export function reduce(state: CheckoutState, event: CheckoutEvent, options: { plantRace: boolean }): CheckoutState {',
    replace: 'export function reduce(state: CheckoutState, event: CheckoutEvent): CheckoutState {',
  },
  {
    file: 'src/core/checkout.ts',
    label: 'payment.succeeded always completes the order',
    find: lines(
      "          if (state.order.status === 'completed') return state;",
      '          if (options.plantRace) {',
      '            // Planted bug: completes as soon as the server says the payment succeeded, even if',
      "            // order.confirmed (which carries the total) hasn't arrived yet. The receipt then shows 0.",
      '            return complete(state);',
      '          }',
      '          const next = { ...state, order: { ...state.order, paymentSucceeded: true } };',
      "          return next.order.status === 'confirmed' ? complete(next) : next;",
    ),
    replace: lines("          if (state.order.status === 'completed') return state;", '          return complete(state);'),
  },
  {
    file: 'src/core/app.ts',
    label: 'createAppCore loses its options parameter',
    find: lines('export function createAppCore(ports: AppPorts, options: { plantRace?: boolean } = {}): AppCore {', '  const plantRace = options.plantRace ?? false;', ''),
    replace: lines('export function createAppCore(ports: AppPorts): AppCore {', ''),
  },
  {
    file: 'src/core/app.ts',
    label: 'send calls reduce without options',
    find: 'const next = reduce(previous, event, { plantRace });',
    replace: 'const next = reduce(previous, event);',
  },
  {
    file: 'src/core/instance.ts',
    label: 'the device build loses the flag comment',
    find: lines(
      '// Expo inlines EXPO_PUBLIC_* when Metro bundles, so the flag is fixed per bundle: planting the',
      '// race on a device means restarting Metro with the variable set and its cache cleared (M2 D12).',
      '',
    ),
    replace: '',
  },
  {
    file: 'src/core/instance.ts',
    label: 'the device build loses the flag',
    find: lines('  },', "  { plantRace: process.env.EXPO_PUBLIC_PLANT_RACE === '1' },", ');'),
    replace: lines('  },', ');'),
  },
  {
    file: 'src/ironbird/headless.ts',
    label: 'the headless entry stops reading env',
    find: 'export default defineHeadless(({ clock, recorder, tracker, env }) => {',
    replace: 'export default defineHeadless(({ clock, recorder, tracker }) => {',
  },
  {
    file: 'src/ironbird/headless.ts',
    label: 'the headless entry loses the flag',
    find: lines('    },', "    { plantRace: env['PLANT_RACE'] === '1' },", '  );'),
    replace: lines('    },', '  );'),
  },
  {
    file: 'ironbird.config.ts',
    label: 'the config comment stops pointing at the removed device tests',
    find: lines(
      '  // Pins the iOS capture device when more than one simulator is booted, which otherwise makes',
      "  // `screenshot`/`step` fail with AMBIGUOUS_DEVICE (packages/cli/src/devices.ts). Same variable as",
      "  // the device tests' reload helper (examples/checkout/test/device-helpers.ts); unset, this is a",
      "  // no-op and `resolveDevice` falls back to its normal single-booted-simulator check.",
    ),
    replace: lines(
      '  // Pins the iOS capture device when more than one simulator is booted, which otherwise makes',
      '  // `screenshot` and `step` fail with AMBIGUOUS_DEVICE; unset, the only booted simulator is used.',
    ),
  },
  {
    file: 'src/core/checkout.test.ts',
    label: 'the reducer test helper drops the flag',
    find: lines(
      'const run = (events: CheckoutEvent[], plantRace = false): CheckoutState =>',
      '  events.reduce((state, event) => reduce(state, event, { plantRace }), initialState);',
    ),
    replace: lines('const run = (events: CheckoutEvent[]): CheckoutState =>', '  events.reduce((state, event) => reduce(state, event), initialState);'),
  },
  {
    file: 'src/core/checkout.test.ts',
    label: 'the late reader result test drops the flag',
    find: "reduce(disconnected, { type: 'reader.collected', token: 'tok' }, { plantRace: false })",
    replace: "reduce(disconnected, { type: 'reader.collected', token: 'tok' })",
  },
  {
    file: 'src/core/checkout.test.ts',
    label: 'the retry test drops the flag',
    find: "reduce(failed, { type: 'payment.start', method: 'saved' }, { plantRace: false })",
    replace: "reduce(failed, { type: 'payment.start', method: 'saved' })",
  },
  {
    file: 'src/core/checkout.test.ts',
    label: 'the completion test covers only the confirmed-then-succeeded order',
    find: lines(
      "  it('completes only when both confirmation and success have arrived, in either order', () => {",
      '    const inOrder = run([...toAwaitingEcho, confirmed, succeeded]);',
      "    expect(inOrder.order).toEqual({ status: 'completed', orderId: 'ord_1', totalCents: 4_500, paymentSucceeded: true });",
      "    expect(inOrder.payment.status).toBe('succeeded');",
      '    const reversed = run([...toAwaitingEcho, succeeded, confirmed]);',
      '    expect(reversed.order).toEqual(inOrder.order);',
      "    expect(run([...toAwaitingEcho, succeeded]).order.status).toBe('none');",
      '  });',
    ),
    replace: lines(
      "  it('completes when the server confirms the order and then reports the payment succeeded', () => {",
      '    const state = run([...toAwaitingEcho, confirmed, succeeded]);',
      "    expect(state.order).toEqual({ status: 'completed', orderId: 'ord_1', totalCents: 4_500, paymentSucceeded: true });",
      "    expect(state.payment.status).toBe('succeeded');",
      '  });',
    ),
  },
  {
    file: 'src/core/checkout.test.ts',
    label: 'the idempotence test is renamed and repeats only the success, after completion',
    find: lines("  it('treats duplicate server events as idempotent', () => {", '    const state = run([...toAwaitingEcho, confirmed, succeeded, succeeded, confirmed]);'),
    replace: lines("  it('treats repeated server events as idempotent', () => {", '    const state = run([...toAwaitingEcho, confirmed, succeeded, succeeded]);'),
  },
  {
    file: 'src/core/checkout.test.ts',
    label: 'the reducer race test goes',
    find: lines(
      '',
      "  it('with the planted race, an early success completes the order with a zero total', () => {",
      '    const buggy = run([...toAwaitingEcho, succeeded, confirmed], true);',
      "    expect(buggy.order.status).toBe('completed');",
      '    expect(buggy.order.totalCents).toBe(0);',
      '    const healthy = run([...toAwaitingEcho, confirmed, succeeded], true);',
      '    expect(healthy.order.totalCents).toBe(4_500);',
      '  });',
      '',
    ),
    replace: '',
  },
  {
    file: 'src/ironbird/fakes/api.test.ts',
    label: 'the manual-echo test emits the confirmation before the success',
    find: lines(
      "    await api.control('emit', { event: 'payment.succeeded' });",
      "    await api.control('emit', { event: 'order.confirmed' });",
      '    expect(events).toEqual([',
      "      { type: 'payment.succeeded', paymentId: 'pay_1' },",
      "      { type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 },",
      '    ]);',
    ),
    replace: lines(
      "    await api.control('emit', { event: 'order.confirmed' });",
      "    await api.control('emit', { event: 'payment.succeeded' });",
      '    expect(events).toEqual([',
      "      { type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 },",
      "      { type: 'payment.succeeded', paymentId: 'pay_1' },",
      '    ]);',
    ),
  },
  {
    file: 'src/core/app.test.ts',
    label: 'the app harness drops the flag',
    find: 'function harness(options: { plantRace?: boolean } = {}): Harness {',
    replace: 'function harness(): Harness {',
  },
  {
    file: 'src/core/app.test.ts',
    label: 'the app harness creates the core without options',
    find: 'const app = createAppCore({ reader, api, analytics: { track: (name) => tracked.push(name) }, clock }, options);',
    replace: 'const app = createAppCore({ reader, api, analytics: { track: (name) => tracked.push(name) }, clock });',
  },
  {
    file: 'src/core/app.test.ts',
    label: 'the app race test goes',
    find: lines(
      '',
      "  it('reproduces the planted race when the server echoes success before confirmation', async () => {",
      '    const h = harness({ plantRace: true });',
      "    h.app.send({ type: 'cart.addItem', sku: 'cut-45', qty: 1 });",
      "    h.app.send({ type: 'payment.start', method: 'saved' });",
      "    h.api.resolve('pay_1');",
      '    await flush();',
      "    h.emitServer({ type: 'payment.succeeded', paymentId: 'pay_1' });",
      "    h.emitServer({ type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 });",
      "    expect(h.app.getSnapshot().order).toMatchObject({ status: 'completed', totalCents: 0 });",
      '  });',
      '',
    ),
    replace: '',
  },
  {
    file: 'src/ironbird/headless.test.ts',
    label: 'the dispose test runs without the flag',
    find: lines("  it('honors PLANT_RACE and disposes cleanly', async () => {", "    const { app, clock } = await boot({ PLANT_RACE: '1' });"),
    replace: lines("  it('disposes cleanly after a payment', async () => {", '    const { app, clock } = await boot();'),
  },
  {
    file: 'src/ironbird/headless.test.ts',
    label: 'the headless race test goes',
    find: lines(
      '',
      "  it('with the echo held, the controls reorder the server events and the planted race shows a zero total', async () => {",
      "    const { app, clock } = await boot({ PLANT_RACE: '1' });",
      "    const api = app.fakes?.find((fake) => fake.name === 'api');",
      "    if (!api) throw new Error('api fake not wired');",
      "    await api.control('setEcho', { mode: 'manual' });",
      "    await app.target.dispatch('cart.addItem', { sku: 'cut-45', qty: 1 });",
      "    await app.target.dispatch('payment.start', { method: 'saved' });",
      '    await clock.advance(300);',
      "    expect(state(app).payment.status).toBe('awaitingServerEcho');",
      "    expect(clock.timers().map((t) => t.label)).toEqual(['payment.serverTimeout']);",
      "    await api.control('emit', { event: 'payment.succeeded' });",
      "    await api.control('emit', { event: 'order.confirmed' });",
      "    expect(state(app).order).toEqual({ status: 'completed', totalCents: 0, paymentSucceeded: true });",
      '    expect(clock.timers()).toEqual([]);',
      '    await app.dispose?.();',
      '  });',
      '',
    ),
    replace: '',
  },
];

/** The fixture's README, replacing the example's, which documents the flag and the race. */
export const FIXTURE_README = `# Checkout

A cart, a card reader, and a payment API behind ports, with the reader and the API faked. Headlessly it runs in Node through \`src/ironbird/headless.ts\`; on a device it runs in Expo Go through \`index.js\`, which starts the ironbird bridge in dev builds.

## Run

\`\`\`sh
npx ironbird serve    # the daemon: the headless target, and the app once it connects
npx expo start        # Metro, for the app in Expo Go
\`\`\`

\`npx ironbird status\` lists the targets, \`npx ironbird commands\` the app's commands, and \`npx ironbird fakes\` the two fakes, \`reader\` and \`api\`, with their controls.

## Scenarios

\`ironbird/scenarios/\` holds the app's scenarios. With the daemon running, \`npx ironbird scenario run ironbird/scenarios\` runs them headlessly. Each run writes its result, events, final state, and fake calls under \`.ironbird/runs/\`.

## Tests

\`npm test\` runs the unit tests with Vitest.
`;

/**
 * The correct \`payment.succeeded\` branch, which the grader's self-test applies to a fixture copy
 * to stand in for an agent's fix. It is the inverse of the edit that made the race unconditional.
 */
export const KNOWN_FIX = {
  file: 'src/core/checkout.ts',
  label: 'the known fix',
  find: lines("          if (state.order.status === 'completed') return state;", '          return complete(state);'),
  replace: lines(
    "          if (state.order.status === 'completed') return state;",
    '          const next = { ...state, order: { ...state.order, paymentSucceeded: true } };',
    "          return next.order.status === 'confirmed' ? complete(next) : next;",
  ),
};

/** Replaces the only occurrence of `find`; throws, naming the edit, when it occurs zero times or more than once. */
export function replaceExactlyOnce(text, find, replace, label) {
  const first = text.indexOf(find);
  if (first === -1) throw new Error(`fixture: "${label}": anchor not found. The example changed; update FIXTURE_EDITS in examples/checkout/eval/lib/fixture.mjs`);
  if (text.indexOf(find, first + find.length) !== -1) throw new Error(`fixture: "${label}": anchor occurs more than once`);
  return text.slice(0, first) + replace + text.slice(first + find.length);
}

/** Applies edits to files under `dir`, reading and writing each file once. */
export async function applyEdits(dir, edits) {
  const byFile = new Map();
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  for (const [file, fileEdits] of byFile) {
    const target = path.join(dir, file);
    let text = await readFile(target, 'utf8');
    for (const edit of fileEdits) text = replaceExactlyOnce(text, edit.find, edit.replace, `${file}: ${edit.label}`);
    await writeFile(target, text);
  }
}

/** Copies examples/checkout to `to` without the EXCLUDED top-level entries. */
export async function copyExample(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(from, source);
      return relative === '' || !EXCLUDED.includes(relative.split(path.sep)[0]);
    },
  });
}

/** Spec §7.1 step 2: edits, removals, and the README. Throws when any anchor or removed path is missing. */
export async function transformFixture(dir) {
  await applyEdits(dir, FIXTURE_EDITS);
  for (const relative of REMOVED_PATHS) {
    const target = path.join(dir, relative);
    await stat(target).catch(() => {
      throw new Error(`fixture: ${relative} is missing; the example changed, update REMOVED_PATHS in examples/checkout/eval/lib/fixture.mjs`);
    });
    await rm(target, { recursive: true });
  }
  await writeFile(path.join(dir, 'README.md'), FIXTURE_README);
}

const TEXT_FILE = /\.(ts|tsx|cts|mts|js|mjs|cjs|map|json|md|ya?ml|txt)$/i;
const EXCERPT = 80;

/** Every occurrence of a HINT_TERMS term in `text`, as `{ file, line, term, excerpt }`; `excerpt` is the text around the occurrence. */
export function hintsInText(text, file) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const term of HINT_TERMS) {
      for (const match of line.matchAll(new RegExp(term.source, 'gi'))) {
        const excerpt = line.slice(Math.max(0, match.index - EXCERPT), match.index + match[0].length + EXCERPT);
        hits.push({ file, line: index + 1, term: term.source, excerpt: excerpt.trim() });
      }
    }
  });
  return hits;
}

/** Whether a hit matches an entry of HINT_ALLOWED. */
export function isAllowedHint(hit, allowed = HINT_ALLOWED) {
  return allowed.some((entry) => entry.file.test(hit.file) && entry.text.test(hit.excerpt));
}

/** Folder names the fixture scan skips: dependencies and git, which prepare scans separately where sessions can see them. */
export const FIXTURE_SKIP = new Set(['node_modules', '.git', 'vendor', '.ironbird', '.expo']);

/**
 * Hits under `dir` that no HINT_ALLOWED entry explains. `prefix` is prepended to each relative path
 * (for example `node_modules/@ironbird/`), so allow entries can tell surfaces apart.
 */
export async function findHints(dir, { prefix = '', skip = FIXTURE_SKIP, base = dir } = {}) {
  const hits = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...(await findHints(full, { prefix, skip, base })));
    else if (TEXT_FILE.test(entry.name)) {
      const file = prefix + path.relative(base, full).split(path.sep).join('/');
      hits.push(...hintsInText(await readFile(full, 'utf8'), file).filter((hit) => !isAllowedHint(hit)));
    }
  }
  return hits;
}
