import type { RecordedEvent, TargetInfo } from '@ironbird/core';

/**
 * What the daemon needs from any target, headless or remote. The daemon's target map, `status`,
 * the SSE stream, and target selection work against this and nothing else.
 */
export interface DaemonTarget {
  readonly id: string;
  info(): TargetInfo;
  run(op: string, params: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: RecordedEvent) => void): () => void;
  onState(listener: (rev: number) => void): () => void;
  dispose(): Promise<void>;
}

export const MUTATING_OPS: ReadonlySet<string> = new Set(['dispatch', 'fakeControl', 'clockAdvance', 'reset', 'snapshotLoad']);

// `reset` is not queued (it must be able to recover a wedged target), so it isn't one of the ops
// that waits its turn behind whatever else is in flight.
export const QUEUED_OPS: ReadonlySet<string> = new Set([...MUTATING_OPS].filter((op) => op !== 'reset'));
