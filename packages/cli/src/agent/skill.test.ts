import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const skillDir = path.resolve(__dirname, '../../skills/ironbird');
const read = (file: string): Promise<string> => readFile(path.join(skillDir, file), 'utf8');

// Spec D7: the skill must not name the example app, its commands, its fakes, or its bug, or the
// eval measures the skill leaking the answer instead of the agent using the loop.
const LEAKS = /checkout|\bcart\b|payment|totalCents|zero total|cut-45|haircut|plant_?race|\brace\b|\breader\b|setEcho|\bemit\b/i;

const TOOLS = [
  'ironbird_status',
  'ironbird_describe',
  'ironbird_send',
  'ironbird_step',
  'ironbird_state',
  'ironbird_wait',
  'ironbird_settle',
  'ironbird_fake',
  'ironbird_fake_calls',
  'ironbird_events',
  'ironbird_clock_advance',
  'ironbird_clock_now',
  'ironbird_screenshot',
  'ironbird_run_scenario',
  'ironbird_reset',
  'ironbird_reload',
];

describe('the ironbird skill', () => {
  it('has Agent Skills front matter naming it ironbird with a when-to-use description', async () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(await read('SKILL.md'));
    expect(match).not.toBeNull();
    const front = parse(match?.[1] ?? '') as Record<string, unknown>;
    expect(front['name']).toBe('ironbird');
    expect(String(front['description'])).toMatch(/^Use when/);
  });

  it('stays under 200 lines', async () => {
    expect((await read('SKILL.md')).split('\n').length).toBeLessThan(200);
  });

  it('teaches the six steps with every MCP tool and the CLI equivalents', async () => {
    const skill = await read('SKILL.md');
    for (const heading of ['### 1. Orient', '### 2. Reproduce headlessly', '### 3. Pin it down as a scenario', '### 4. Fix', '### 5. Check on a device', '### 6. Report with evidence']) {
      expect(skill).toContain(heading);
    }
    for (const tool of TOOLS) expect(skill, tool).toContain(`\`${tool}\``);
    for (const command of ['npx ironbird status', 'npx ironbird serve', 'npx ironbird scenario run', 'npx ironbird reload', 'npx ironbird screenshot']) expect(skill, command).toContain(command);
    expect(skill).toContain('references/scenarios.md');
  });

  it('never names the example app, its commands, or its bug', async () => {
    for (const file of ['SKILL.md', 'references/scenarios.md']) expect(await read(file), file).not.toMatch(LEAKS);
  });
});
