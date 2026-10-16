// What the acceptance scenario asks of an integration (M5 design D11): the commands it sends, the
// fakes and controls it drives, the state paths it checks, and whether it advances the clock. TASK.md
// carries this as a generated block, so the task sheet and the scenario can't drift, and the grader's
// `commands` check uses its command names.

/**
 * The scenario in the wired example that exercise/acceptance.yaml (and so its generated copy in
 * integration-exercise/) copies byte for byte, relative to examples/bare-redux. Chosen in Task 7
 * Step 6 by the rule there.
 */
export const ACCEPTANCE_SOURCE = 'ironbird/scenarios/ack-reorder.yaml';

const byName = (a, b) => a.name.localeCompare(b.name);

/** The contract of a parsed scenario (`parseScenario` from @ironbird/cli/runner), sorted, with the first payload or condition seen for each entry. */
export function acceptanceContract(scenario) {
  const commands = new Map();
  const fakes = new Map();
  const paths = new Map();
  let clock = false;
  for (const step of scenario.steps) {
    if (step.kind === 'send' && !commands.has(step.command)) commands.set(step.command, step.payload);
    else if (step.kind === 'fake') {
      if (!fakes.has(step.fake)) fakes.set(step.fake, new Map());
      const controls = fakes.get(step.fake);
      if (!controls.has(step.control)) controls.set(step.control, step.payload);
    } else if ((step.kind === 'wait' || step.kind === 'expect') && !paths.has(step.path)) paths.set(step.path, step.condition);
    else if (step.kind === 'clock') clock = true;
  }
  return {
    commands: [...commands].map(([name, payload]) => ({ name, payload })).sort(byName),
    fakes: [...fakes]
      .map(([fake, controls]) => ({ fake, controls: [...controls].map(([name, payload]) => ({ name, payload })).sort(byName) }))
      .sort((a, b) => a.fake.localeCompare(b.fake)),
    paths: [...paths].map(([path, condition]) => ({ path, condition })).sort((a, b) => a.path.localeCompare(b.path)),
    clock,
  };
}

/** The command names the grader's `commands` check requires. */
export function commandNames(contract) {
  return contract.commands.map((command) => command.name);
}

const code = (value) => `\`${JSON.stringify(value).replaceAll('|', '\\|')}\``;

/** The contract as markdown: three tables (or "None.") and one sentence about the clock. Ends with a newline. */
export function renderContract(contract) {
  const lines = ['### Commands', ''];
  if (contract.commands.length === 0) lines.push('None.');
  else {
    lines.push('| Command | Payload in `acceptance.yaml` |', '|---|---|');
    for (const command of contract.commands) lines.push(`| \`${command.name}\` | ${code(command.payload)} |`);
  }
  lines.push('', '### Fakes', '');
  if (contract.fakes.length === 0) lines.push('None.');
  else {
    lines.push('| Fake | Control | Payload in `acceptance.yaml` |', '|---|---|---|');
    for (const fake of contract.fakes) for (const control of fake.controls) lines.push(`| \`${fake.fake}\` | \`${control.name}\` | ${code(control.payload)} |`);
  }
  lines.push('', '### State the scenario checks', '');
  if (contract.paths.length === 0) lines.push('None.');
  else {
    lines.push('| Path | Condition |', '|---|---|');
    for (const entry of contract.paths) lines.push(`| \`${entry.path}\` | ${code(entry.condition)} |`);
  }
  lines.push(
    '',
    contract.clock
      ? 'The scenario advances the clock, so the headless entry must schedule time through the `clock` that `defineHeadless` passes in, never through global timers.'
      : "The scenario doesn't advance the clock.",
    '',
  );
  return lines.join('\n');
}

export const CONTRACT_START = '<!-- contract:start (written by examples/bare-redux/eval/render-task.mjs from acceptance.yaml; do not edit by hand) -->';
export const CONTRACT_END = '<!-- contract:end -->';

/** The whole generated block, markers included. */
export function contractBlock(contract) {
  return `${CONTRACT_START}\n\n${renderContract(contract)}${CONTRACT_END}`;
}

/** `text` with everything from the start marker to the end marker replaced by `block`. */
export function replaceContractBlock(text, block) {
  const start = text.indexOf(CONTRACT_START);
  const end = text.indexOf(CONTRACT_END);
  if (start === -1 || end === -1 || end < start) throw new Error('TASK.md has no contract markers; restore the contract:start and contract:end lines');
  return `${text.slice(0, start)}${block}${text.slice(end + CONTRACT_END.length)}`;
}
