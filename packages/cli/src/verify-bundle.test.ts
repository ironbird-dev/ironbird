import { BRIDGE_MARKER } from '@ironbird/react-native';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIDGE_MARKER_BYTES, findMarker } from './verify-bundle';

let temp: string;

afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

describe('findMarker', () => {
  it('assembles the same marker the bridge defines', () => {
    expect(BRIDGE_MARKER_BYTES.toString('utf8')).toBe(BRIDGE_MARKER);
  });

  it('finds the marker in text and binary files under nested directories, with its byte offset', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-verify-'));
    await mkdir(path.join(temp, 'nested/deeper'), { recursive: true });
    await writeFile(path.join(temp, 'clean.js'), 'export const ok = 1;\n');
    const binary = Buffer.concat([randomBytes(700), BRIDGE_MARKER_BYTES, randomBytes(50)]);
    await writeFile(path.join(temp, 'nested/deeper/main.hbc'), binary);
    await writeFile(path.join(temp, 'nested/index.js'), `console.log("${BRIDGE_MARKER}")`);
    const result = await findMarker([temp]);
    expect(result.scanned).toBe(3);
    expect(result.found).toEqual([
      { file: path.join(temp, 'nested/deeper/main.hbc'), offset: 700 },
      { file: path.join(temp, 'nested/index.js'), offset: 13 },
    ]);
  });

  it('finds a marker that straddles a read boundary', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-verify-'));
    const before = randomBytes(1_000);
    await writeFile(path.join(temp, 'split.bin'), Buffer.concat([before, BRIDGE_MARKER_BYTES, randomBytes(10)]));
    // A chunk size that ends 5 bytes into the marker.
    const result = await findMarker([path.join(temp, 'split.bin')], { chunkSize: 1_005 });
    expect(result.found).toEqual([{ file: path.join(temp, 'split.bin'), offset: 1_000 }]);
  });

  it('accepts a single clean file', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ironbird-verify-'));
    await writeFile(path.join(temp, 'bundle.js'), randomBytes(5_000));
    expect(await findMarker([path.join(temp, 'bundle.js')])).toEqual({ scanned: 1, found: [] });
  });
});
