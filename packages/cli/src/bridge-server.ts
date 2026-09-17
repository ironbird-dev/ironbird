import { ERROR_CODES, PROTOCOL_VERSION, messageOf, type Capability } from '@ironbird/core';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { createRemoteTarget, type RemoteSocket, type RemoteTarget } from './remote-target';
import { hostAllowed } from './same-site';
import { createTargetRegistry, type RemotePlatform } from './target-registry';

export interface BridgeServerOptions {
  host: string;
  port: number;
  token?: string;
  log?: (line: string) => void;
  /** The daemon's one-app-per-session rule: the first bridge sets the app id when no headless entry did. */
  session: { appId(): string | undefined; adopt(appId: string): void };
  /** Called once the target has answered `describe` and is ready for operations. */
  onConnect(target: RemoteTarget): void;
  /** Called when a target's socket closes, whether or not `onConnect` ever ran for it. */
  onDisconnect(target: RemoteTarget): void;
  /** How long a fresh connection has to send `hello` (default 5000 ms). */
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface BridgeServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export const CLOSE_CODES = { PROTOCOL_MISMATCH: 4001, APP_MISMATCH: 4002, UNAUTHORIZED: 4003 } as const;

const CAPABILITIES: ReadonlySet<string> = new Set<Capability>(['settle', 'events', 'fakes', 'clock', 'persist', 'restore', 'reset']);

interface Hello {
  protocol: number;
  token?: string;
  app: { id: string; platform: RemotePlatform; name?: string };
  capabilities: Capability[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseHello(data: unknown): Hello | { error: string } {
  const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : undefined;
  if (text === undefined) return { error: 'expected a text frame' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'not JSON' };
  }
  if (!isRecord(parsed) || parsed['type'] !== 'hello') return { error: 'expected a hello frame' };
  if (typeof parsed['protocol'] !== 'number') return { error: 'protocol must be a number' };
  if (typeof parsed['marker'] !== 'string') return { error: 'marker is missing' };
  const app = parsed['app'];
  if (!isRecord(app) || typeof app['id'] !== 'string') return { error: 'app.id must be a string' };
  if (app['platform'] !== 'ios' && app['platform'] !== 'android') return { error: 'app.platform must be ios or android' };
  const token = parsed['token'];
  if (token !== undefined && typeof token !== 'string') return { error: 'token must be a string' };
  const capabilities = Array.isArray(parsed['capabilities']) ? (parsed['capabilities'].filter((item): item is Capability => typeof item === 'string' && CAPABILITIES.has(item))) : [];
  return {
    protocol: parsed['protocol'],
    ...(token === undefined ? {} : { token }),
    app: { id: app['id'], platform: app['platform'], ...(typeof app['name'] === 'string' ? { name: app['name'] } : {}) },
    capabilities,
  };
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accepts bridge connections on the same host as the HTTP API. The handshake checks, in order,
 * the frame shape and protocol version (4001), the token when the daemon has one (4003), and the
 * session's app id (4002), then assigns a target id, sends `welcome`, requests `describe`, and
 * hands the target to the daemon. Upgrade requests whose `Origin` names a foreign host are
 * refused before the socket opens; React Native's own WebSocket sends a loopback `Origin`.
 */
export async function startBridgeServer(options: BridgeServerOptions): Promise<BridgeServer> {
  const log = options.log ?? (() => {});
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const registry = createTargetRegistry();
  const server = new WebSocketServer({
    host: options.host,
    port: options.port,
    verifyClient: ({ origin }: { origin: string }) => {
      if (origin === undefined || origin === '') return true;
      try {
        return hostAllowed(new URL(origin).hostname, options.host);
      } catch {
        return false;
      }
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve();
    });
  });

  server.on('connection', (socket: WebSocket) => {
    socket.on('error', (error: Error) => log(`bridge socket error before hello: ${error.message}`));
    const timer = setTimeout(() => {
      log('a bridge connection sent no hello in time; closing it');
      socket.terminate();
    }, handshakeTimeoutMs);

    const reject = (code: keyof typeof CLOSE_CODES, message: string, details?: Record<string, unknown>): void => {
      socket.send(JSON.stringify({ type: 'reject', code, message, ...(details === undefined ? {} : { details }) }));
      socket.close(CLOSE_CODES[code], code);
    };

    socket.once('message', (data) => {
      clearTimeout(timer);
      const hello = parseHello(data);
      if ('error' in hello) return reject('PROTOCOL_MISMATCH', `Malformed hello: ${hello.error}`);
      if (hello.protocol !== PROTOCOL_VERSION) return reject('PROTOCOL_MISMATCH', `Daemon speaks protocol ${PROTOCOL_VERSION}; bridge speaks protocol ${hello.protocol}`);
      if (options.token !== undefined && !tokenMatches(hello.token, options.token)) return reject('UNAUTHORIZED', 'Token missing or wrong');
      const expected = options.session.appId();
      if (expected !== undefined && expected !== hello.app.id) {
        return reject('APP_MISMATCH', `This daemon serves ${expected}; the bridge is ${hello.app.id}`, { expected, received: hello.app.id });
      }
      options.session.adopt(hello.app.id);
      const id = registry.claim(hello.app.platform);
      const target: RemoteTarget = createRemoteTarget({
        id,
        platform: hello.app.platform,
        appId: hello.app.id,
        capabilities: hello.capabilities,
        // A `ws` socket has every member RemoteSocket names; the cast only narrows its overloads.
        socket: socket as unknown as RemoteSocket,
        log,
        pingIntervalMs: options.pingIntervalMs,
        onClose: () => {
          registry.release(id);
          options.onDisconnect(target);
        },
      });
      socket.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, targetId: id }));
      target.loadDescription().then(
        () => {
          if (!target.closed) options.onConnect(target);
        },
        (error: unknown) => {
          log(`${id} failed to describe itself: ${messageOf(error)}`);
          void target.dispose();
        },
      );
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    url: `ws://${options.host}:${port}`,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of server.clients) client.terminate();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// Keep the reject codes honest against the protocol table at build time.
type RejectCode = keyof typeof CLOSE_CODES;
const _check: RejectCode extends (typeof ERROR_CODES)[number] ? true : never = true;
void _check;
