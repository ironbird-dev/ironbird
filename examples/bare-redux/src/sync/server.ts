import type { SavedTodo, SyncAck, SyncPort } from './port';

/** The timer the simulated server waits on. Any timer with this shape works, including a test clock. */
export interface Timers {
  setTimeout: (callback: () => void, ms: number, label?: string) => unknown;
}

/** How long the 1st, 3rd, 5th, ... save takes to be acknowledged. */
export const SLOW_ACK_MS = 300;
/** How long the 2nd, 4th, 6th, ... save takes to be acknowledged. */
export const FAST_ACK_MS = 100;

/**
 * A stand-in for the sync backend. It acknowledges every save, alternating a slow and a fast reply,
 * so two saves less than SLOW_ACK_MS - FAST_ACK_MS apart are acknowledged newest first: the
 * reordering a real network produces, which the app has to handle.
 */
export function createSimulatedServer(timers: Timers): SyncPort {
  let saves = 0;
  return {
    save(todo: SavedTodo): Promise<SyncAck> {
      saves += 1;
      const delay = saves % 2 === 1 ? SLOW_ACK_MS : FAST_ACK_MS;
      return new Promise((resolve) => {
        timers.setTimeout(() => resolve({ id: todo.id, rev: todo.rev }), delay, 'sync.ack');
      });
    },
  };
}
