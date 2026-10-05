import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GATE_SEEDS, RACE_INVARIANT, RACE_MAX_STEPS, RACE_NUM_RUNS, RACE_STEPS, runRaceModel, type RaceOutcome } from './race-model';

// M4 exit criterion 1 (docs/roadmap.md): with the planted scenario removed, model-based testing
// finds the race within 1,000 runs for at least 9 of 10 seeds, and the same configuration without
// PLANT_RACE finds nothing in 10 × 1,000 runs. Runs only through `pnpm gate:m4` (the `gate` Vitest
// project), never in `pnpm test`: the control alone is 10,000 model runs. CI re-checks the witness
// and one measured seed instead (model.smoke.test.ts). The result file is rewritten after every
// seed, before any assertion, so a failed or interrupted gate still leaves its measurements.

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(here, '../.ironbird/gate');
const TRACES = path.join(OUT_DIR, 'traces');
const RESULT_FILE = path.join(OUT_DIR, `m4-race-gate.node${process.versions.node.split('.')[0]}.json`);
const REQUIRED = 9;
const GATE_TIMEOUT_MS = 1_800_000;

const planted: RaceOutcome[] = [];
const control: RaceOutcome[] = [];

const total = (outcomes: RaceOutcome[]): number => outcomes.reduce((sum, outcome) => sum + outcome.wallMs, 0);

const seedRecord = (outcome: RaceOutcome): Record<string, unknown> => ({
  seed: outcome.seed,
  found: outcome.found,
  runs: outcome.runs,
  wallMs: outcome.wallMs,
  ...(outcome.failure
    ? { invariant: outcome.failure.invariant, path: outcome.failure.path, steps: outcome.failure.steps, trace: outcome.failure.scenarioFile }
    : { stepsApplied: outcome.stepsApplied, stepsRejected: outcome.stepsRejected }),
});

async function record(): Promise<void> {
  const found = planted.filter((outcome) => outcome.found);
  const fastest = [...found].sort((a, b) => a.runs - b.runs || a.seed - b.seed)[0];
  const result = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    machine: `${os.cpus()[0]?.model ?? 'unknown cpu'}, ${os.platform()} ${os.release()}`,
    config: { numRuns: RACE_NUM_RUNS, maxSteps: RACE_MAX_STEPS, seeds: [...GATE_SEEDS], invariant: RACE_INVARIANT, steps: RACE_STEPS },
    planted: { found: found.length, of: planted.length, required: REQUIRED, wallMs: total(planted), seeds: planted.map(seedRecord) },
    control: { found: control.filter((outcome) => outcome.found).length, of: control.length, wallMs: total(control), seeds: control.map(seedRecord) },
    smoke: fastest ? { seed: fastest.seed, runs: fastest.runs, steps: fastest.failure?.steps ?? [], wallMs: fastest.wallMs } : null,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);
}

beforeAll(async () => {
  // Traces from an earlier gate run would be indistinguishable from this run's.
  await rm(TRACES, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('M4 race gate (exit criterion 1)', () => {
  it('finds the planted race within 1,000 runs for at least 9 of 10 seeds', async () => {
    for (const seed of GATE_SEEDS) {
      planted.push(await runRaceModel({ seed, plant: true, artifacts: path.join(TRACES, `seed-${seed}`) }));
      await record();
    }
    for (const outcome of planted.filter((entry) => entry.found)) {
      expect(outcome.failure?.invariant, `seed ${outcome.seed}`).toBe(RACE_INVARIANT);
      expect(outcome.runs, `seed ${outcome.seed}`).toBeLessThanOrEqual(RACE_NUM_RUNS);
    }
    const foundSeeds = planted.filter((entry) => entry.found).map((entry) => entry.seed);
    expect(foundSeeds.length, `found in seeds ${foundSeeds.join(', ')}`).toBeGreaterThanOrEqual(REQUIRED);
  }, GATE_TIMEOUT_MS);

  it('finds nothing in 10 × 1,000 runs without PLANT_RACE, even when the shell sets it', async () => {
    vi.stubEnv('PLANT_RACE', '1');
    for (const seed of GATE_SEEDS) {
      control.push(await runRaceModel({ seed, plant: false, artifacts: path.join(TRACES, `control-seed-${seed}`) }));
      await record();
    }
    expect(control.filter((entry) => entry.found).map((entry) => ({ seed: entry.seed, steps: entry.failure?.steps }))).toEqual([]);
    expect(control.map((entry) => entry.runs)).toEqual(GATE_SEEDS.map(() => RACE_NUM_RUNS));
  }, GATE_TIMEOUT_MS);
});
