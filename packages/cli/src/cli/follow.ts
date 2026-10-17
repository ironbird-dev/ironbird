import { toErrorShape, type ErrorShape } from '@ironbird/core';
import { unexpectedStreamEnd, type DaemonClient } from './client';
import { exitCodeForError } from './exit-codes';
import { asErrorShape } from './output';

export interface FollowOptions {
  client: DaemonClient;
  /** The target to follow; when undefined, the one the daemon picks for the backlog read. */
  target: string | undefined;
  /** `since` and `limit` for the backlog read. */
  params: Record<string, unknown>;
  /** Aborting it (SIGINT, SIGTERM) ends the follow with exit 0, unless something else ended it first. */
  signal: AbortSignal;
  /** Receives each JSON line, newline included. */
  write(line: string): void;
}

const MALFORMED_ERROR_FRAME: ErrorShape = { code: 'INTERNAL', message: 'Malformed error frame from daemon' };

/**
 * `ironbird events --follow`: prints the backlog, then every streamed event, as JSON lines whatever
 * the TTY, until something ends it, and resolves to the exit code. Whatever ends it first decides
 * that code: an interrupt is 0; an `error` frame, a failed backlog read or stream, or a stream the
 * daemon closes without an `error` frame (`TARGET_DISCONNECTED`) prints `{ "error": ... }` as the
 * last line and exits with that error's code. Anything after the first end is ignored.
 */
export async function runFollow(options: FollowOptions): Promise<number> {
  const { client, params, signal, write } = options;
  const line = (value: unknown): void => write(`${JSON.stringify(value)}\n`);

  let exit: number | undefined;
  // Records the first end and returns whether this call was it.
  const end = (code: number): boolean => {
    if (exit !== undefined) return false;
    exit = code;
    return true;
  };
  const endWithError = (shape: ErrorShape): void => {
    if (end(exitCodeForError(shape.code))) line({ error: shape });
  };

  // One listener for the whole follow, installed before the backlog read, so an interrupt while that
  // read stalls ends the follow with 0 too. It cancels the request in flight and the stream, and
  // `interrupted` lets the race return at once even with a client that ignores the signal.
  const stream = new AbortController();
  let onInterrupt: () => void = () => {};
  const interrupted = new Promise<undefined>((resolve) => {
    onInterrupt = () => {
      end(0);
      stream.abort();
      resolve(undefined);
    };
  });
  if (signal.aborted) return 0;
  signal.addEventListener('abort', onInterrupt, { once: true });
  try {
    let backlog: { target?: string; result: { events: unknown[]; nextSeq: number } } | undefined;
    try {
      backlog = await Promise.race([client.call<{ events: unknown[]; nextSeq: number }>('events', params, options.target, { signal: stream.signal }), interrupted]);
    } catch (error) {
      endWithError(toErrorShape(error));
    }
    if (backlog === undefined || exit !== undefined) return exit ?? 0;
    for (const event of backlog.result.events) line(event);

    const target = options.target ?? backlog.target;
    const streamed = client.stream({
      target: options.target,
      since: backlog.result.nextSeq,
      signal: stream.signal,
      onMessage: (kind, data) => {
        if (exit !== undefined) return;
        if (kind === 'event') line(data);
        else if (kind === 'error') endWithError(asErrorShape(data) ?? MALFORMED_ERROR_FRAME);
      },
    });
    // Settling the stream is the earliest point an end without a frame can be seen; if nothing
    // ended the follow before it, the daemon closed the stream (it shut down, or the connection dropped).
    await Promise.race([
      streamed.then(
        () => endWithError(unexpectedStreamEnd(client.url, target)),
        (error: unknown) => endWithError(toErrorShape(error)),
      ),
      interrupted,
    ]);
    return exit ?? 0;
  } finally {
    signal.removeEventListener('abort', onInterrupt);
  }
}
