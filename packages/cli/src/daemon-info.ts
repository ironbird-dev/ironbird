import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface DaemonInfo {
  url: string;
  pid: number;
  startedAt: number;
  version: string;
  defaultTarget?: string;
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
    const parsed = JSON.parse(await readFile(path.join(artifactsPath, DAEMON_INFO_FILE), 'utf8')) as Partial<DaemonInfo>;
    if (typeof parsed.url !== 'string' || typeof parsed.pid !== 'number') return undefined;
    return parsed as DaemonInfo;
  } catch {
    return undefined;
  }
}

export async function removeDaemonInfo(artifactsPath: string): Promise<void> {
  await rm(path.join(artifactsPath, DAEMON_INFO_FILE), { force: true });
}
