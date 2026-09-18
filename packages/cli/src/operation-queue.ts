import { IronbirdError } from '@ironbird/core';

export type AbandonCause = 'reset' | 'disposed' | 'disconnected';

export interface OperationQueue {
  /**
   * Bumped by every `abandon`. An operation records it when it starts and compares after each
   * await: a mismatch means the session it started on is gone, and it must neither touch the new
   * session nor report state read off the dead one.
   */
  readonly epoch: number;
  /**
   * Runs `action` once every earlier queued action has settled or been abandoned. `enqueue` does
   * not itself abandon an action that is already running when a later `abandon` fires; a caller
   * that needs a running action to stop pairs this with `raceAbandon` and an epoch check around
   * its own awaits (see headless-target.ts for the pattern).
   */
  enqueue<T>(op: string, action: () => Promise<T>): Promise<T>;
  /** Wraps an in-flight promise so an `abandon` rejects it at once instead of waiting it out. */
  raceAbandon<T>(op: string, promise: Promise<T>): Promise<T>;
  /** Rejects everything waiting or in flight, bumps the epoch, and starts a fresh queue. */
  abandon(cause: AbandonCause): void;
  /** The error an epoch check should throw for an operation that lost its session. */
  abandoned(op: string): IronbirdError;
}

interface Entry {
  op: string;
  reject: (error: unknown) => void;
}

/**
 * Per-target ordering for mutating operations. Extracted from the headless target in M1 so the
 * remote target shares one implementation of the queue, the epoch, and the abandon rule that
 * docs/protocol.md §3.2 promises for both.
 */
export function createOperationQueue(target: string): OperationQueue {
  let queue: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  let lastCause: AbandonCause = 'reset';
  const waiting = new Set<Entry>();
  const inFlight = new Set<Entry>();

  const error = (op: string, cause: AbandonCause): IronbirdError => new IronbirdError('TARGET_DISCONNECTED', `Target was ${cause} before ${op} completed`, { target, op });

  return {
    get epoch() {
      return epoch;
    },
    enqueue(op, action) {
      const myTurn = queue;
      const startedEpoch = epoch;
      return new Promise((resolve, reject) => {
        const entry: Entry = { op, reject };
        waiting.add(entry);
        // `myTurn` is the previous action's turn, not its result: if that action never settles,
        // this callback never runs, and `abandon` reaches in via `waiting` to reject the entry.
        queue = myTurn
          .then(async () => {
            waiting.delete(entry);
            if (epoch !== startedEpoch) {
              reject(error(op, lastCause));
              return;
            }
            try {
              resolve(await action());
            } catch (caught) {
              reject(caught);
            }
          })
          .catch(() => undefined);
      });
    },
    raceAbandon(op, promise) {
      let rejectAbandon: (error: unknown) => void = () => {};
      const abandon = new Promise<never>((_, reject) => {
        rejectAbandon = reject;
      });
      abandon.catch(() => undefined);
      const entry: Entry = { op, reject: (caught) => rejectAbandon(caught) };
      inFlight.add(entry);
      return Promise.race([promise, abandon]).finally(() => {
        inFlight.delete(entry);
      });
    },
    abandon(cause) {
      epoch += 1;
      lastCause = cause;
      // Future enqueues chain onto a fresh queue; an action still running keeps running on its
      // own and is caught by an epoch check if it ever resolves, but must not block new work.
      queue = Promise.resolve();
      const stalled = [...waiting];
      waiting.clear();
      for (const entry of stalled) entry.reject(error(entry.op, cause));
      const executing = [...inFlight];
      inFlight.clear();
      for (const entry of executing) entry.reject(error(entry.op, cause));
    },
    abandoned: (op) => error(op, lastCause),
  };
}
