import { messageOf, toErrorShape, type Clock, type TimerId } from '@ironbird/core';
import { parseInbound, type HelloFrame, type InboundFrame, type OutboundFrame } from './messages';

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export interface ConnectionOptions {
  url: string;
  clock: Clock;
  hello: () => HelloFrame;
  onRequest: (op: string, params: Record<string, unknown>) => Promise<unknown>;
  onWelcome?: (targetId: string) => void;
  /** Called when a connection that had been welcomed closes. */
  onClose?: () => void;
  reconnect: { initialDelayMs: number; maxDelayMs: number };
  logger: Logger;
}

export interface Connection {
  readonly connected: boolean;
  readonly targetId: string | null;
  /** Sends a frame if the socket is open; returns false otherwise. */
  send(frame: OutboundFrame): boolean;
  stop(): void;
}

/** The subset of the runtime's WebSocket the bridge uses; React Native, Node, and `ws` all provide it. */
interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const OPEN = 1;

/**
 * Owns one socket at a time. Connects, sends `hello`, and reconnects with exponential backoff on
 * the injected clock after any close except a `reject` (final: a protocol or app mismatch never
 * fixes itself) or `stop()`. Requests are answered as they arrive; the daemon serializes the
 * mutating ones per target, so nothing is queued here.
 */
export function openConnection(options: ConnectionOptions): Connection {
  let socket: BridgeSocket | undefined;
  let connected = false;
  let targetId: string | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: TimerId | undefined;

  const send = (frame: OutboundFrame): boolean => {
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      options.logger('warn', `send failed: ${messageOf(error)}`);
      return false;
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) return;
    const delay = Math.min(options.reconnect.maxDelayMs, options.reconnect.initialDelayMs * 2 ** attempt);
    attempt += 1;
    options.logger('debug', `reconnecting to ${options.url} in ${delay} ms`);
    reconnectTimer = options.clock.setTimeout(
      () => {
        reconnectTimer = undefined;
        connect();
      },
      delay,
      'ironbird.reconnect',
    );
  };

  const handle = async (frame: InboundFrame): Promise<void> => {
    switch (frame.type) {
      case 'welcome':
        connected = true;
        targetId = frame.targetId;
        attempt = 0;
        options.logger('info', `connected to ironbird as ${frame.targetId}`);
        options.onWelcome?.(frame.targetId);
        return;
      case 'reject':
        stopped = true;
        options.logger('error', `ironbird daemon rejected this bridge (${frame.code}): ${frame.message}`);
        socket?.close(1000, frame.code);
        return;
      case 'ping':
        send({ type: 'pong', t: frame.t });
        return;
      case 'request': {
        try {
          const result = await options.onRequest(frame.op, frame.params);
          send({ type: 'response', id: frame.id, ok: true, result });
        } catch (error) {
          send({ type: 'response', id: frame.id, ok: false, error: toErrorShape(error) });
        }
        return;
      }
    }
  };

  const connect = (): void => {
    if (stopped) return;
    let next: BridgeSocket;
    try {
      next = new WebSocket(options.url) as BridgeSocket;
    } catch (error) {
      options.logger('warn', `cannot open ${options.url}: ${messageOf(error)}`);
      scheduleReconnect();
      return;
    }
    socket = next;
    let opened = false;
    // The one close path. It runs at most once per socket: the identity check makes a later event a no-op.
    const closed = (code: number): void => {
      if (socket !== next) return;
      socket = undefined;
      const wasConnected = connected;
      connected = false;
      targetId = null;
      if (wasConnected) options.onClose?.();
      if (stopped) return;
      options.logger('info', `disconnected from ironbird (${code})`);
      scheduleReconnect();
    };
    next.onopen = () => {
      opened = true;
      send(options.hello());
    };
    next.onmessage = (event) => {
      const frame = parseInbound(event.data);
      if (!frame) {
        options.logger('warn', 'dropped a malformed frame from the daemon');
        return;
      }
      void handle(frame);
    };
    next.onerror = () => {
      options.logger('debug', `socket error on ${options.url}`);
      // React Native and current Node follow a failed connect with a close event, but Node 22's WebSocket
      // (undici 6) fires only `error` and leaves the socket CONNECTING forever, which would strand the
      // bridge without a reconnect. A socket that never opened is therefore treated as closed here (1006,
      // the code the conforming runtimes report). An error on an opened socket waits for its close event.
      if (!opened) closed(1006);
    };
    next.onclose = (event) => closed(event.code);
  };

  connect();

  return {
    get connected() {
      return connected;
    },
    get targetId() {
      return targetId;
    },
    send,
    stop() {
      stopped = true;
      if (reconnectTimer !== undefined) {
        options.clock.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      socket?.close(1000, 'stopped');
      socket = undefined;
      connected = false;
      targetId = null;
    },
  };
}
