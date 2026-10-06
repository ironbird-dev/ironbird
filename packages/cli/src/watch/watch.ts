import { toErrorShape, type ErrorShape } from '@ironbird/core';
import type { DaemonClient } from '../cli/client';
import { exitCodeForError } from '../cli/exit-codes';
import { asErrorShape } from '../cli/output';
import { patchBetween, type Presence } from './diff';

export interface WatchOptions {
  client: DaemonClient;
  /** The target to follow; when undefined, the one the daemon picks for the first call, pinned from then on. */
  target: string | undefined;
  /** Dot path to watch; `''` is the whole state. */
  path: string;
  /** Aborting it (SIGINT) ends the watch with exit 0. */
  signal: AbortSignal;
  /** Receives each JSON line, newline included. */
  write(line: string): void;
}

/**
 * `ironbird watch` (M5 design D5, §5). Opens the stream at the event cursor, so no backlog is
 * replayed, and treats every `state` frame as a change signal: values and revisions always come
 * from a `getState` read. The first frame is the daemon's barrier, sent once the stream's state
 * subscription is live, so reading after it misses no change. Resolves to the exit code.
 */
export async function runWatch(options: WatchOptions): Promise<number> {
  const { client, path, signal, write } = options;
  if (signal.aborted) return 0;
  // The client can't cancel an RPC, so race the cursor read against SIGINT: an interrupt while the
  // daemon is slow to answer still ends the watch at once with exit 0.
  let onAbort: () => void = () => {};
  const interrupted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  let cursor: { target?: string; result: { nextSeq: number } } | undefined;
  try {
    cursor = await Promise.race([client.call<{ nextSeq: number }>('events', { limit: 0 }, options.target), interrupted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (cursor === undefined) return 0;
  const target = options.target ?? cursor.target;
  const stream = new AbortController();
  let stopped = false;
  let exit = 0;
  const stop = (): void => {
    stopped = true;
    stream.abort();
  };
  const fail = (shape: ErrorShape): void => {
    if (stopped) return;
    write(`${JSON.stringify({ error: shape })}\n`);
    exit = exitCodeForError(shape.code);
    stop();
  };

  let printed: Presence = { present: false };
  let first = true;
  let reading = false;
  let dirty = false;
  let pumping: Promise<void> = Promise.resolve();

  const readOnce = async (): Promise<void> => {
    const { result } = await client.call<{ rev: number; value?: unknown }>('getState', { path }, target);
    if (stopped) return;
    // JSON drops an `undefined` value, so a missing path arrives without the property.
    const next: Presence = Object.prototype.hasOwnProperty.call(result, 'value') ? { present: true, value: result.value } : { present: false };
    const patch = patchBetween(printed, next);
    // The first line always prints, `[]` for a missing path; after it, an unchanged value prints nothing.
    if (!first && patch.length === 0) return;
    write(`${JSON.stringify({ rev: result.rev, patch })}\n`);
    printed = next;
    first = false;
  };

  // At most one read in flight. Any frame that arrives during a read marks it dirty, whatever its
  // revision: revisions restart after `reset` and `reload` and coalesce under the throttle, so an
  // equal revision can still be a new state. The loop's check and the `reading = false` after it
  // run in one synchronous turn, so no frame can fall between them unseen.
  const pump = async (): Promise<void> => {
    reading = true;
    try {
      do {
        dirty = false;
        await readOnce();
      } while (dirty && !stopped);
    } catch (error) {
      fail(toErrorShape(error));
    } finally {
      reading = false;
    }
  };

  const onMessage = (kind: 'event' | 'state' | 'target' | 'error', data: unknown): void => {
    if (stopped) return;
    if (kind === 'error') {
      fail(asErrorShape(data) ?? { code: 'INTERNAL', message: 'Malformed error frame from daemon' });
      return;
    }
    if (kind !== 'state') return;
    if (reading) dirty = true;
    else pumping = pump();
  };

  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  try {
    await client.stream({ target, since: cursor.result.nextSeq, signal: stream.signal, onMessage });
  } catch (error) {
    if (!stopped) {
      stopped = true;
      throw error;
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
  // The daemon ended the stream without an error frame (it shut down): let a read in flight print.
  if (!stopped) await pumping;
  return exit;
}
