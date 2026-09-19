import { IronbirdError, type Capability, type Description, type ErrorShape, type RecordedEvent } from '@ironbird/core';
import { QUEUED_OPS, type DaemonTarget } from './daemon-target';
import { createOperationQueue } from './operation-queue';
import type { RemotePlatform } from './target-registry';

/** The subset of a `ws` server-side socket the target uses; tests script a fake against it. */
export interface RemoteSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface RemoteTargetOptions {
  id: string;
  platform: RemotePlatform;
  appId: string;
  /** From `hello`; `clock` and `reset` are never honored for a remote target (protocol.md §5). */
  capabilities: Capability[];
  socket: RemoteSocket;
  log?: (line: string) => void;
  pingIntervalMs?: number;
  missedPongLimit?: number;
  /** Called exactly once, when the socket closes for any reason. */
  onClose?: () => void;
}

export interface RemoteTarget extends DaemonTarget {
  readonly platform: RemotePlatform;
  readonly closed: boolean;
  /** Sends `describe` once and caches the answer for the life of the connection. */
  loadDescription(): Promise<Description>;
}

export const DEFAULT_PING_INTERVAL_MS = 5_000;
export const MISSED_PONG_LIMIT = 3;

const REQUIRES: Record<string, Capability> = {
  clockAdvance: 'clock',
  clockNow: 'clock',
  reset: 'reset',
  fakeControl: 'fakes',
  fakeCalls: 'fakes',
  snapshotSave: 'persist',
  snapshotLoad: 'restore',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const asErrorShape = (value: unknown): ErrorShape | undefined => {
  if (!isRecord(value) || typeof value['code'] !== 'string' || typeof value['message'] !== 'string') return undefined;
  return value as unknown as ErrorShape;
};

const isRecordedEvent = (value: unknown): value is RecordedEvent =>
  isRecord(value) && typeof value['seq'] === 'number' && typeof value['t'] === 'number' && typeof value['source'] === 'string' && typeof value['name'] === 'string';

interface Pending {
  op: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * A connected dev build as the daemon sees it. Requests go out with ids and resolve from the
 * matching response; `notify` frames feed the event and state listeners; the heartbeat pings on
 * an interval and terminates after the missed-pong limit; a close fails everything in flight or
 * queued with `TARGET_DISCONNECTED`, never retrying, because the command may already have run.
 */
export function createRemoteTarget(options: RemoteTargetOptions): RemoteTarget {
  const log = options.log ?? (() => {});
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const missedPongLimit = options.missedPongLimit ?? MISSED_PONG_LIMIT;
  const queue = createOperationQueue(options.id);
  const pending = new Map<string, Pending>();
  const eventListeners = new Set<(event: RecordedEvent) => void>();
  const stateListeners = new Set<(rev: number) => void>();
  const connectedAt = Date.now();
  // Never `clock` or `reset`, whatever the bridge claimed.
  const capabilities: Capability[] = options.capabilities.filter((capability) => capability !== 'clock' && capability !== 'reset');
  let nextId = 1;
  let rev = 0;
  let closed = false;
  let missed = 0;
  let description: Description | undefined;
  let describing: Promise<Description> | undefined;

  const disconnected = (op: string): IronbirdError => new IronbirdError('TARGET_DISCONNECTED', `Target ${options.id} disconnected before ${op} completed`, { target: options.id, op });

  const request = (op: string, params: Record<string, unknown>): Promise<unknown> => {
    if (closed) return Promise.reject(disconnected(op));
    const id = `r-${nextId++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { op, resolve, reject });
      try {
        options.socket.send(JSON.stringify({ type: 'request', id, op, params }));
      } catch {
        pending.delete(id);
        reject(disconnected(op));
      }
    });
  };

  const handleFrame = (frame: Record<string, unknown>): void => {
    switch (frame['type']) {
      case 'response': {
        const id = frame['id'];
        const entry = typeof id === 'string' ? pending.get(id) : undefined;
        if (!entry || typeof id !== 'string') return;
        pending.delete(id);
        if (frame['ok'] === true) {
          entry.resolve(frame['result']);
          return;
        }
        const shape = asErrorShape(frame['error']);
        entry.reject(shape ? new IronbirdError(shape.code, shape.message, shape.details) : new IronbirdError('INTERNAL', `Malformed error response from ${options.id}`, { target: options.id, op: entry.op }));
        return;
      }
      case 'notify': {
        const data = frame['data'];
        if (frame['kind'] === 'event' && isRecordedEvent(data)) {
          for (const listener of eventListeners) listener(data);
        } else if (frame['kind'] === 'state' && isRecord(data) && typeof data['rev'] === 'number') {
          rev = data['rev'];
          for (const listener of stateListeners) listener(rev);
        } else if (frame['kind'] === 'warning') {
          log(`warning from ${options.id}: ${JSON.stringify(data)}`);
        }
        return;
      }
      case 'pong':
        missed = 0;
        return;
      default:
        return;
    }
  };

  options.socket.on('message', (data) => {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : undefined;
    if (text === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log(`dropped a malformed frame from ${options.id}`);
      return;
    }
    if (isRecord(parsed)) handleFrame(parsed);
  });

  const heartbeat = setInterval(() => {
    if (closed) return;
    if (missed >= missedPongLimit) {
      log(`${options.id} missed ${missedPongLimit} pongs; closing the connection`);
      options.socket.terminate();
      return;
    }
    missed += 1;
    try {
      options.socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    } catch {
      // The close event that follows a dead socket does the cleanup.
    }
  }, pingIntervalMs);

  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    const inFlight = [...pending.values()];
    pending.clear();
    for (const entry of inFlight) entry.reject(disconnected(entry.op));
    queue.abandon('disconnected');
    options.onClose?.();
  };

  options.socket.on('close', () => finish());
  options.socket.on('error', (error) => log(`socket error on ${options.id}: ${error.message}`));

  const loadDescription = (): Promise<Description> => {
    if (description) return Promise.resolve(description);
    if (!describing) {
      describing = request('describe', {})
        .then((result) => {
          description = result as Description;
          return description;
        })
        .finally(() => {
          describing = undefined;
        });
    }
    return describing;
  };

  return {
    id: options.id,
    platform: options.platform,
    get closed() {
      return closed;
    },
    info: () => ({ id: options.id, platform: options.platform, appId: options.appId, connectedAt, rev }),
    loadDescription,
    async run(op, params) {
      if (closed) throw disconnected(op);
      const needs = REQUIRES[op];
      if (needs !== undefined && !capabilities.includes(needs)) throw new IronbirdError('UNSUPPORTED', `Target ${options.id} doesn't support ${op}`, { op, target: options.id });
      if (op === 'describe') return loadDescription();
      if (QUEUED_OPS.has(op)) return queue.enqueue(op, () => request(op, params));
      // `queue.enqueue` always hands an idle queue's action a one-microtask handoff (see
      // operation-queue.ts), so a read called synchronously alongside a mutating op would
      // otherwise win the race to the wire despite arriving second. Deferring the read by the
      // same one tick preserves call order between the two paths.
      return Promise.resolve().then(() => request(op, params));
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    async dispose() {
      if (closed) return;
      options.socket.close(1001, 'daemon shutting down');
      finish();
    },
  };
}
