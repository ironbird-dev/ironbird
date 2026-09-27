import type { RecordedEvent, ScenarioResult } from '@ironbird/core';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import headless from '../../../examples/checkout/src/ironbird/headless';
import { createDaemonClient, type DaemonClient } from '../src/cli/client';
import { startDaemon } from '../src/daemon';
import { createHeadlessTarget } from '../src/headless-target';
import { loadScenarioFiles, type Scenario } from '../src/scenario/parse';
import { runScenario } from '../src/scenario/run';

// Gate criteria 1 and 3 (docs/roadmap.md, M2). Both tests boot the daemon in process and call the
// runner with a daemon client: invoking the CLI binary per step would take minutes over 500 runs.
const example = path.resolve(__dirname, '../../../examples/checkout');
const scenariosDir = path.join(example, 'ironbird/scenarios');
const RACE = path.join(scenariosDir, 'race-success-before-confirmation.yaml');
// The same start as ironbird.config.ts, so event timestamps match what `ironbird serve` records.
const CLOCK_START = '2026-01-01T00:00:00.000Z';
// 100 runs per scenario is the roadmap's number. IRONBIRD_SOAK_RUNS raises it for local soaks.
const RUNS = Number(process.env['IRONBIRD_SOAK_RUNS'] ?? 100);

interface Session {
  client: DaemonClient;
  close(): Promise<void>;
}

const sessions: Session[] = [];

// `env` is passed whole rather than layered over process.env, so a PLANT_RACE in the developer's
// shell can never leak into the unplanted boot.
async function boot(env: Record<string, string>): Promise<Session> {
  const target = await createHeadlessTarget({
    definition: headless,
    appId: 'com.example.checkout',
    clockStart: CLOCK_START,
    settleTimeoutMs: 5_000,
    env,
    log: () => {},
    entryPath: path.join(example, 'src/ironbird/headless.ts'),
  });
  const daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', log: () => {} });
  const session: Session = {
    client: createDaemonClient({ url: daemon.url }),
    close: async () => {
      await daemon.close();
      await target.dispose();
    },
  };
  sessions.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function loadRace(): Promise<{ file: string; scenario: Scenario }> {
  const [race] = await loadScenarioFiles([RACE], example);
  if (!race) throw new Error(`No scenario at ${RACE}`);
  return race;
}

interface Observation {
  result: Omit<ScenarioResult, 'durationMs'>;
  state: unknown;
  events: RecordedEvent[];
}

// One run from a fresh app: `reset` recreates the clock, recorder, tracker, and fakes, so sequence
// numbers, timestamps, and ids start over and the whole observation is comparable across runs.
// `durationMs` is wall time and the one field expected to differ.
async function observe(client: DaemonClient, file: string, scenario: Scenario): Promise<Observation> {
  await client.rpc('reset', {}, 'headless');
  const { durationMs: _durationMs, ...result } = await runScenario(client, scenario, { file, artifacts: false });
  const { value: state } = await client.rpc<{ value: unknown }>('getState', { path: '' }, 'headless');
  const { events } = await client.rpc<{ events: RecordedEvent[] }>('events', { since: 0 }, 'headless');
  return { result, state, events };
}

describe('the race scenario (gate criterion 1)', () => {
  it('fails at the last expect with PLANT_RACE=1 and passes without it', async () => {
    const race = await loadRace();

    const planted = await boot({ PLANT_RACE: '1' });
    const failed = await runScenario(planted.client, race.scenario, { file: race.file, artifacts: false });
    expect(failed).toMatchObject({ scenario: 'Payment success arrives before order confirmation', file: race.file, target: 'headless', passed: false, stepsRun: 10, skipped: [], artifacts: null });
    expect(failed.failedStep).toMatchObject({ index: 9, step: { expect: 'order.totalCents', equals: 4_500 }, expected: { equals: 4_500 }, actual: 0 });
    expect(failed.failedStep?.error).toBeUndefined();

    const clean = await boot({});
    const passed = await runScenario(clean.client, race.scenario, { file: race.file, artifacts: false });
    expect(passed).toMatchObject({ scenario: 'Payment success arrives before order confirmation', target: 'headless', passed: true, stepsRun: 10, skipped: [], artifacts: null });
    expect(passed.failedStep).toBeUndefined();
  }, 60_000);
});

describe('headless determinism (gate criterion 3)', () => {
  it(`runs every example scenario ${RUNS} times with no divergence`, async () => {
    const scenarios = await loadScenarioFiles([scenariosDir], example);
    expect(scenarios.map((entry) => path.basename(entry.file))).toEqual([
      'checkout-saved-card.yaml',
      'duplicate-success.yaml',
      'missing-echo-times-out.yaml',
      'race-success-before-confirmation.yaml',
      'reader-disconnect.yaml',
    ]);
    const { client } = await boot({});
    for (const { file, scenario } of scenarios) {
      const first = await observe(client, file, scenario);
      expect(first.result.passed, `${scenario.name}: the first run failed at ${JSON.stringify(first.result.failedStep)}`).toBe(true);
      expect(first.events.length).toBeGreaterThan(0);
      for (let run = 2; run <= RUNS; run += 1) {
        const current = await observe(client, file, scenario);
        expect(current, `${scenario.name}: run ${run} diverged from run 1`).toEqual(first);
      }
    }
  }, RUNS * 3_000);
});
