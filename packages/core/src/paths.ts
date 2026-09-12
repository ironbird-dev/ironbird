export function parsePath(path: string): string[] {
  return path === '' ? [] : path.split('.');
}

export function getAtPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of parsePath(path)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
