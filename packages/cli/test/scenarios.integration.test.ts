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
