import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The bridge marker, assembled at runtime. AGENTS.md hard rule 3 allows the literal in exactly one
 * package, `@ironbird/react-native`, so that a release bundle containing any other ironbird package
 * never trips this check. `verify-bundle.test.ts` asserts the two stay equal.
 */
export const BRIDGE_MARKER_BYTES: Buffer = Buffer.from(['__IRONBIRD', 'BRIDGE', 'v1__'].join('_'), 'utf8');

export interface MarkerHit {
  file: string;
  offset: number;
}

const DEFAULT_CHUNK = 1024 * 1024;

async function scanFile(file: string, marker: Buffer, chunkSize: number): Promise<number> {
  const handle = await open(file, 'r');
  try {
    const overlap = marker.length - 1;
    const chunk = Buffer.alloc(chunkSize);
    let carry = Buffer.alloc(0);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, position);
      if (bytesRead === 0) return -1;
      const window = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const index = window.indexOf(marker);
      if (index !== -1) return position - carry.length + index;
      // Keep the tail so a marker split across two reads is still seen whole.
      carry = overlap > 0 ? Buffer.from(window.subarray(Math.max(0, window.length - overlap))) : Buffer.alloc(0);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Byte-searches every file under `paths` for the marker. Hermes bytecode stores ASCII strings
 * contiguously in its string table, so the same search covers `.hbc` output and plain bundles.
 * Directories are walked in sorted order; every path must exist.
 */
export async function findMarker(paths: string[], options: { marker?: Buffer; chunkSize?: number } = {}): Promise<{ scanned: number; found: MarkerHit[] }> {
  const marker = options.marker ?? BRIDGE_MARKER_BYTES;
  const chunkSize = Math.max(marker.length, options.chunkSize ?? DEFAULT_CHUNK);
  const found: MarkerHit[] = [];
  let scanned = 0;
  const visit = async (entry: string): Promise<void> => {
    if ((await stat(entry)).isDirectory()) {
      for (const child of (await readdir(entry)).sort()) await visit(path.join(entry, child));
      return;
    }
    scanned += 1;
    const offset = await scanFile(entry, marker, chunkSize);
    if (offset !== -1) found.push({ file: entry, offset });
  };
  for (const entry of paths) await visit(path.resolve(entry));
  return { scanned, found };
}
