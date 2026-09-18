import { IronbirdError, PROTOCOL_VERSION, isIronbirdError, toErrorShape, type Platform, type RecordedEvent, type Screenshot, type StepResult, type TargetInfo } from '@ironbird/core';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { startBridgeServer, type BridgeServer } from './bridge-server';
import type { DaemonTarget } from './daemon-target';
import { resolveDevice as resolveDeviceOnHost, type DeviceRef } from './devices';
import { isSameSite } from './same-site';
import { captureScreenshot as captureOnHost, screenshotPath } from './screenshot';
import type { RemotePlatform } from './target-registry';

export interface DaemonOptions {
  host: string;
  port: number;
  token?: string;
  version: string;
  headless?: DaemonTarget;
  /** Targets registered at start besides the headless one; tests use it to stand in for connected apps. */
  targets?: DaemonTarget[];
  defaultTarget?: string;
  /** When set, a bridge server listens on this port on the same host, and connected apps become targets. */
  bridge?: { port: number; pingIntervalMs?: number; handshakeTimeoutMs?: number };
  /** Where screenshots are written; default `.ironbird` under the working directory. */
  artifactsPath?: string;
  /** Config `devices`: the simctl udid or adb serial to capture for each platform. */
  devices?: { ios?: string | undefined; android?: string | undefined };
  /** Test hooks replacing the host tools. */
  capture?: { resolveDevice?: typeof resolveDeviceOnHost; capture?: typeof captureOnHost };
  log?: (line: string) => void;
  /** Test hook: overrides the SSE keepalive ping interval (default 15_000ms) so tests can observe
   * ping behavior without waiting out the real interval. */
  pingIntervalMs?: number;
  /** Wall-clock bound on one target operation (default 30_000ms); see docs/protocol.md §3.2. */
  requestTimeoutMs?: number;
}

export interface Daemon {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly bridgeUrl: string | undefined;
  targets(): TargetInfo[];
  close(): Promise<void>;
}

/** One SSE `target` frame: a connected app arriving or leaving (docs/protocol.md §2.2). */
export interface TargetEvent {
  id: string;
  platform: Platform;
  appId: string;
  status: 'connected' | 'disconnected';
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const STATE_THROTTLE_MS = 100;
const PING_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The operation-specific timeout a caller asked for, read straight from the wire `params`:
 * `waitFor` and `settle` carry `params.timeoutMs`; `dispatch`, `fakeControl`, and `clockAdvance`
 * carry it nested under `params.settle.timeoutMs`. Anything else — a missing value, a non-finite
 * or negative number, a `settle` that isn't an object — contributes 0 rather than guessing at the
 * target's own default settle timeout, which the daemon never sees.
 */
function operationTimeoutMs(params: Record<string, unknown>): number {
  const direct = params['timeoutMs'];
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;
  const settle = params['settle'];
  if (typeof settle === 'object' && settle !== null) {
    const nested = (settle as { timeoutMs?: unknown }).timeoutMs;
    if (typeof nested === 'number' && Number.isFinite(nested) && nested >= 0) return nested;
  }
  return 0;
}

/**
 * The wall-clock bound for one request: at least `requestTimeoutMs`, or if the operation carries
 * its own timeout, at least 5 s past it, so the request timeout can never fire before the operation's
 * own timeout would have (see docs/protocol.md §3.2). A `waitFor` or `settle` racing a condition
 * that never holds still resolves on its own — with `WAIT_TIMEOUT` or `idle: false` — well inside
 * this bound; the bound only catches an operation that never resolves at all.
 */
function requestBoundFor(requestTimeoutMs: number, params: Record<string, unknown>): number {
  const opTimeout = operationTimeoutMs(params);
  return opTimeout > 0 ? Math.max(requestTimeoutMs, opTimeout + 5_000) : requestTimeoutMs;
}

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_MAPPED_LOOPBACK = /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Loopback hosts may run without a token (see spec R3); anything else must be paired with one. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || IPV4_LOOPBACK.test(normalized) || IPV4_MAPPED_LOOPBACK.test(normalized);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new IronbirdError('INVALID_PAYLOAD', 'Request body too large', { name: 'rpc', issues: [{ path: [], message: `body exceeds ${MAX_BODY_BYTES} bytes` }] });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => console.error(line));

  if (!isLoopbackHost(options.host) && !options.token) {
    throw new IronbirdError('UNAUTHORIZED', `Binding ${options.host} requires a token; pass one or bind 127.0.0.1`);
  }

  const startedAt = Date.now();
  const artifactsPath = options.artifactsPath ?? path.resolve('.ironbird');
  const resolveDevice = options.capture?.resolveDevice ?? resolveDeviceOnHost;
  const capture = options.capture?.capture ?? captureOnHost;
  const targets = new Map<string, DaemonTarget>();
  if (options.headless) targets.set(options.headless.id, options.headless);
  for (const target of options.targets ?? []) targets.set(target.id, target);

  // One app per session (architecture.md §7.3): the headless target names it, else the first
  // bridge to connect does, and it stays for the daemon's life.
  let sessionAppId: string | undefined = options.headless?.info().appId ?? options.targets?.[0]?.info().appId;

  const targetListeners = new Set<(event: TargetEvent) => void>();
  const announce = (target: DaemonTarget, status: TargetEvent['status']): void => {
    const info = target.info();
    const event: TargetEvent = { id: info.id, platform: info.platform, appId: info.appId, status };
    for (const listener of targetListeners) {
      // This runs synchronously inside a `ws` close handler (and inside `register`, on the bridge's
      // connect path); one stream's listener throwing — e.g. a write racing a dead response — must
      // not stop delivery to every other open stream, and must not escape as an uncaught exception.
      try {
        listener(event);
      } catch (error) {
        log(`target listener failed handling ${status} for ${info.id}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
    }
  };
  const register = (target: DaemonTarget): void => {
    targets.set(target.id, target);
    announce(target, 'connected');
  };
  const unregister = (target: DaemonTarget): void => {
    if (targets.get(target.id) !== target) return;
    targets.delete(target.id);
    announce(target, 'disconnected');
  };

  const selectTarget = (requested: unknown): DaemonTarget => {
    const available = [...targets.keys()];
    const id = typeof requested === 'string' && requested !== '' ? requested : options.defaultTarget;
    if (id === undefined) {
      const only = available.length === 1 ? targets.get(available[0] as string) : undefined;
      if (only) return only;
      const code = available.length === 0 ? 'NO_TARGET' : 'AMBIGUOUS_TARGET';
      throw new IronbirdError(code, available.length === 0 ? 'No target is connected or configured' : 'Several targets qualify; pass --target', { available });
    }
    const target = targets.get(id);
    if (!target) throw new IronbirdError('NO_TARGET', `No target ${id}`, { available });
    return target;
  };

  // `screenshot` and `step` need a screen: the only connected app by default, never headless.
  const selectRemoteTarget = (requested: unknown, op: string): DaemonTarget => {
    const remotes = [...targets.values()].filter((target) => target.info().platform !== 'headless');
    if (typeof requested === 'string' && requested !== '') {
      const target = targets.get(requested);
      if (!target) throw new IronbirdError('NO_TARGET', `No target ${requested}`, { available: [...targets.keys()] });
      if (target.info().platform === 'headless') throw new IronbirdError('UNSUPPORTED', `${op} needs a connected app; the headless target has no screen`, { op, target: requested });
      return target;
    }
    if (remotes.length === 1) return remotes[0] as DaemonTarget;
    if (remotes.length === 0) throw new IronbirdError('NO_TARGET', 'No app is connected', { available: [...targets.keys()] });
    throw new IronbirdError('AMBIGUOUS_TARGET', 'Several apps are connected; pass --target', { available: remotes.map((target) => target.id) });
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (!options.token) return true;
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const expected = Buffer.from(`Bearer ${options.token}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  // Bounds one target operation so a wedged target can't hold an HTTP connection open forever.
  // The operation itself keeps running: the target's queue owns it, and `reset` is what clears it.
  // `onTimeout`, when given, replaces the default TARGET_DISCONNECTED error: `resolveDeviceFor` and
  // `takeScreenshot` below use it, because a timeout there means a host tool (`simctl`/`adb`, or
  // device resolution itself) is wedged, not the target — `ironbird reset` can't fix that.
  const withRequestTimeout = async <T>(targetId: string, op: string, boundMs: number, work: Promise<T>, onTimeout?: (boundMs: number) => IronbirdError): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(onTimeout ? onTimeout(boundMs) : new IronbirdError('TARGET_DISCONNECTED', `Request timed out after ${boundMs} ms; the target may be wedged, run ironbird reset`, { target: targetId, op })),
        boundMs,
      );
    });
    timeout.catch(() => undefined);
    // The abandoned `work` may reject later with nothing awaiting it; swallow that so it doesn't
    // surface as an unhandled rejection and take the daemon down.
    work.catch(() => undefined);
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // Bounded the same way as the capture in `takeScreenshot` below: on the default path (no
  // `--device` and no `devices.<platform>` config pin) `resolveDevice` shells out to `xcrun simctl`
  // or `adb devices -l`, and a wedged one of those must not hold the HTTP request open forever any
  // more than a wedged capture may. A timeout here is reported as SCREENSHOT_FAILED with
  // `tool: 'resolveDevice'`, since resolution itself is what hung, not a specific host tool.
  const resolveDeviceFor = (target: DaemonTarget, requested: unknown): Promise<DeviceRef> => {
    const platform = target.info().platform as RemotePlatform;
    return withRequestTimeout(
      target.id,
      'resolveDevice',
      requestTimeoutMs,
      resolveDevice({ platform, requested: str(requested), configured: options.devices?.[platform] }),
      (boundMs) => new IronbirdError('SCREENSHOT_FAILED', `resolveDevice timed out after ${boundMs} ms`, { tool: 'resolveDevice', stderr: `timed out after ${boundMs} ms` }),
    );
  };

  // Takes the picture once a device is already in hand: `screenshot` resolves it from `params`
  // right before calling this, and `step` resolves it before dispatching (see the `step` handler)
  // so a device problem fails before anything is applied. Both that device-resolution step and the
  // capture here are bounded like every other target operation (docs/protocol.md §3.2): a wedged
  // host tool must not hold the HTTP connection open forever. A timeout here is reported as
  // SCREENSHOT_FAILED, the same code a failing (rather than hanging) capture already uses (see
  // screenshot.ts), naming the tool that's wedged rather than TARGET_DISCONNECTED — the target
  // itself is fine, and `ironbird reset` cannot unwedge a host tool.
  const takeScreenshot = async (target: DaemonTarget, device: DeviceRef, requestedOut?: string): Promise<Screenshot> => {
    const outPath = requestedOut === undefined ? screenshotPath(artifactsPath, target.info().id) : path.resolve(requestedOut);
    const tool = device.platform === 'ios' ? 'simctl' : 'adb';
    await withRequestTimeout(
      target.id,
      'screenshot',
      requestTimeoutMs,
      capture({ device, outPath }),
      (boundMs) => new IronbirdError('SCREENSHOT_FAILED', `${tool} timed out after ${boundMs} ms`, { tool, stderr: `timed out after ${boundMs} ms` }),
    );
    return { path: outPath, device: device.id, capturedAt: Date.now() };
  };

  const handleRpc = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (error) {
      const shape = isIronbirdError(error) ? toErrorShape(error) : { code: 'INVALID_PAYLOAD' as const, message: 'Malformed JSON body', details: { name: 'rpc', issues: [] } };
      sendJson(res, 200, { ok: false, error: shape });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 200, {
        ok: false,
        error: { code: 'INVALID_PAYLOAD', message: 'Body must be a JSON object', details: { name: 'rpc', issues: [{ path: [], message: 'expected an object' }] } },
      });
      return;
    }
    const envelope = parsed as { op?: unknown; target?: unknown; params?: unknown };
    const { op, target: requestedTarget } = envelope;
    const params = typeof envelope.params === 'object' && envelope.params !== null ? (envelope.params as Record<string, unknown>) : {};
    try {
      if (typeof op !== 'string') throw new IronbirdError('INVALID_PAYLOAD', 'Body needs a string op', { name: 'rpc', issues: [{ path: ['op'], message: 'expected a string' }] });
      if (op === 'status') {
        sendJson(res, 200, { ok: true, result: { version: options.version, protocol: PROTOCOL_VERSION, uptimeMs: Date.now() - startedAt, targets: [...targets.values()].map((t) => t.info()) } });
        return;
      }
      if (op === 'screenshot') {
        const target = selectRemoteTarget(requestedTarget, op);
        const device = await resolveDeviceFor(target, params['device']);
        sendJson(res, 200, { ok: true, target: target.id, result: await takeScreenshot(target, device, str(params['out'])) });
        return;
      }
      if (op === 'step') {
        const target = selectRemoteTarget(requestedTarget, op);
        const { device: deviceParam, ...dispatchParams } = params;
        // Resolved before the dispatch below, not after: `resolveDevice` throws `AMBIGUOUS_DEVICE`
        // for the routine case of zero or several devices, and a device problem must fail before
        // the step is applied, not after — otherwise a retry risks dispatching twice.
        const device = await resolveDeviceFor(target, deviceParam);
        const bound = requestBoundFor(requestTimeoutMs, dispatchParams);
        const stepResult = (await withRequestTimeout(target.id, 'dispatch', bound, target.run('dispatch', dispatchParams))) as StepResult;
        // Captured after settling ends whether or not it reached idle, so the agent sees the screen
        // either way. A SCREENSHOT_FAILED from here means the dispatch above already applied
        // (docs/protocol.md §4.2).
        const screenshot = await takeScreenshot(target, device);
        sendJson(res, 200, { ok: true, target: target.id, result: { ...stepResult, screenshot, settledBeforeCapture: stepResult.settle?.idle === true } });
        return;
      }
      const target = selectTarget(requestedTarget);
      const bound = requestBoundFor(requestTimeoutMs, params);
      const result = await withRequestTimeout(target.id, op, bound, target.run(op, params));
      sendJson(res, 200, { ok: true, target: target.id, result });
    } catch (error) {
      if (isIronbirdError(error)) {
        sendJson(res, 200, { ok: false, error: toErrorShape(error) });
        return;
      }
      log(`daemon fault handling ${String(op)}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      sendJson(res, 500, { ok: false, error: toErrorShape(error) });
    }
  };

  const handleStream = async (url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let target: DaemonTarget;
    try {
      target = selectTarget(url.searchParams.get('target') ?? undefined);
    } catch (error) {
      sendJson(res, 200, { ok: false, error: toErrorShape(error) });
      return;
    }
    const since = Number(url.searchParams.get('since') ?? '0') || 0;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });

    // Registered before the backlog await below so a client disconnect (or a backlog read that
    // throws) while we're still awaiting it is handled here rather than leaking the subscription,
    // leaving stray timers, or falling through to the daemon-fault handler.
    let aborted = false;
    // A holder object rather than separate `let`s: each of these is assigned exactly once, once
    // its value becomes available, but `cleanup` (below) must be able to reference it beforehand.
    const handles: { offEvent?: () => void; offState?: () => void; offTarget?: () => void; ping?: NodeJS.Timeout } = {};
    let throttle: NodeJS.Timeout | undefined;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      handles.offEvent?.();
      handles.offState?.();
      handles.offTarget?.();
      if (handles.ping) clearInterval(handles.ping);
      if (throttle) clearTimeout(throttle);
    };
    req.on('close', () => {
      aborted = true;
      cleanup();
    });
    // A late socket error (e.g. an ECONNRESET after headers are already flushed) must not reach
    // Node as an unhandled 'error' event on `res` — an EventEmitter that emits 'error' with no
    // listener throws, which would crash the process. Attaching this here, before anything is
    // ever written, means any such error just runs the same teardown as a normal disconnect.
    res.on('error', () => cleanup());

    let streamEnded = false;
    const endStream = (): void => {
      if (streamEnded) return;
      streamEnded = true;
      res.end();
    };
    // A client that vanished between event-loop turns can make `res.write` throw, and a value
    // that fails to serialize can make `JSON.stringify` throw: either must tear the subscription
    // down and end the response exactly once right here, instead of propagating out of a backlog
    // frame, a live event/state callback, or the backlog-failure error frame below, and up into
    // the request handler's try/catch, which would log it as a daemon fault and then attempt to
    // send a second, JSON error response on a stream whose headers are already flushed. Every call
    // site routes its serialization through the `produce` thunk so it also runs inside this guard,
    // not just the socket write.
    const guarded = (produce: () => string): void => {
      try {
        res.write(produce());
      } catch {
        cleanup();
        endStream();
      }
    };
    const writeRaw = (text: string): void => guarded(() => text);
    const write = (kind: string, data: unknown): void => guarded(() => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    writeRaw(': connected\n\n');

    // Subscribe before awaiting the backlog so an event recorded during that await isn't lost
    // between the snapshot and the subscription. Anything that arrives while we're still
    // buffering is held here and reconciled against the backlog by seq once it's in hand.
    let buffering = true;
    const liveBuffer: RecordedEvent[] = [];
    handles.offEvent = target.onEvent((event) => {
      if (buffering) liveBuffer.push(event);
      else write('event', event);
    });

    // Every stream hears apps arrive and leave. When it is this stream's own target that left, the
    // subscriptions above are dead, so the stream ends with the same error a request would get.
    // Subscribed before the backlog await below, the same as the event subscription just above,
    // so a disconnect that lands while we're still waiting on the backlog is caught here — ending
    // the stream with this target frame before the error frame, per docs/protocol.md §2.2 — rather
    // than only ever reaching the backlog's own `catch` below with nothing subscribed yet.
    const onTarget = (event: TargetEvent): void => {
      write('target', event);
      if (cleaned || event.id !== target.id || event.status !== 'disconnected') return;
      cleanup();
      guarded(() => `event: error\ndata: ${JSON.stringify({ code: 'TARGET_DISCONNECTED', message: `Target ${event.id} disconnected`, details: { target: event.id, op: 'stream' } })}\n\n`);
      endStream();
    };
    targetListeners.add(onTarget);
    handles.offTarget = () => {
      targetListeners.delete(onTarget);
    };

    let backlog: { events: RecordedEvent[] };
    try {
      backlog = (await target.run('events', { since })) as { events: RecordedEvent[] };
    } catch (error) {
      // The subscription is live but no backlog was ever flushed, so there's nothing to
      // reconcile: tear down and end the stream with a single error frame instead of letting
      // this reach the daemon-fault handler (the client already got a 200 SSE response head).
      // Serializing the error shape inside `guarded` (rather than eagerly before calling it) means
      // a value that itself fails to serialize can't escape as an unhandled throw here either.
      cleanup();
      guarded(() => `event: error\ndata: ${JSON.stringify(toErrorShape(error))}\n\n`);
      endStream();
      return;
    }
    if (aborted || req.destroyed) {
      cleanup();
      return;
    }
    // `cleanup()` runs inside `guarded` the moment a write or a serialization fails, but that
    // doesn't stop either loop from running to completion on its own, and nothing past this point
    // must run once it has: the stream is already ended, so subscribing to more state here would
    // never be released (`cleanup` is latched by `cleaned` and won't call `offState`/clear `ping`
    // for handles it hasn't seen yet), and arming the ping interval would write to a dead response
    // forever. So every loop bails out as soon as `cleaned` flips, and the function returns before
    // reaching the state subscription or the ping timer below.
    for (const event of backlog.events) {
      write('event', event);
      if (cleaned) break;
    }
    if (cleaned) return;
    const lastBacklogSeq = backlog.events.length > 0 ? backlog.events[backlog.events.length - 1]!.seq : since;
    for (const event of liveBuffer) {
      if (event.seq > lastBacklogSeq) write('event', event);
      if (cleaned) break;
    }
    if (cleaned) return;
    buffering = false;

    let pendingRev: number | undefined;
    // Writes immediately on the first update after a quiet period, then re-arms for another
    // STATE_THROTTLE_MS as long as there's something to flush, so a sustained burst is capped at
    // one write per window instead of overshooting it.
    const flush = (): void => {
      if (pendingRev === undefined) {
        throttle = undefined;
        return;
      }
      write('state', { rev: pendingRev });
      pendingRev = undefined;
      // A failed write runs `cleanup` from inside `guarded`; re-arming here would keep a timer
      // alive on a stream that is already torn down.
      if (cleaned) return;
      throttle = setTimeout(flush, STATE_THROTTLE_MS);
    };
    handles.offState = target.onState((rev) => {
      pendingRev = rev;
      if (!throttle) flush();
    });
    handles.ping = setInterval(() => writeRaw(': ping\n\n'), options.pingIntervalMs ?? PING_INTERVAL_MS);
  };

  // A page in the user's browser can reach a loopback daemon, so a same-origin-style check runs
  // before anything else: a real CLI client never sends `Origin`, and a DNS-rebinding attack
  // arrives with a `Host` the daemon was never bound to.
  const sameSite = (req: IncomingMessage): boolean => isSameSite({ origin: req.headers.origin, host: req.headers.host }, options.host);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!sameSite(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Cross-origin or foreign-host requests are not allowed' } });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Token missing or wrong' } });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/v1/rpc') return await handleRpc(req, res);
        if (req.method === 'GET' && url.pathname === '/v1/stream') return await handleStream(url, req, res);
        sendJson(res, 404, { ok: false, error: { code: 'UNSUPPORTED', message: `No route ${req.method ?? ''} ${url.pathname}`, details: { op: `${req.method ?? ''} ${url.pathname}`, target: null } } });
      } catch (error) {
        log(`daemon fault: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: toErrorShape(error) });
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host}:${port}`;

  let bridge: BridgeServer | undefined;
  if (options.bridge) {
    try {
      bridge = await startBridgeServer({
        host: options.host,
        port: options.bridge.port,
        token: options.token,
        log,
        pingIntervalMs: options.bridge.pingIntervalMs,
        handshakeTimeoutMs: options.bridge.handshakeTimeoutMs,
        session: {
          appId: () => sessionAppId,
          adopt: (appId) => {
            sessionAppId = appId;
          },
        },
        onConnect: (target) => {
          register(target);
          log(`target ${target.id} connected (${target.info().appId})`);
        },
        onDisconnect: (target) => {
          unregister(target);
          log(`target ${target.id} disconnected`);
        },
      });
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }
  log(`ironbird daemon listening at ${url}${bridge ? `; bridges connect to ${bridge.url}` : ''}`);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        await bridge?.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      })();
    }
    return closing;
  };

  return {
    url,
    host: options.host,
    port,
    bridgeUrl: bridge?.url,
    targets: () => [...targets.values()].map((t) => t.info()),
    close,
  };
}
