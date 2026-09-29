import { isIronbirdError } from '@ironbird/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenarioFiles, parseScenario, type ScenarioIssue } from './parse';

const FILE = '/app/ironbird/scenarios/x.yaml';

function failure(source: string): { message: string; details: { file: string; issues: ScenarioIssue[] } } {
  try {
    parseScenario(source, FILE);
  } catch (error) {
    if (isIronbirdError(error) && error.code === 'INVALID_SCENARIO') return { message: error.message, details: error.details as { file: string; issues: ScenarioIssue[] } };
    throw error;
  }
  throw new Error('expected INVALID_SCENARIO');
}

const EVERY_KIND = `name: Every kind
description: One of each
target: headless
steps:
  - send: cart.addItem
    payload: { sku: cut-45, qty: 1 }
    repeat: 2
    settle: false
  - send: cart.clear
  - fake: api
    control: emit
    payload: { event: payment.succeeded }
    optional: true
  - clock: 300ms
  - clock: 1500
    settle: false
  - wait: payment.status
    equals: awaitingServerEcho
    timeout: 2s
  - wait: order.id
    exists: true
  - expect: order.totalCents
    notEquals: 0
  - expect: receipt.text
    matches: ^Thank
  - screenshot: after-pay
    optional: true
  - reset: true
`;

describe('parseScenario', () => {
  it('parses every step kind, normalizing durations, defaults, and conditions, and keeps the raw step', () => {
    expect(parseScenario(EVERY_KIND, FILE)).toEqual({
      name: 'Every kind',
      description: 'One of each',
      target: 'headless',
      steps: [
        { kind: 'send', command: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, repeat: 2, settle: false, optional: false, raw: { send: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, repeat: 2, settle: false } },
        { kind: 'send', command: 'cart.clear', payload: {}, repeat: 1, settle: true, optional: false, raw: { send: 'cart.clear' } },
        { kind: 'fake', fake: 'api', control: 'emit', payload: { event: 'payment.succeeded' }, repeat: 1, settle: true, optional: true, raw: { fake: 'api', control: 'emit', payload: { event: 'payment.succeeded' }, optional: true } },
        { kind: 'clock', ms: 300, settle: true, optional: false, raw: { clock: '300ms' } },
        { kind: 'clock', ms: 1500, settle: false, optional: false, raw: { clock: 1500, settle: false } },
        { kind: 'wait', path: 'payment.status', condition: { equals: 'awaitingServerEcho' }, timeoutMs: 2_000, optional: false, raw: { wait: 'payment.status', equals: 'awaitingServerEcho', timeout: '2s' } },
        { kind: 'wait', path: 'order.id', condition: { exists: true }, timeoutMs: 5_000, optional: false, raw: { wait: 'order.id', exists: true } },
        { kind: 'expect', path: 'order.totalCents', condition: { notEquals: 0 }, optional: false, raw: { expect: 'order.totalCents', notEquals: 0 } },
        { kind: 'expect', path: 'receipt.text', condition: { matches: '^Thank' }, optional: false, raw: { expect: 'receipt.text', matches: '^Thank' } },
        { kind: 'screenshot', name: 'after-pay', optional: true, raw: { screenshot: 'after-pay', optional: true } },
        { kind: 'reset', optional: false, raw: { reset: true } },
      ],
    });
  });

  it('omits description and target when the file has none, and keeps YAML 1.2 strings such as on and yes', () => {
    const scenario = parseScenario('name: Minimal\nsteps:\n  - wait: flag\n    equals: on\n  - expect: other\n    equals: yes\n', FILE);
    expect(scenario).toEqual({
      name: 'Minimal',
      steps: [
        { kind: 'wait', path: 'flag', condition: { equals: 'on' }, timeoutMs: 5_000, optional: false, raw: { wait: 'flag', equals: 'on' } },
        { kind: 'expect', path: 'other', condition: { equals: 'yes' }, optional: false, raw: { expect: 'other', equals: 'yes' } },
      ],
    });
    expect('description' in scenario).toBe(false);
    expect('target' in scenario).toBe(false);
  });

  it('rejects an unknown step key with its path and line', () => {
    const { message, details } = failure('name: Typo\nsteps:\n  - send: cart.addItem\n    payloads: { qty: 1 }\n');
    expect(details).toEqual({ file: FILE, issues: [{ path: ['steps', 0, 'payloads'], message: 'unknown key payloads', line: 4 }] });
    expect(message).toBe(`Invalid scenario ${FILE}:4: steps.0.payloads: unknown key payloads`);
  });

  it('rejects an unknown top-level key, a missing name, and empty steps', () => {
    expect(failure('name: X\nsteps: []\nsteps2: []\n').details.issues).toEqual([
      { path: ['steps'], message: 'Too small: expected array to have >=1 items', line: 2 },
      { path: ['steps2'], message: 'unknown key steps2', line: 3 },
    ]);
    expect(failure('steps:\n  - reset: true\n').details.issues).toEqual([{ path: ['name'], message: 'Invalid input: expected string, received undefined', line: 1 }]);
  });

  it('requires exactly one step kind per step', () => {
    expect(failure('name: X\nsteps:\n  - optional: true\n  - send: a\n    clock: 1s\n').details.issues).toEqual([
      { path: ['steps', 0], message: 'expected exactly one of send, fake, clock, wait, expect, screenshot, reset, got none', line: 3 },
      { path: ['steps', 1], message: 'expected exactly one of send, fake, clock, wait, expect, screenshot, reset, got send and clock', line: 4 },
    ]);
  });

  it('validates conditions through parseCondition and reports them with the step line', () => {
    expect(failure('name: X\nsteps:\n  - wait: a\n  - expect: b\n    equals: 1\n    exists: true\n  - expect: c\n    matches: "("\n').details.issues).toEqual([
      { path: ['steps', 0], message: 'expected exactly one condition, got 0', line: 3 },
      { path: ['steps', 1], message: 'expected exactly one condition, got 2', line: 4 },
      { path: ['steps', 2, 'matches'], message: expect.stringContaining('Invalid regular expression'), line: 8 },
    ]);
    expect(failure('name: X\nsteps:\n  - wait: a\n    exists: maybe\n').details.issues).toEqual([{ path: ['steps', 0, 'exists'], message: 'Invalid input: expected boolean, received string', line: 4 }]);
  });

  it('validates durations with the CLI duration parser', () => {
    expect(failure('name: X\nsteps:\n  - clock: soon\n  - wait: a\n    exists: true\n    timeout: 2h\n').details.issues).toEqual([
      { path: ['steps', 0, 'clock'], message: 'Invalid duration "soon"; use a number with an optional ms, s, or m suffix', line: 3 },
      { path: ['steps', 1, 'timeout'], message: 'Invalid duration "2h"; use a number with an optional ms, s, or m suffix', line: 6 },
    ]);
  });

  it('rejects repeat below 1, reset other than true, and a payload-less control name', () => {
    expect(failure('name: X\nsteps:\n  - send: a\n    repeat: 0\n  - reset: false\n  - fake: api\n').details.issues).toEqual([
      { path: ['steps', 0, 'repeat'], message: 'Too small: expected number to be >=1', line: 4 },
      { path: ['steps', 1, 'reset'], message: 'Invalid input: expected true', line: 5 },
      { path: ['steps', 2, 'control'], message: 'Invalid input: expected string, received undefined', line: 6 },
    ]);
  });

  it('reports YAML syntax errors with the line the parser blames, and a non-mapping document', () => {
    const syntax = failure('name: [\n  oops\nsteps: []\n');
    expect(syntax.details.issues[0]).toMatchObject({ path: [], line: 3 });
    expect(syntax.details.issues[0]?.message).toContain('Flow sequence');
    expect(failure('just text\n').details.issues).toEqual([{ path: [], message: 'expected a mapping with name and steps', line: 1 }]);
    expect(failure('').details.issues).toEqual([{ path: [], message: 'expected a mapping with name and steps', line: 1 }]);
  });

  it('counts the extra issues in the message', () => {
    expect(failure('name: X\nsteps:\n  - clock: soon\n  - clock: later\n').message).toBe(`Invalid scenario ${FILE}:3: steps.0.clock: Invalid duration "soon"; use a number with an optional ms, s, or m suffix (and 1 more)`);
  });
});

describe('loadScenarioFiles', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('expands directories to their yaml files in name order, resolves against cwd, and parses everything', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenarios-'));
    await mkdir(path.join(dir, 'scenarios/nested'), { recursive: true });
    await writeFile(path.join(dir, 'scenarios/b.yaml'), 'name: B\nsteps:\n  - reset: true\n');
    await writeFile(path.join(dir, 'scenarios/a.yml'), 'name: A\nsteps:\n  - reset: true\n');
    await writeFile(path.join(dir, 'scenarios/notes.txt'), 'not a scenario');
    await writeFile(path.join(dir, 'scenarios/nested/c.yaml'), 'name: C\nsteps:\n  - reset: true\n');
    await writeFile(path.join(dir, 'single.yaml'), 'name: Single\nsteps:\n  - reset: true\n');
    const loaded = await loadScenarioFiles(['scenarios', 'single.yaml'], dir);
    expect(loaded.map((entry) => [entry.file, entry.scenario.name])).toEqual([
      [path.join(dir, 'scenarios/a.yml'), 'A'],
      [path.join(dir, 'scenarios/b.yaml'), 'B'],
      [path.join(dir, 'single.yaml'), 'Single'],
    ]);
  });

  it('fails with INVALID_SCENARIO for a missing path or a directory without scenario files', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenarios-'));
    await mkdir(path.join(dir, 'empty'));
    const missing = await loadScenarioFiles(['nope.yaml'], dir).catch((error: unknown) => error);
    expect(isIronbirdError(missing) && missing.code).toBe('INVALID_SCENARIO');
    expect(isIronbirdError(missing) && missing.details).toEqual({ file: path.join(dir, 'nope.yaml'), issues: [{ path: [], message: 'no such file or directory' }] });
    const empty = await loadScenarioFiles(['empty'], dir).catch((error: unknown) => error);
    expect(isIronbirdError(empty) && empty.details).toEqual({ file: path.join(dir, 'empty'), issues: [{ path: [], message: 'no scenario files (*.yaml, *.yml) in directory' }] });
  });

  it('parses every file before returning, so one invalid file fails the whole load', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-scenarios-'));
    await writeFile(path.join(dir, 'a.yaml'), 'name: A\nsteps:\n  - reset: true\n');
    await writeFile(path.join(dir, 'b.yaml'), 'name: B\nsteps:\n  - reset: true\n    extra: 1\n');
    const error = await loadScenarioFiles([dir], dir).catch((caught: unknown) => caught);
    expect(isIronbirdError(error) && error.code).toBe('INVALID_SCENARIO');
    expect(isIronbirdError(error) && (error.details as { file: string }).file).toBe(path.join(dir, 'b.yaml'));
  });
});
