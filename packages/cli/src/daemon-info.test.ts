import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDaemonInfo, writeDaemonInfo } from './daemon-info';

describe('daemon info', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips artifactsPath', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-info-'));
    const info = { url: 'http://127.0.0.1:4567', pid: 1, startedAt: 0, version: '0.0.0', artifactsPath: '/app/.ironbird' };
    await writeDaemonInfo(dir, info);
    expect(await readDaemonInfo(dir)).toEqual(info);
  });

  it('rejects a daemon.json whose artifactsPath is not a string', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ironbird-info-'));
    await writeFile(path.join(dir, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:4567', pid: 1, startedAt: 0, version: '0.0.0', artifactsPath: 7 }));
    expect(await readDaemonInfo(dir)).toBeUndefined();
  });
});
