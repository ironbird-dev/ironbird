import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface DaemonInfo {
  url: string;
  pid: number;
  startedAt: number;
  version: string;
  defaultTarget?: string;
  bridgeUrl?: string;
}

export const DAEMON_INFO_FILE = 'daemon.json';

export async function writeDaemonInfo(artifactsPath: string, info: DaemonInfo): Promise<string> {
  await mkdir(artifactsPath, { recursive: true });
  const file = path.join(artifactsPath, DAEMON_INFO_FILE);
  await writeFile(file, `${JSON.stringify(info, null, 2)}\n`);
  return file;
}

export async function readDaemonInfo(artifactsPath: string): Promise<DaemonInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(artifactsPath, DAEMON_INFO_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const candidate = parsed as Partial<Record<keyof DaemonInfo, unknown>>;
    if (typeof candidate.url !== 'string') return undefined;
    if (typeof candidate.pid !== 'number') return undefined;
    if (typeof candidate.startedAt !== 'number') return undefined;
    if (typeof candidate.version !== 'string') return undefined;
    if (candidate.defaultTarget !== undefined && typeof candidate.defaultTarget !== 'string') return undefined;
    if (candidate.bridgeUrl !== undefined && typeof candidate.bridgeUrl !== 'string') return undefined;
    return candidate as DaemonInfo;
  } catch {
    return undefined;
  }
}

export async function removeDaemonInfo(artifactsPath: string): Promise<void> {
  await rm(path.join(artifactsPath, DAEMON_INFO_FILE), { force: true });
}
