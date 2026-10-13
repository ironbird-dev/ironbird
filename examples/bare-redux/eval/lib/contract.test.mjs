import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseScenario } from '@ironbird/cli/runner';
import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_SOURCE, acceptanceContract, commandNames, CONTRACT_END, CONTRACT_START, contractBlock, renderContract, replaceContractBlock } from './contract.mjs';
import { ACCEPTANCE, exampleDir, TASK_SHEET } from './paths.mjs';
import { installCommands, RELEASE_VERSION } from './vendor.mjs';

const step = (kind, fields) => ({ kind, optional: false, raw: {}, ...fields });
const scenario = {
  name: 'Acceptance',
  steps: [
    step('send', { command: 'notes.add', payload: { title: 'Milk' }, repeat: 1, settle: true }),
    step('fake', { fake: 'server', control: 'hold', payload: {}, repeat: 1, settle: true }),
    step('send', { command: 'notes.add', payload: { title: 'Eggs' }, repeat: 1, settle: true }),
    step('fake', { fake: 'server', control: 'release', payload: { order: 'reversed' }, repeat: 1, settle: true }),
    step('clock', { ms: 500, settle: true, optional: true }),
    step('wait', { path: 'notes.pending', condition: { equals: 0 }, timeoutMs: 5000 }),
    step('expect', { path: 'notes.items.length', condition: { equals: 2 } }),
    step('fake', { fake: 'auth', control: 'signIn', payload: { user: 'a|b' }, repeat: 1, settle: true }),
    step('reset', {}),
  ],
};

describe('acceptanceContract', () => {
  it('lists the commands, fakes, controls, and state paths a scenario uses, sorted, each with the first payload or condition it uses', () => {
    const contract = acceptanceContract(scenario);
    expect(contract).toEqual({
      commands: [{ name: 'notes.add', payload: { title: 'Milk' } }],
      fakes: [
        { fake: 'auth', controls: [{ name: 'signIn', payload: { user: 'a|b' } }] },
        { fake: 'server', controls: [{ name: 'hold', payload: {} }, { name: 'release', payload: { order: 'reversed' } }] },
      ],
      paths: [
        { path: 'notes.items.length', condition: { equals: 2 } },
        { path: 'notes.pending', condition: { equals: 0 } },
      ],
      clock: true,
    });
    expect(commandNames(contract)).toEqual(['notes.add']);
  });
});

describe('renderContract', () => {
  it('renders markdown tables, escaping pipes, and says what the clock needs', () => {
    expect(renderContract(acceptanceContract(scenario))).toBe(
      [
        '### Commands',
        '',
        '| Command | Payload in `acceptance.yaml` |',
        '|---|---|',
        '| `notes.add` | `{"title":"Milk"}` |',
        '',
        '### Fakes',
        '',
        '| Fake | Control | Payload in `acceptance.yaml` |',
        '|---|---|---|',
        '| `auth` | `signIn` | `{"user":"a\\|b"}` |',
        '| `server` | `hold` | `{}` |',
        '| `server` | `release` | `{"order":"reversed"}` |',
        '',
        '### State the scenario checks',
        '',
        '| Path | Condition |',
        '|---|---|',
        '| `notes.items.length` | `{"equals":2}` |',
        '| `notes.pending` | `{"equals":0}` |',
        '',
        'The scenario advances the clock, so the headless entry must schedule time through the `clock` that `defineHeadless` passes in, never through global timers.',
        '',
      ].join('\n'),
    );
  });

  it('says None for an empty section, and nothing about time without a clock step', () => {
    const text = renderContract({ commands: [], fakes: [], paths: [], clock: false });
    expect(text.match(/None\./g)).toHaveLength(3);
    expect(text).toContain("The scenario doesn't advance the clock.");
  });
});

describe('the contract block in TASK.md', () => {
  it('replaces whatever sits between the markers and nothing else', () => {
    const block = contractBlock({ commands: [], fakes: [], paths: [], clock: false });
    expect(block.startsWith(`${CONTRACT_START}\n\n`)).toBe(true);
    expect(block.endsWith(`\n${CONTRACT_END}`)).toBe(true);
    const text = `before\n${CONTRACT_START}\nold\n${CONTRACT_END}\nafter\n`;
    expect(replaceContractBlock(text, block)).toBe(`before\n${block}\nafter\n`);
  });

  it('throws when the markers are missing', () => {
    expect(() => replaceContractBlock('no markers here', 'x')).toThrow(/contract markers/);
  });
});

describe('the exercise materials (run pnpm build first)', () => {
  it('TASK.md carries the contract of acceptance.yaml exactly as render-task.mjs writes it', async () => {
    const contract = acceptanceContract(parseScenario(await readFile(ACCEPTANCE, 'utf8'), ACCEPTANCE));
    expect(await readFile(TASK_SHEET, 'utf8')).toContain(contractBlock(contract));
  });

  it('acceptance.yaml is a byte-for-byte copy of the wired example scenario it was chosen from', async () => {
    expect(ACCEPTANCE_SOURCE).not.toContain('CHOSEN');
    expect(await readFile(ACCEPTANCE, 'utf8')).toBe(await readFile(path.join(exampleDir, ACCEPTANCE_SOURCE), 'utf8'));
  });

  it('acceptance.yaml sends a command, drives a fake, and checks state', async () => {
    const contract = acceptanceContract(parseScenario(await readFile(ACCEPTANCE, 'utf8'), ACCEPTANCE));
    expect(contract.commands.length).toBeGreaterThan(0);
    expect(contract.fakes.length).toBeGreaterThan(0);
    expect(contract.paths.length).toBeGreaterThan(0);
  });

  it('TASK.md gives the exact install commands the proxy template is checked with', async () => {
    const task = await readFile(TASK_SHEET, 'utf8');
    for (const command of installCommands(RELEASE_VERSION)) expect(task).toContain(command);
  });
});
