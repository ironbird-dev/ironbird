import { messageOf, type Description, type FakeCallsResult, type RecordedEvent, type ScenarioResult } from '@ironbird/core';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonClient } from '../cli/client';
import type { Scenario } from './parse';

const SLUG_MAX = 60;

/** A filesystem-safe form of a scenario name: lowercase, dashes for anything else, at most 60 characters. */
export function scenarioSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug === '' ? 'scenario' : slug;
}

/** `<root>/runs/<UTC stamp with milliseconds>-<slug>`, the stamp with `:` and `.` replaced so it is a valid name everywhere. */
export function runDirectoryPath(root: string, name: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.resolve(root, 'runs', `${stamp}-${scenarioSlug(name)}`);
}

export async function createRunDirectory(root: string, name: string): Promise<string> {
  const dir = runDirectoryPath(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface RunArtifacts {
  /** The run directory, created before the first step so screenshots can land in it. */
  readonly dir: string;
  /**
   * Records where the event log and each fake's call log stand, with `limit: 0` so nothing is
   * transferred. Called after the initial `describe` and again after every `reset` step, which
   * restarts both logs. Never throws: a cursor that can't be read is reported by `collect`.
   */
  capture(): Promise<void>;
  /**
   * Writes `result.json`, a copy of the scenario file, `events.jsonl`, `state.json`, and
   * `calls/<fake>.json`, each best effort: a file that can't be gathered or written is left out
   * and named in the returned result's `artifactErrors`.
   */
  collect(result: ScenarioResult): Promise<ScenarioResult>;
}

interface EventsPage {
  events: RecordedEvent[];
  nextSeq: number;
  truncated: boolean;
}

export async function createRunArtifacts(options: { root: string; scenario: Scenario; file: string; client: DaemonClient; target: string; description: Description }): Promise<RunArtifacts> {
  const { client, target, file } = options;
  const dir = await createRunDirectory(options.root, options.scenario.name);
  const fakes = options.description.capabilities.includes('fakes') ? Object.keys(options.description.fakes) : [];
  const cursors = { events: 0, calls: {} as Record<string, number> };
  const errors: string[] = [];

  const attempt = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      errors.push(`${label}: ${messageOf(error)}`);
    }
  };

  return {
    dir,
    async capture() {
      await attempt('events.jsonl', async () => {
        cursors.events = (await client.rpc<EventsPage>('events', { limit: 0 }, target)).nextSeq;
      });
      for (const fake of fakes) {
        await attempt(`calls/${fake}.json`, async () => {
          cursors.calls[fake] = (await client.rpc<FakeCallsResult>('fakeCalls', { fake, limit: 0 }, target)).nextSeq;
        });
      }
    },
    async collect(result) {
      await attempt(path.basename(file), () => copyFile(file, path.join(dir, path.basename(file))));
      await attempt('events.jsonl', async () => {
        const page = await client.rpc<EventsPage>('events', { since: cursors.events }, target);
        await writeFile(path.join(dir, 'events.jsonl'), page.events.map((event) => `${JSON.stringify(event)}\n`).join(''));
        if (page.truncated) errors.push(`events.jsonl: the recorder dropped events before seq ${cursors.events}; the log is incomplete`);
      });
      await attempt('state.json', async () => {
        const { value } = await client.rpc<{ value: unknown }>('getState', { path: '' }, target);
        await writeFile(path.join(dir, 'state.json'), `${JSON.stringify(value, null, 2)}\n`);
      });
      if (fakes.length > 0) await attempt('calls', () => mkdir(path.join(dir, 'calls'), { recursive: true }));
      for (const fake of fakes) {
        await attempt(`calls/${fake}.json`, async () => {
          const page = await client.rpc<FakeCallsResult>('fakeCalls', { fake, since: cursors.calls[fake] ?? 0 }, target);
          await writeFile(path.join(dir, 'calls', `${fake}.json`), `${JSON.stringify(page.calls, null, 2)}\n`);
        });
      }
      const withErrors = (): ScenarioResult => (errors.length === 0 ? { ...result, artifacts: dir } : { ...result, artifacts: dir, artifactErrors: [...errors] });
      await attempt('result.json', () => writeFile(path.join(dir, 'result.json'), `${JSON.stringify(withErrors(), null, 2)}\n`));
      return withErrors();
    },
  };
}
