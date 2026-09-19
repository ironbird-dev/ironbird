import {
  IronbirdError,
  PROTOCOL_VERSION,
  createEventRecorder,
  createRealClock,
  createTracker,
  type Clock,
  type EventRecorder,
  type FakeInstance,
  type Target,
  type TimerId,
  type Tracker,
} from '@ironbird/core';
import { openConnection, type Connection, type Logger } from './connection';
import { capabilitiesOf, createHandlers } from './handlers';
import { BRIDGE_MARKER } from './marker';
import type { BridgePlatform, HelloFrame } from './messages';
import { platformOs } from './platform';

export interface BridgeOptions {
  target: Target;
  tracker?: Tracker;
  recorder?: EventRecorder;
  fakes?: FakeInstance[];
  /** Default createRealClock(); share it with the tracker so settle and effects agree on time. */
  clock?: Clock;
  /** Default 'app'. */
  appId?: string;
  appName?: string;
  /** Default 'ws://localhost:4568'. */
  url?: string;
  token?: string;
  /** Defaults 2 frames and 5000 ms. */
  settle?: { frames?: number; timeoutMs?: number };
  /** Defaults 500 ms and 5000 ms. */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
  /** Default false: outside dev builds startBridge logs once and returns an inert handle. */
  allowInNonDevBuilds?: boolean;
  logger?: Logger;
}

export interface BridgeHandle {
  readonly connected: boolean;
  readonly targetId: string | null;
  stop(): void;
}

/** State notifications carry only the revision and are coalesced to at most one per window (protocol.md §3.3). */
export const STATE_NOTIFY_INTERVAL_MS = 100;

const BRIDGE_VERSION = typeof __BRIDGE_VERSION__ === 'string' ? __BRIDGE_VERSION__ : '0.0.0-dev';

const defaultLogger: Logger = (level, message) => {
  if (level === 'debug') return;
  if (level === 'error') console.error(`ironbird: ${message}`);
  else if (level === 'warn') console.warn(`ironbird: ${message}`);
  else console.log(`ironbird: ${message}`);
};

const INERT: BridgeHandle = { connected: false, targetId: null, stop: () => {} };

export function startBridge(options: BridgeOptions): BridgeHandle {
  const logger = options.logger ?? defaultLogger;
  // Metro replaces `__DEV__` with a literal in app bundles; in Node tests it is simply undefined,
  // which counts as a dev environment.
  const dev = typeof __DEV__ === 'undefined' ? true : __DEV__ === true;
  if (!dev && !options.allowInNonDevBuilds) {
    logger('warn', 'startBridge is a no-op outside dev builds; pass allowInNonDevBuilds to override');
    return INERT;
  }

  const clock = options.clock ?? createRealClock();
  const tracker = options.tracker ?? createTracker({ clock });
  const recorder = options.recorder ?? createEventRecorder({ clock });
  const fakes = options.fakes ?? [];
  const platform: BridgePlatform = platformOs() === 'android' ? 'android' : 'ios';
  const app = { id: options.appId ?? 'app', platform, ...(options.appName === undefined ? {} : { name: options.appName }) };
  const settleDefaults = { frames: options.settle?.frames ?? 2, timeoutMs: options.settle?.timeoutMs ?? 5_000 };
  const warned = new Set<string>();

  // `handlers` and `hello` close over `connection` before it exists: `openConnection`'s `onRequest`
  // needs `handlers`, and `handlers` needs `connection` for `targetId`/`send`, so one of the two
  // must be a forward reference. It is assigned exactly once, right after, before any handler runs.
  // eslint-disable-next-line prefer-const -- forward reference; converting to const would reorder the circular wiring above.
  let connection: Connection;

  const handlers = createHandlers({
    target: options.target,
    tracker,
    recorder,
    fakes,
    clock,
    requestFrame: (callback) => {
      requestAnimationFrame(() => callback());
    },
    app,
    settleDefaults,
    targetId: () => connection.targetId ?? 'remote',
    warn: (path, valueKind) => {
      if (warned.has(path)) return;
      warned.add(path);
      connection.send({ type: 'notify', kind: 'warning', data: { code: 'UNSERIALIZABLE_STATE', path, valueKind } });
    },
  });

  const hello = (): HelloFrame => ({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    ...(options.token === undefined ? {} : { token: options.token }),
    marker: BRIDGE_MARKER,
    app: { ...app, bridgeVersion: BRIDGE_VERSION },
    capabilities: capabilitiesOf(options.target, fakes),
  });

  connection = openConnection({
    url: options.url ?? 'ws://localhost:4568',
    clock,
    hello,
    logger,
    reconnect: { initialDelayMs: options.reconnect?.initialDelayMs ?? 500, maxDelayMs: options.reconnect?.maxDelayMs ?? 5_000 },
    onRequest: async (op, params) => {
      const handler = handlers[op];
      if (!handler) throw new IronbirdError('UNSUPPORTED', `The bridge doesn't support ${op}`, { op, target: connection.targetId });
      return handler(params);
    },
    // Warnings are once per path per connection, so a fresh connection hears them again.
    onClose: () => warned.clear(),
  });

  const offEvents = recorder.subscribe((event) => {
    connection.send({ type: 'notify', kind: 'event', data: event });
  });

  let pendingRev: number | undefined;
  let throttle: TimerId | undefined;
  // The first change after a quiet period goes out at once; while changes keep coming, one frame
  // per window carries the latest revision, so a burst can't flood the daemon.
  const flush = (): void => {
    if (pendingRev === undefined) {
      throttle = undefined;
      return;
    }
    connection.send({ type: 'notify', kind: 'state', data: { rev: pendingRev } });
    pendingRev = undefined;
    throttle = clock.setTimeout(flush, STATE_NOTIFY_INTERVAL_MS, 'ironbird.stateNotify');
  };
  const offState = options.target.subscribe(() => {
    pendingRev = options.target.revision();
    if (throttle === undefined) flush();
  });

  return {
    get connected() {
      return connection.connected;
    },
    get targetId() {
      return connection.targetId;
    },
    stop() {
      offEvents();
      offState();
      if (throttle !== undefined) {
        clock.clearTimeout(throttle);
        throttle = undefined;
      }
      pendingRev = undefined;
      connection.stop();
    },
  };
}

export { BRIDGE_MARKER } from './marker';
export type { Logger } from './connection';
