import type { RecordedEvent, TargetInfo } from '@ironbird/core';

/**
 * What the daemon needs from any target, headless or remote. The daemon's target map, `status`,
 * the SSE stream, and target selection work against this and nothing else.
 */
export interface DaemonTarget {
  readonly id: string;
  /**
   * The longest the target itself lets one `reset` or `reload` run before failing it, when it
   * bounds them (the headless target's boot timeout). The daemon's request bound for those
   * operations is at least this plus five seconds, so it never reports a transition as timed out
   * that then succeeds.
   */
  readonly lifecycleTimeoutMs?: number;
  info(): TargetInfo;
  run(op: string, params: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: RecordedEvent) => void): () => void;
  onState(listener: (rev: number) => void): () => void;
  dispose(): Promise<void>;
}

export const MUTATING_OPS: ReadonlySet<string> = new Set(['dispatch', 'fakeControl', 'clockAdvance', 'reset', 'reload', 'snapshotLoad']);

// `reset` and `reload` are not queued: each must be able to recover a wedged target, so neither
// waits its turn behind whatever else is in flight.
export const QUEUED_OPS: ReadonlySet<string> = new Set([...MUTATING_OPS].filter((op) => op !== 'reset' && op !== 'reload'));
