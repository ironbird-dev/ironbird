export type RemotePlatform = 'ios' | 'android';

export interface TargetRegistry {
  /**
   * `preferred` when it is one of this platform's reserved ids and free, as for a reload's
   * replacement; otherwise the lowest id reserved for this platform, or a fresh one: `ios`, then
   * `ios-2`, and so on.
   */
  claim(platform: RemotePlatform, preferred?: string): string;
  /** Marks an id as free to be taken again by the next connection on its platform. */
  release(id: string): void;
}

/**
 * Ids are assigned per platform in connection order and reserved across disconnects
 * (architecture.md §7.3), so a reload lands on the same id and `--target ios` keeps working.
 */
export function createTargetRegistry(): TargetRegistry {
  const assigned: Record<RemotePlatform, string[]> = { ios: [], android: [] };
  const free: Record<RemotePlatform, Set<string>> = { ios: new Set(), android: new Set() };
  return {
    claim(platform, preferred) {
      if (preferred !== undefined && free[platform].has(preferred)) {
        free[platform].delete(preferred);
        return preferred;
      }
      const reserved = assigned[platform].find((id) => free[platform].has(id));
      if (reserved !== undefined) {
        free[platform].delete(reserved);
        return reserved;
      }
      const id = assigned[platform].length === 0 ? platform : `${platform}-${assigned[platform].length + 1}`;
      assigned[platform].push(id);
      return id;
    },
    release(id) {
      for (const platform of ['ios', 'android'] as const) {
        if (assigned[platform].includes(id)) free[platform].add(id);
      }
    },
  };
}
