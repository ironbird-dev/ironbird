# ironbird: Protocol v1

| | |
|---|---|
| Status | Draft |
| `PROTOCOL_VERSION` | `1` |
| Last updated | 2026-09-11 |
| Related | [architecture.md](architecture.md) · [cli.md](cli.md) · [api.md](api.md) |

ironbird has two transports that carry the same operations:

| Transport | Between | Default address |
|---|---|---|
| Client API (HTTP and JSON) | CLI or MCP server → daemon | `http://127.0.0.1:4567` |
| Target channel (WebSocket and JSON) | App bridge ↔ daemon, opened by the app | `ws://<host>:4568` |

The headless target runs inside the daemon and implements the same operations without a transport.

## 1. Conventions

- Messages are JSON text in UTF-8. Every WebSocket message is one JSON object with a `type` field.
- Timestamps are milliseconds since the Unix epoch, taken from the target's clock. Headless targets use the manual clock.
- Durations are milliseconds.
- Paths are dot-separated keys with numeric segments for array indices, such as `cart.items.0.sku`. The empty path means the whole state.
- Receivers ignore unknown fields. This is how additive changes stay compatible.

## 2. Client API

### 2.1 RPC

`POST /v1/rpc`

```json
{
  "op": "dispatch",
  "target": "headless",
  "params": { "name": "cart.addItem", "payload": { "sku": "cut-45", "qty": 1 } }
}
```

A successful operation returns `{ "ok": true, "target": "<id>", "result": { ... } }`, where `target` is the id the operation ran against and is absent for daemon-only operations such as `status`. A failed operation returns `{ "ok": false, "error": { "code": "...", "message": "...", "details": { ... } } }`. Both use HTTP 200. Other statuses are reserved for transport problems: 401 for a missing or wrong token, 403 for a request that carries an `Origin` header or whose `Host` is neither loopback nor the daemon's bind address — which stops a page in a local browser from driving the daemon, except a wildcard bind (`0.0.0.0` or `::`) accepts any `Host`, since it already requires a token and has no single bind address to compare against — 404 for unknown routes, and 500 for daemon faults.

When the daemon was started with a token, requests must include `Authorization: Bearer <token>`.

`target` may be omitted; selection rules are in [architecture.md §8](architecture.md#8-target-selection).

### 2.2 Streams

`GET /v1/stream?target=<id>&since=<seq>` returns Server-Sent Events. Event types are `event` for recorded events, `state` for revision changes, `target` (M1) for connects and disconnects, and a terminal `error` carrying an `ErrorShape` when the backlog read fails. The CLI uses this for `events --follow` and `watch`. Sequence numbers restart at 1 after `reset`; a stream that spans a reset sees them go backwards.

## 3. Target channel

### 3.1 Handshake

The app sends `hello` immediately after connecting:

```json
{
  "type": "hello",
  "protocol": 1,
  "token": "optional",
  "marker": "__IRONBIRD_BRIDGE_v1__",
  "app": { "id": "com.example.checkout", "platform": "ios", "name": "Checkout", "bridgeVersion": "0.1.0" },
  "capabilities": ["settle", "events", "fakes", "persist"]
}
```

The `marker` field keeps the marker string referenced whenever the bridge is present in a bundle, which is what lets `ironbird verify-bundle` detect it after minification. The constant is defined in `@ironbird/react-native` only. `@ironbird/core` can ship in release bundles, so it must never contain the string.

The daemon answers with `welcome` or `reject`:

```json
{ "type": "welcome", "protocol": 1, "targetId": "ios" }
```

```json
{ "type": "reject", "code": "PROTOCOL_MISMATCH", "message": "Daemon speaks protocol 1; bridge speaks protocol 2" }
```

A daemon session serves one app: the app id of the headless target, or of the first bridge to connect when there is no headless entry. A `hello` with a different app id is rejected with `APP_MISMATCH`. After `reject`, the daemon closes the socket with close code 4001 for `PROTOCOL_MISMATCH`, 4002 for `APP_MISMATCH`, or 4003 for `UNAUTHORIZED`. After `welcome`, the daemon sends a `describe` request and caches the result for the life of the connection. Target ids are assigned per platform in connection order and reserved across disconnects; the rule is in [architecture.md §7.3](architecture.md#73-connection-lifecycle).

### 3.2 Requests and responses

```json
{
  "type": "request",
  "id": "r-12",
  "op": "dispatch",
  "params": { "name": "payment.start", "payload": { "method": "card" }, "settle": true }
}
```

```json
{
  "type": "response",
  "id": "r-12",
  "ok": true,
  "result": {
    "target": "ios",
    "rev": 8,
    "path": "",
    "state": { "cart": { "items": [] }, "payment": { "status": "collecting" } },
    "events": [],
    "settle": { "idle": true, "quiescent": false, "waitedMs": 212, "pending": [] }
  }
}
```

Failures use the same `ok: false` error shape as the client API. Mutating operations (`dispatch`, `fakeControl`, `clockAdvance`, `reset`, `snapshotLoad`) are processed one at a time per target, in arrival order. Read-only operations (`describe`, `getState`, `events`, `settle`, `waitFor`, `fakeCalls`, `snapshotSave`, `clockNow`) are not queued behind them, so a pending `waitFor` never blocks the operation that would satisfy it. `reset` is the exception among mutating operations: it is not queued, so it can recover a target whose dispatch never settles; any operation still waiting in the queue, or in flight, fails with `TARGET_DISCONNECTED`. Operations that arrive while a reset is in progress run after it, against the new session. The daemon bounds every target operation at 30 s by default, or at the operation's own timeout plus five seconds when it carries one, and fails the request with `TARGET_DISCONNECTED` when the bound elapses; the operation itself is left to the target's queue and `reset`.

### 3.3 Notifications

Apps push notifications without a request id:

```json
{ "type": "notify", "kind": "event", "data": { "seq": 13, "t": 1767225601200, "source": "api", "name": "order.confirmed" } }
```

```json
{ "type": "notify", "kind": "state", "data": { "rev": 9 } }
```

```json
{ "type": "notify", "kind": "warning", "data": { "code": "UNSERIALIZABLE_STATE", "path": "payment.session", "valueKind": "Map" } }
```

State notifications carry only the revision and are throttled to 10 per second. Clients fetch state when they need it.

### 3.4 Heartbeat

The daemon sends `{ "type": "ping", "t": <number> }` every 5 s, and the app replies `{ "type": "pong", "t": <same number> }`. Three missed pongs close the connection.

## 4. Operations

### 4.1 Target operations

| Operation | Params | Result | Headless | Remote |
|---|---|---|---|---|
| `describe` | none | `Description` | ✓ | ✓ |
| `dispatch` | `name`, `payload?`, `path?`, `settle?` | `StepResult` | ✓ | ✓ |
| `getState` | `path?` | `{ rev, path, value }` | ✓ | ✓ |
| `waitFor` | `path`, exactly one of `equals` / `notEquals` / `exists` / `matches`, `timeoutMs?` | `{ rev, path, value, waitedMs }` | ✓ | ✓ |
| `settle` | `timeoutMs?` | `SettleResult` | ✓ | ✓ |
| `events` | `since?`, `limit?` | `{ events, nextSeq, truncated }` | ✓ | ✓ |
| `fakeControl` | `fake`, `control`, `payload?`, `path?`, `settle?` | `StepResult` | ✓ | ✓ when fakes are wired into the build |
| `fakeCalls` (P1) | `fake`, `since?` | `{ calls }` | ✓ | ✓ when fakes are wired into the build |
| `clockAdvance` | `ms`, `path?` | `StepResult` plus `now` | ✓ | `UNSUPPORTED` in v1 |
| `clockNow` | none | `{ now }` | ✓ | `UNSUPPORTED` in v1 |
| `snapshotSave` (P1) | none | `{ rev, snapshot }` | if the target persists | if the target persists |
| `snapshotLoad` (P1) | `snapshot` | `{ rev, path, value }` | if the target restores | if the target restores |
| `reset` | none | `{ rev, path, value }` | ✓ | `UNSUPPORTED` |

`settle` in params is `true` (the default), `false`, or `{ "timeoutMs": number }`. `waitFor` doesn't advance the manual clock.

### 4.2 Daemon-only operations (client API)

| Operation | Params | Result |
|---|---|---|
| `status` | none | `{ version, protocol, uptimeMs, targets: TargetInfo[] }` |
| `screenshot` | `target?`, `device?`, `out?` | `Screenshot` |
| `step` | `name`, `payload?`, `target?`, `device?`, `path?`, `settle?` | `StepResult` plus `screenshot: Screenshot` and `settledBeforeCapture: boolean` |
| `scenarioRun` | `file`, `target?`, `bail?` | `ScenarioResult` |

`settle` in `step` has the same shape as in `dispatch`. `step` captures the screenshot after settling ends, whether or not it reached idle, and `settle: false` captures right after the dispatch.

## 5. Types

```ts
type Platform = 'headless' | 'ios' | 'android';

type Capability = 'settle' | 'events' | 'fakes' | 'clock' | 'persist' | 'restore' | 'reset';

interface Description {
  app: { id: string; platform: Platform; name?: string };
  commands: Record<string, { description?: string; payload: JsonSchema }>;
  fakes: Record<
    string,
    { description?: string; controls: Record<string, { description?: string; payload: JsonSchema }> }
  >;
  capabilities: Capability[];
}

interface StepResult {
  target: string;
  rev: number;               // state revision after the step
  path: string;              // '' for the whole state
  state: unknown;            // value at `path` after the step
  events: RecordedEvent[];   // events recorded during this step
  settle: SettleResult | null;
}

interface SettleResult {
  idle: boolean;             // nothing tracked is pending
  quiescent: boolean;        // headless only: only fake-backed work pending and nothing progressing
  waitedMs: number;
  pending: PendingItem[];
  nextTimerInMs?: number;    // headless only: time until the next manual-clock timer
}

interface PendingItem {
  kind: 'effect' | 'timer';
  label: string;             // for example 'reader.collectPayment'
  ageMs: number;
  fake: boolean;
}

interface RecordedEvent {
  seq: number;
  t: number;
  source: string;            // for example 'analytics', 'reader', 'api'
  name: string;
  data?: unknown;
}

interface FakeCall {
  seq: number;
  t: number;
  fake: string;
  method: string;
  args: unknown[];
  outcome: 'returned' | 'resolved' | 'rejected' | 'pending';
}

interface Screenshot {
  path: string;
  device: string;
  capturedAt: number;
}

interface TargetInfo {
  id: string;
  platform: Platform;
  appId: string;
  connectedAt: number;
  rev: number;
}

interface ScenarioResult {
  scenario: string;
  target: string;
  passed: boolean;
  durationMs: number;
  failedStep?: { index: number; step: unknown; actual?: unknown; error?: ErrorShape };
  skipped: number[];         // indexes of optional steps skipped as unsupported
  artifacts: string;         // directory holding events, results, and screenshots for this run
}

interface ErrorShape {
  code: ErrorCode;
  message: string;
  details?: unknown;
}
```

Capabilities say which operations a target supports, and an operation whose capability is absent fails with `UNSUPPORTED`. The headless target declares `settle`, `events`, `clock`, and `reset`, `fakes` when the app wires fakes in, plus `persist` and `restore` when its `Target` implements them. A remote target declares `settle` and `events`, `fakes` when fakes are wired into the build, and `persist` and `restore` from its `Target`; it never declares `clock` or `reset` in v1.

## 6. Error codes

| Code | Raised when | `details` |
|---|---|---|
| `UNKNOWN_COMMAND` | The name isn't in the registry | `{ name, suggestions }` |
| `INVALID_PAYLOAD` | The payload fails its schema | `{ name, issues }` |
| `DISPATCH_FAILED` | App dispatch threw or rejected | `{ name, message }` |
| `UNKNOWN_FAKE` | The fake isn't wired into the target | `{ fake, available }` |
| `UNKNOWN_CONTROL` | The fake doesn't declare the control | `{ fake, control, suggestions }` |
| `WAIT_TIMEOUT` | A condition wasn't met in time | `{ path, value, pending }` |
| `UNSUPPORTED` | The operation isn't available on this target, or the route is unknown (HTTP 404, `target: null`) | `{ op, target }` |
| `NO_TARGET` | No target is connected or configured | `{ available }` |
| `AMBIGUOUS_TARGET` | Several targets qualify and none was chosen | `{ available }` |
| `TARGET_DISCONNECTED` | The connection dropped before a response, the request timeout elapsed, or a reset or dispose abandoned the operation | `{ target, op }` |
| `AMBIGUOUS_DEVICE` | Several booted devices and none was chosen | `{ devices }` |
| `SCREENSHOT_FAILED` | The host capture tool failed | `{ tool, stderr }` |
| `HEADLESS_LOAD_FAILED` | The headless entry failed to load | `{ entry, message, importChain? }` |
| `INVALID_CONFIG` | `ironbird.config.ts` is missing a default export or fails validation | `{ file, issues }` |
| `CLOCK_RUNAWAY` | `clockAdvance` exceeded 10,000 timer firings | `{ labels }` |
| `PROTOCOL_MISMATCH` | Handshake versions differ | `{ daemon, bridge }` |
| `APP_MISMATCH` | A bridge's app id differs from the app this daemon session serves | `{ expected, received }` |
| `UNAUTHORIZED` | Token missing or wrong, or a request with an `Origin` header or a foreign `Host` (HTTP 403) | none |
| `INTERNAL` | A bug in ironbird | `{ message }` |

Settle timeouts are not errors, because the command has already been applied; the result reports `idle: false`. Warning codes such as `UNSERIALIZABLE_STATE` appear only in notifications.

## 7. Serialization

State values follow `JSON.stringify` rules: `Date` serializes through `toJSON`, and `undefined` properties are omitted, so optional fields never produce warnings. Values that JSON would throw on or silently flatten, namely functions, `BigInt`, `NaN`, `Infinity`, `-Infinity`, `Map`, `Set`, class instances other than `Date`, and cyclic references, are replaced with `{ "$unserializable": "<kind>" }`. Boxed primitives unwrap as in JSON. An invalid `Date`, which JSON would flatten to `null`, is marked `InvalidDate`. A property whose getter throws is marked `throwing-getter`, and an object that can't be inspected at all, such as a revoked `Proxy`, is marked `unreadable`; serialization never throws. Each affected path produces one `UNSERIALIZABLE_STATE` warning per connection.

## 8. Versioning

Additive changes keep the version: new operations, new optional params, new result fields, new error codes, and new capabilities. Removing anything or changing its meaning bumps `PROTOCOL_VERSION` and requires an ADR. In v0, daemon and bridge must speak the same version. Supporting the previous version for one release is a 1.0 goal.
