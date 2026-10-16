import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { counterDefinition } from '../../test/helpers/counter-app';
import { notesDefinition } from '../../test/helpers/snapshot-app';
import { startDaemon } from '../daemon';
import { createHeadlessTarget } from '../headless-target';
import { createDaemonClient, type DaemonClient } from './client';
import { buildProgram } from './program';

// The CLI in process, against a real daemon and headless target: spec §11's snapshot round trip.
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function session(definition = notesDefinition): Promise<{ url: string; client: DaemonClient; dir: string }> {
  const target = await createHeadlessTarget({ definition, appId: 'com.example.notes', settleTimeoutMs: 500, env: {}, log: () => {} });
  const daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: '0.0.0-test', headless: target, defaultTarget: 'headless', log: () => {} });
  const dir = await mkdtemp(path.join(tmpdir(), 'ironbird-snapshot-'));
  cleanups.push(async () => {
    await daemon.close();
    await target.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { url: daemon.url, client: createDaemonClient({ url: daemon.url }), dir };
}

async function cli(url: string, cwd: string, ...args: string[]): Promise<{ code: number; out: Record<string, unknown>; err: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { run } = buildProgram({ cwd, env: {}, isTTY: false, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), version: '0.0.0-test', signal: new AbortController().signal });
  const code = await run([...args, '--daemon', url]);
  const text = stdout.join('').trim();
  return { code, out: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>, err: stderr.join('') };
}

const add = (client: DaemonClient, text: string): Promise<unknown> => client.rpc('dispatch', { name: 'note.add', payload: { text } });

describe('ironbird snapshot against a daemon', () => {
  it('saves, mutates, loads, and gets the same state back', async () => {
    const { url, client, dir } = await session();
    await add(client, 'milk');
    const saved = await cli(url, dir, 'snapshot', 'save', 'notes.json');
    expect(saved).toMatchObject({ code: 0, out: { target: 'headless', app: 'com.example.notes', rev: 1, file: path.join(dir, 'notes.json') } });
    expect(JSON.parse(await readFile(path.join(dir, 'notes.json'), 'utf8'))).toEqual({ app: 'com.example.notes', target: 'headless', rev: 1, snapshot: { notes: ['milk'], status: 'idle' } });
    const before = await client.rpc<{ value: unknown }>('getState', {});
    await add(client, 'eggs');
    const loaded = await cli(url, dir, 'snapshot', 'load', 'notes.json');
    expect(loaded).toMatchObject({ code: 0, out: { target: 'headless', rev: 3, path: '', value: { notes: ['milk'], status: 'idle' } } });
    expect((await client.rpc<{ value: unknown }>('getState', {})).value).toEqual(before.value);
  });

  it('refuses malformed files with INVALID_PAYLOAD, a file from another app with APP_MISMATCH, and a snapshot the app rejects with INVALID_SNAPSHOT, leaving the state unchanged', async () => {
    const { url, client, dir } = await session();
    await add(client, 'milk');
    const files: Array<[string, string, number, string]> = [
      ['garbage.json', 'not json', 1, 'INVALID_PAYLOAD'],
      ['array.json', '[]', 1, 'INVALID_PAYLOAD'],
      ['shape.json', '{"app":"com.example.notes","target":"headless","rev":"1"}', 1, 'INVALID_PAYLOAD'],
      ['other.json', JSON.stringify({ app: 'com.example.other', target: 'headless', rev: 1, snapshot: { notes: [], status: 'idle' } }), 2, 'APP_MISMATCH'],
      ['invalid.json', JSON.stringify({ app: 'com.example.notes', target: 'headless', rev: 1, snapshot: { notes: 'milk' } }), 1, 'INVALID_SNAPSHOT'],
    ];
    for (const [name, text, code, errorCode] of files) {
      await writeFile(path.join(dir, name), text);
      const result = await cli(url, dir, 'snapshot', 'load', name);
      expect({ name, code: result.code, error: (result.out['error'] as { code?: string } | undefined)?.code }).toEqual({ name, code, error: errorCode });
    }
    expect(await client.rpc('getState', {})).toEqual({ rev: 1, path: '', value: { notes: ['milk'], status: 'idle' } });
  });

  it('fails a save of a state that holds a Map with INVALID_SNAPSHOT and writes no file', async () => {
    const { url, client, dir } = await session();
    await client.rpc('dispatch', { name: 'state.junk', payload: {} });
    const saved = await cli(url, dir, 'snapshot', 'save', 'notes.json');
    expect(saved).toMatchObject({ code: 1, out: { error: { code: 'INVALID_SNAPSHOT', details: { path: 'junk', reason: 'Map' } } } });
    await expect(stat(path.join(dir, 'notes.json'))).rejects.toThrow();
  });

  it('answers UNSUPPORTED for an app that neither persists nor restores', async () => {
    const { url, dir } = await session(counterDefinition);
    expect(await cli(url, dir, 'snapshot', 'save', 'counter.json')).toMatchObject({ code: 1, out: { error: { code: 'UNSUPPORTED', details: { op: 'snapshotSave', target: 'headless' } } } });
  });
});
