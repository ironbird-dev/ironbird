# ironbird: API Reference

| | |
|---|---|
| Status | The 0.1 API: what 0.1.0 ships. Before 1.0, semver's pre-1.0 rule applies: a minor release such as 0.2 may change these signatures, and its changelog lists each change; patch releases don't break them |
| Last updated | 2026-10-14 |
| Related | [protocol.md](protocol.md) for wire types and error codes · [cli.md](cli.md) for the CLI |

Priority markers match [spec.md](spec.md): **P0** ships in 0.1, **P1** is planned for 0.1 if milestones hold. A milestone marker such as **M1** names the milestone that built the section ([roadmap.md](roadmap.md)).

## @ironbird/core

Runs unmodified in Node and Hermes. Peer dependency: `zod@^4.2`. Core imports zod only as a type: JSON Schema comes from each schema's own `toJSONSchema` method, so importing `@ironbird/core` does not load zod. Apps still on Zod 3: see [migrating-from-zod-3.md](migrating-from-zod-3.md).

### defineCommands (P0)

```ts
type Schemas = Record<string, z.ZodType>;

function defineCommands<const T extends Schemas>(schemas: T): CommandRegistry<T>;

interface CommandRegistry<T extends Schemas = Schemas> {
  readonly schemas: T;
  names(): Array<keyof T & string>;
  has<K extends string>(name: K): name is K & keyof T;
  /** Throws IronbirdError with UNKNOWN_COMMAND or INVALID_PAYLOAD. */
  parse<K extends keyof T & string>(name: K, payload: unknown): z.output<T[K]>;
  describe(): Record<string, { description?: string; payload: JsonSchema }>;
}

type CommandOf<R extends CommandRegistry> = {
  [K in keyof R['schemas'] & string]: { name: K; payload: z.output<R['schemas'][K]> };
}[keyof R['schemas'] & string];
```

Conventions: namespace names by feature with dots (`payment.start`). Commands without a payload use `z.object({})`, and an omitted payload is treated as `{}`. Use `.describe()` on schemas; agents see that text. Schemas using transforms or refinements still validate, but their JSON Schema under-describes them, so `describe()` logs a warning for each. These members are declared through deferred conditional types in the source so that `CommandRegistry<T>` stays assignable to the plain `CommandRegistry` that targets and the daemon hold; the shapes above are what callers see.

```ts
export const commands = defineCommands({
  'cart.addItem': z
    .object({ sku: z.string(), qty: z.number().int().positive() })
    .describe('Add an item to the current cart'),
  'cart.clear': z.object({}).describe('Remove every item from the cart'),
  'payment.start': z
    .object({ method: z.enum(['card', 'saved']) })
    .describe('Start payment for the current cart'),
});
```

Every schema must be a Zod 4.2+ schema from `zod` or `zod/v4`. `defineCommands` checks each one when it is called and throws `IronbirdError` with code `INVALID_CONFIG` and details `{ name, reason }` for a Zod 3 schema (from `zod` 3 or `zod/v3`), a `zod/mini` schema, or anything else, so a schema the registry can't describe fails before an agent asks for it; `defineFake` applies the same check to its controls in `create`. TypeScript rejects those schemas too. Apps still on Zod 3: see [migrating-from-zod-3.md](migrating-from-zod-3.md).

### createTarget (P0)

```ts
function createTarget<R extends CommandRegistry, S>(definition: TargetDefinition<R, S>): Target<S>;

interface TargetDefinition<R extends CommandRegistry, S> {
  commands: R;
  dispatch(command: CommandOf<R>): void | Promise<void>;
  getState(): S;
  subscribe?(listener: () => void): () => void;
  persist?(): unknown;
  restore?(snapshot: unknown): void | Promise<void>;
}

interface Target<S = unknown> {
  readonly commands: CommandRegistry;
  readonly capabilities: ReadonlyArray<'persist' | 'restore'>;
  /** Validates with the registry, then calls definition.dispatch with the parsed payload. */
  dispatch(name: string, payload?: unknown): Promise<void>;
  getState(): S;
  /** Increments on every subscribe notification, or on every dispatch when subscribe is absent. */
  revision(): number;
  subscribe(listener: () => void): () => void;
  /** Present only when the definition provides it. */
  persist?(): unknown;
  /** Present only when the definition provides it; bumps the revision when subscribe is absent. */
  restore?(snapshot: unknown): Promise<void>;
}
```

`TargetDefinition` is exported alongside `createTarget`. A definition that provides `persist` or `restore` gets the matching method and capability on the `Target`, and the `snapshotSave` and `snapshotLoad` operations use them; see [protocol.md §4.1](protocol.md#41-target-operations). `persist` should return plain JSON data: `snapshotSave` passes it through `serializeSnapshot`, which refuses a `Map`, a `Date`, a class instance, a cycle, `-0` (JSON writes it as `0`), and the like rather than saving something that loads back wrong. `restore` receives `unknown`, whatever the definition's state type, because it comes from a file or the wire: validate it, for example with a Zod schema for the whole state, before applying it, and apply nothing when it doesn't fit (AGENTS.md rule 4). A plain error that `persist` or `restore` throws reaches the caller as `INVALID_SNAPSHOT` with `{ path: '', reason: <its message> }`; an `IronbirdError` passes through unchanged, so a `restore` can report the path that failed with its own `INVALID_SNAPSHOT`.

`capabilities` lists only what the `Target` itself provides. The daemon and bridge add `settle`, `events`, `fakes`, `clock`, `reset`, and `reload` as appropriate when they describe the target; see [protocol.md §5](protocol.md#5-types). A subscriber that throws is skipped with a `console.warn`; it never prevents later subscribers from running or the dispatch from completing.

Example with an XState actor, adapted by hand (the `@ironbird/xstate` adapter does this for you):

```ts
export const toTarget = (actor: typeof checkoutActor) =>
  createTarget({
    commands,
    dispatch: ({ name, payload }) => actor.send({ type: name, ...payload }),
    getState: () => {
      const snapshot = actor.getSnapshot();
      return { value: snapshot.value, context: snapshot.context };
    },
    subscribe: (listener) => {
      const subscription = actor.subscribe(listener);
      return () => subscription.unsubscribe();
    },
  });
```

### Clocks (P0)

```ts
type TimerId = number;

interface ScheduledTimer {
  id: TimerId;
  dueAt: number;
  scheduledAt: number;
  label?: string;
  repeatMs?: number;
}

interface Clock {
  readonly kind: 'real' | 'manual';
  now(): number;
  setTimeout(callback: () => void, ms: number, label?: string): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(callback: () => void, ms: number, label?: string): TimerId;
  clearInterval(id: TimerId): void;
  timers(): ScheduledTimer[];
}

interface ManualClock extends Clock {
  readonly kind: 'manual';
  /** Fires due timers in dueAt order (ties in scheduling order), yielding a macrotask between firings. */
  advance(ms: number): Promise<void>;
  setNow(epochMs: number): void;
}

function createRealClock(): Clock;
function createManualClock(options?: { now?: number }): ManualClock;
```

`now` defaults to `0`, so a headless run starts at the Unix epoch unless `clock.start` in `ironbird.config.ts` says otherwise. `advance` throws `IronbirdError('CLOCK_RUNAWAY')` after 10,000 firings in one call. App code under test should take time only from an injected `Clock`.

### createTracker (P0)

```ts
interface Tracker {
  track<T>(promise: Promise<T>, label: string, options?: { fake?: boolean }): Promise<T>;
  /** Shallow proxy: each method returning a thenable is tracked as `${name}.${method}`. */
  wrap<P extends object>(port: P, name: string, options?: { fake?: boolean }): P;
  pending(): PendingItem[];
  /** timeoutMs defaults to 5000, mode to 'idle'. */
  whenIdle(options?: { timeoutMs?: number; mode?: 'idle' | 'quiescent' }): Promise<SettleResult>;
  onChange(listener: () => void): () => void;
}

function createTracker(options?: { clock?: Clock; timerThresholdMs?: number; enabled?: boolean }): Tracker;

/** Tags a port with FAKE_PORT_MARK so wrap marks its calls fake: true. */
function markFakePort<P extends object>(port: P): P;
```

With a real clock, timers due within `timerThresholdMs` (default 1,000) count as pending. Manual-clock timers never count. Wrapping is always explicit, so the app chooses the label; a port tagged as fake has its calls marked `fake: true`, which is what allows `mode: 'quiescent'` to finish without advancing time. Every port `defineFake` serves answers the global-registry symbol `FAKE_PORT_MARK`, so wrapping a `FakeInstance.port` needs no option. Hand-written fakes call `markFakePort` on the port or pass `{ fake: true }` to `wrap`. With `enabled: false` (app code passes `enabled: __DEV__`), `wrap` returns the port untouched, `track` returns the promise untouched, `pending()` is empty, and `whenIdle` resolves idle at once, so release builds carry no tracking. `PendingItem` and `SettleResult` are defined in [protocol.md](protocol.md#5-types). `whenIdle`'s `timeoutMs` and every `ageMs` are wall-clock milliseconds, because a manual clock never advances on its own; only the settle result's `nextTimerInMs` is manual-clock time. A listener that throws is skipped with a `console.warn`; it never prevents later listeners from running or the tracked promise from settling.

### defineFake (P0)

```ts
function defineFake<Port extends object, C extends Schemas>(
  name: string,
  definition: {
    description?: string;
    controls: C;
    create(context: FakeContext): { port: Port; controls: ControlHandlers<C> };
  },
): FakeFactory<Port, C>;

interface FakeContext {
  readonly clock: Clock;
  /** Records an event with the fake's name as its source. A no-op without a recorder. */
  record(name: string, data?: unknown): void;
}

type ControlHandlers<C extends Schemas> = {
  [K in keyof C]: (payload: z.output<C[K]>) => void | Promise<void>;
};

interface FakeFactory<Port extends object, C extends Schemas> {
  readonly name: string;
  create(deps: { clock: Clock; recorder?: EventRecorder }): FakeInstance<Port, C>;
}

interface FakeInstance<Port extends object = object, C extends Schemas = Schemas> {
  readonly name: string;
  readonly description?: string;
  /** Call-recording proxy over the port returned by create(). */
  readonly port: Port;
  readonly controls: CommandRegistry<C>;
  control(name: string, payload?: unknown): Promise<void>;
  calls(since?: number, limit?: number): FakeCallsResult;
}

interface FakeCallsResult {
  calls: FakeCall[];
  nextSeq: number;
  truncated: boolean;
}
```

`FakeDefinition<Port, C>` names the `definition` parameter's type and is exported with the rest. Controls are declared as Zod schemas and validated by a command registry built from them, so `describe` lists their JSON Schema and an invalid payload fails with `INVALID_PAYLOAD` and the registry's issues. `create` returns the port and a map with one handler per declared control: a missing handler is a compile error, and an extra one, such as `emitt` next to `emit`, fails `FakeFactory.create` with `UNKNOWN_CONTROL`, details `{ fake, control, suggestions }`, which is a boot failure on headless and a red box on device. Both generics infer from the return value, so no annotation is needed beyond typing the port.

`control(name, payload)` checks the control exists (`UNKNOWN_CONTROL` with suggestions), parses the payload, and awaits the handler. Errors name the control as `<fake>.<control>`: `INVALID_PAYLOAD` with details `{ name, issues }`, and `DISPATCH_FAILED` with `{ name, message }` when the handler throws or rejects, the same code a throwing command uses. An `IronbirdError` thrown by a handler passes through unchanged.

`port` is a call-recording proxy, never the object `create` returned: reading a method returns a wrapper, created once per method, that records a `FakeCall` and invokes the original with `this` bound to the returned object, so a frozen port and a class instance both work. Each call gets a per-fake sequence number from 1, the clock time, the method name, the arguments serialized like state (a listener becomes `{ "$unserializable": "function" }`), and an outcome: `returned` or `threw` for a synchronous call, `pending` for a call that returned a promise, updated in place to `resolved` or `rejected` when it settles, with the error's message on `threw` and `rejected`. `calls(since = 0, limit = Infinity)` returns copies of the calls newer than `since`, `nextSeq` as the cursor to pass next (with `limit: 0`, where the log stands), and `truncated` when `since` points into calls already dropped; each fake keeps 10,000. Recording is always on, because fakes exist only in headless and development builds. The port answers `FAKE_PORT_MARK`, so `tracker.wrap(fake.port, name)` marks its effects as fake-backed for quiescence without any option. Nothing in `defineFake` freezes anything, and a fake's state lives in its `create` closure, so the headless target's `reset`, which runs the headless definition again, starts counters, timers, and call logs over.

Example: a fake card reader. Type the port and let `create`'s return value infer the rest.

```ts
type ReaderEvent = { type: 'connected' | 'disconnected' | 'cardPresented' | 'declined' };

interface CardReaderPort {
  connect(): Promise<void>;
  collectPayment(amountCents: number): Promise<{ token: string }>;
  onEvent(listener: (event: ReaderEvent) => void): () => void;
}

export const fakeReader = defineFake('reader', {
  description: 'Bluetooth card reader',
  controls: {
    emit: z.object({ event: z.enum(['connected', 'disconnected', 'cardPresented', 'declined']) }),
    failNextPayment: z.object({ reason: z.string() }),
    setLatency: z.object({ ms: z.number().int().min(0) }),
  },
  create({ clock, record }) {
    const listeners = new Set<(event: ReaderEvent) => void>();
    let failReason: string | undefined;
    let latencyMs = 1200;

    const port: CardReaderPort = {
      connect: async () => {},
      collectPayment: (amountCents) =>
        new Promise((resolve, reject) => {
          clock.setTimeout(() => {
            if (failReason) {
              const reason = failReason;
              failReason = undefined;
              reject(new Error(reason));
            } else {
              resolve({ token: `fake_${amountCents}` });
            }
          }, latencyMs, 'reader.collectPayment');
        }),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    return {
      port,
      controls: {
        emit: ({ event }) => {
          record(event);
          listeners.forEach((listener) => listener({ type: event }));
        },
        failNextPayment: ({ reason }) => {
          failReason = reason;
        },
        setLatency: ({ ms }) => {
          latencyMs = ms;
        },
      },
    };
  },
});
```

Wiring: `const reader = fakeReader.create({ clock, recorder })` in the headless factory or in `instance.ts`, then `tracker.wrap(reader.port, 'reader')` goes to the app core and `[reader]` goes to `HeadlessApp.fakes` or `startBridge`'s `fakes`.

### createEventRecorder (P0)

```ts
interface EventRecorder {
  record(source: string, name: string, data?: unknown): RecordedEvent;
  since(seq?: number, limit?: number): { events: RecordedEvent[]; nextSeq: number; truncated: boolean };
  /** The latest recorded seq, or 0 before the first event; O(1) and unaffected by clear(). */
  lastSeq(): number;
  subscribe(listener: (event: RecordedEvent) => void): () => void;
  clear(): void;
}

function createEventRecorder(options?: { clock?: Clock; limit?: number; enabled?: boolean }): EventRecorder;
```

`limit` defaults to 10,000; `since` defaults to `seq` `0` and an unlimited page. With `enabled: false`, `record` stores nothing and returns an event with `seq: 0`, `since` returns nothing, and `lastSeq()` stays `0`, so release builds carry no event log. To capture analytics, wrap your analytics adapter so each call also records: `recorder.record('analytics', name, properties)`. A subscriber that throws is skipped with a `console.warn`; it never prevents later subscribers from running or the event from being recorded.

### defineHeadless (P0)

```ts
function defineHeadless(
  factory: (context: HeadlessContext) => HeadlessApp | Promise<HeadlessApp>,
): HeadlessDefinition;

interface HeadlessContext {
  clock: ManualClock;
  recorder: EventRecorder;
  tracker: Tracker;
  env: Readonly<Record<string, string | undefined>>;
}

interface HeadlessApp {
  target: Target;
  fakes?: FakeInstance[];
  dispose?(): void | Promise<void>;
}

interface HeadlessDefinition {
  readonly kind: 'ironbird.headless';
  create(context: HeadlessContext): Promise<HeadlessApp>;
}
```

The module named by `headless` in `ironbird.config.ts` must default-export the result. The daemon calls the factory on start and again on `reset`, each time with a fresh context. `HeadlessDefinition` has `kind: 'ironbird.headless'` and an async `create(context)`; the daemon checks the loaded default export with `isHeadlessDefinition` and fails with `HEADLESS_LOAD_FAILED` otherwise. The daemon bounds `create` with a 30 s boot timeout in M0; a configurable limit is planned with the bridge in M1.

### IronbirdError (P0)

```ts
class IronbirdError extends Error {
  constructor(code: ErrorCode, message: string, details?: unknown);
  readonly code: ErrorCode;   // see protocol.md §6
  readonly details?: unknown;
  /** The wire shape; `details` is omitted when undefined. */
  toJSON(): ErrorShape;
}

const PROTOCOL_VERSION: 1;
```

### Other exports (P0)

| Export | What it is |
|---|---|
| `ERROR_CODES` | The list of protocol error codes; `ErrorCode` is its union |
| `isIronbirdError` | Structural check (name plus a string `code`), so it holds across module instances |
| `messageOf` | The `message` of an `Error`, or `String(value)` for anything else |
| `toErrorShape` | Any thrown value as an `ErrorShape`; a non-ironbird throw becomes `INTERNAL` |
| `getAtPath` | Reads a dot path out of a state value, `undefined` when it doesn't resolve |
| `parsePath` | Splits a dot path into segments; the empty path is no segments |
| `serializeState` | JSON-safe copy plus the `SerializationWarning[]` for what it replaced |
| `serializeSnapshot` | JSON-safe copy of a persisted snapshot, or `INVALID_SNAPSHOT` with `{ path, reason }` for the first value it can't save losslessly; never substitutes a placeholder (see [protocol.md §7](protocol.md#7-serialization)) |
| `parseSnapshotLoadParams` | `(params, appId) => { snapshot }` for a target applying `snapshotLoad`: `INVALID_PAYLOAD` for a non-string `app` or a missing `snapshot`, `APP_MISMATCH` with `{ expected, received }` when `app` is another app's id |
| `parseCondition` | Reads exactly one of `equals`, `notEquals`, `exists`, `matches` from a `waitFor` params object; throws `INVALID_PAYLOAD` otherwise (M1: moved here from `@ironbird/cli`, which re-exports it) |
| `conditionHolds` | Whether a value satisfies a parsed `Condition` |
| `deepEqual` | Structural equality used by `equals` and `notEquals` |
| `suggestNames` | Near-miss names for `UNKNOWN_COMMAND` and `UNKNOWN_CONTROL` details |
| `MAX_FIRINGS_PER_ADVANCE` | `10_000`, the `CLOCK_RUNAWAY` threshold for one `advance` |
| `FAKE_PORT_MARK` | The `Symbol.for('ironbird.fakePort')` tag `markFakePort` writes |
| `isFakePort` | Whether a port carries that tag |
| `QUIESCENT_STABLE_YIELDS` | `3`, the macrotask yields `mode: 'quiescent'` waits out before reporting |
| `TargetDefinition` | The `createTarget` parameter type (above) |
| `SerializationWarning` | `{ path, valueKind }` for one replaced value |

## @ironbird/react-native (P0, M1)

Dev builds only. Peer dependencies: `react-native`, `@ironbird/core`. No native code.

### startBridge (P0)

```ts
function startBridge(options: BridgeOptions): BridgeHandle;

interface BridgeOptions {
  target: Target;
  tracker?: Tracker;
  recorder?: EventRecorder;
  fakes?: FakeInstance[];
  clock?: Clock;                                                // default createRealClock(); share it with the tracker
  appId?: string;                                               // default 'app'
  appName?: string;                                             // shown in status; default none
  url?: string;                                                 // default 'ws://localhost:4568'
  token?: string;
  settle?: { frames?: number; timeoutMs?: number };             // defaults 2 and 5000
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number }; // defaults 500 and 5000
  allowInNonDevBuilds?: boolean;                                // default false
  reload?: () => void | Promise<void>;                          // default DevSettings.reload, when it exists
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

interface BridgeHandle {
  readonly connected: boolean;
  readonly targetId: string | null;
  stop(): void;
}
```

Behavior:

- When `__DEV__` is false and `allowInNonDevBuilds` isn't set, `startBridge` logs one warning and returns an inert handle whose `connected` is false and `targetId` is null. When `__DEV__` is undefined, as in Node tests, the bridge treats the environment as a dev build.
- Platform comes from `Platform.OS`: `android` maps to `android`, anything else to `ios`.
- Settle timing uses `clock`, never `Date.now` or global timers, so the bridge can be tested in Node with a manual clock. Animation frames come from `requestAnimationFrame`, read from the global at call time; the WebSocket comes from the global `WebSocket`.
- The bridge reconnects with exponential backoff from `reconnect.initialDelayMs` to `reconnect.maxDelayMs` after any close except a `reject`, which is final and logged once, or `stop()`.
- Every incoming payload is validated against the app's own registry before dispatch; malformed frames are dropped and logged.
- Recorded events are forwarded as they happen; state revisions are coalesced to one notification per 100 ms window; serialization warnings are sent once per path per connection.
- `clockAdvance`, `clockNow`, and `reset` answer `UNSUPPORTED`, and the bridge never declares the `clock` or `reset` capability.
- The bridge declares the `reload` capability when the `reload` option is given or `DevSettings.reload` from `react-native` is a function, and answers a `reload` request with `{}`, then calls the option (or `DevSettings.reload()` when there is no option) on the next tick of its clock, so the reply leaves before the JavaScript context goes away. A throw or a rejection from the option is logged as a warning and otherwise ignored, since the reply has already been sent. The app restarts from the bundler and the bridge reconnects as it does after any reload; `ironbird reload` waits for that and keeps the same target id. An app running in Expo Go must pass `reload: () => reloadAppAsync()`, with `reloadAppAsync` from `expo`: under Expo Go 57, `DevSettings.reload` restarts the JavaScript without Expo Go's native modules, so the app fails to boot and never reconnects.
- iOS Simulator reaches the daemon at `localhost`. Android emulators need `adb reverse tcp:4568 tcp:4568`, which `ironbird serve` runs automatically when `adb` is available. Physical devices use the host's LAN address, and the daemon must be started with `--host` and a token.

Wiring, using the layout from [architecture.md §5](architecture.md#5-integrating-an-app). The tracker and recorder are created in `instance.ts`, which only the app loads, with `enabled: __DEV__` so release builds carry neither:

```ts
// src/core/instance.ts
import { createEventRecorder, createRealClock, createTracker } from '@ironbird/core';
import { realApi, realReader } from './adapters';
import { createAppCore } from './app';

export const clock = createRealClock();
export const tracker = createTracker({ clock, enabled: __DEV__ });
export const recorder = createEventRecorder({ clock, enabled: __DEV__ });
export const appCore = createAppCore({
  reader: tracker.wrap(realReader, 'reader'),
  api: tracker.wrap(realApi, 'api'),
  clock,
});
```

```ts
// src/ironbird/device.ts
import { startBridge } from '@ironbird/react-native';
import { appCore, clock, recorder, tracker } from '../core/instance';
import { toTarget } from './target';

export function startIronbird() {
  return startBridge({
    target: toTarget(appCore),
    clock,
    tracker,
    recorder,
    appId: 'com.example.checkout',
  });
}
```

```ts
// index.js
if (__DEV__) {
  require('./src/ironbird/device').startIronbird();
}
```

Keep the `require` inside the `__DEV__` branch so production bundles drop the bridge, then prove it with `ironbird verify-bundle` in CI. Dev builds that should exercise fakes on a simulator, for example to test reader failures without hardware, wire fakes in `instance.ts` and pass them as `fakes`.

In a bare React Native app, Metro can fail on the first dev bundle that reaches your command schemas with `Export namespace should be first transformed by @babel/plugin-transform-export-namespace-from`, naming a file under `zod/v4/`. Metro picks zod's `import` condition, an ESM build that uses `export * as`, and the React Native Babel preset does not transform files inside `node_modules`. Resolve zod to its CommonJS build in `metro.config.js`:

```js
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const isZod = (name) => name === 'zod' || name.startsWith('zod/');

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    resolveRequest: (context, moduleName, platform) =>
      context.resolveRequest(isZod(moduleName) ? { ...context, isESMImport: false } : context, moduleName, platform),
  },
});
```

Expo apps (`examples/checkout`) don't need this; `examples/bare-redux/metro.config.js` carries the same setting.

### Reduce motion in agent-driven builds (P0)

Settle sees work that runs through JavaScript: tracked promises and timers, and rendered frames. It cannot see an animation that runs on the UI thread (`Animated` with the native driver, Reanimated), a `LayoutAnimation`, or an image decode, so a screenshot taken right after settle can catch that motion mid-flight. In the M1 measurement a 400 ms native-driver fade was still running in 50 of 60 Android captures, and with motion reduced no app content differed in any capture on either platform ([evals/m1-remote-mode.md](evals/m1-remote-mode.md), [ADR-0005](adr/0005-pure-javascript-no-native-code.md)).

The rule: development builds that an agent drives run with motion reduced. Put the switch in app state behind a command, so an agent or a scenario sets it first and the choice shows up in `state` and in the event log.

```ts
// src/ironbird/commands.ts
'ui.setMotion': z
  .object({ motion: z.enum(['full', 'reduced']) })
  .describe('Switch the screen between full and reduced motion'),
```

```tsx
// In a component: with motion reduced, land on the final values instead of animating.
useEffect(() => {
  if (motion === 'reduced') {
    opacity.setValue(1);
    return;
  }
  const animation = Animated.timing(opacity, { toValue: 1, duration: 400, useNativeDriver: true });
  animation.start();
  return () => animation.stop();
}, [motion, opacity, token]);
```

`examples/checkout` does this for its native-driver fades, its `LayoutAnimation`, and its header image swap. For a change that arrives from outside the app, such as a server push, use `wait` on a state condition instead of relying on settle.

## @ironbird/cli

The binary is documented in [cli.md](cli.md). The package also exports the pieces the binary is built from, for embedding a daemon in another process: `loadConfig`, `loadTypeScriptModule`, `createHeadlessTarget`, `startDaemon`, `readDaemonInfo` / `writeDaemonInfo` / `removeDaemonInfo`, `buildProgram`, `runServe`, `isLoopbackHost`, `parseCondition` / `conditionHolds`, and the scenario runner: `parseScenario` and `loadScenarioFiles` turn a file (or a directory of them) into a validated `Scenario`, made of `ScenarioStep`s and reporting any authoring error as a `ScenarioIssue`; `runScenario` runs one `Scenario` against a `DaemonClient` and returns its `ScenarioResult`, per its `RunScenarioOptions`, whose `reset` resets a target that declares the `reset` capability before the first step (design D14; `scenario run` always sets it). `createHeadlessTarget` takes an optional `loadDefinition`, which the `reload` operation calls to load the headless entry again (`runServe` passes one that re-bundles the configured entry under a fresh label); a target created without it doesn't declare `reload`. For agents, `createMcpServer` builds the `ironbird mcp` server, an `McpServer` from `@modelcontextprotocol/server` with the sixteen tools in [cli.md](cli.md#mcp-tools), from `McpServerOptions`: its `version`, the `cwd` that scenario paths resolve against, a `resolve` called on every tool call that returns a `DaemonClient` and the artifacts directory, and an optional `readImage` for screenshots. `agentSetup` does what `ironbird agent setup` does, given `AgentSetupOptions` (`cwd`, `skillsDir?`, and the `packageRoot` holding `skills/ironbird/`), and returns an `AgentSetupResult`. The headless target and the scenario engine are also published as the subpath `@ironbird/cli/runner`, in ESM and CommonJS with type declarations, for CommonJS callers such as Jest (the main entry is ESM only): it exports `createHeadlessTarget`, `loadScenarioFiles`, `parseScenario`, and `runScenario`, and the `HeadlessTarget`, `HeadlessTargetOptions`, `Scenario`, `ScenarioStep`, `RunScenarioOptions`, `DaemonClient`, and `CallOptions` types. `@ironbird/testing` reaches the CLI only through it. `DaemonClient`'s `call` and `rpc` take an optional fourth argument, `CallOptions` (`{ signal?: AbortSignal }`): aborting the signal cancels the request, which then rejects with the signal's reason.

### defineConfig (P0)

`defineConfig` is an identity function; it exists for the types and the editor completions. Validation happens in `loadConfig`, which rejects an unknown or malformed key with `INVALID_CONFIG`.

```ts
// ironbird.config.ts
import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({
  appId: 'com.example.checkout',              // reported as app.id by the headless target
  headless: './src/ironbird/headless.ts',     // omit to run remote-only
  defaultTarget: 'headless',
  daemon: { host: '127.0.0.1', port: 4567 },  // token comes from IRONBIRD_TOKEN, never from config
  bridge: { port: 4568 },
  clock: { start: '2026-01-01T00:00:00.000Z' },
  settle: { timeoutMs: 5000 },                // headless settle; remote settle is set in startBridge
  boot: { timeoutMs: 30000 },                 // how long the headless factory, or a reload's load and factory together, may take before HEADLESS_LOAD_FAILED
  scenarios: 'ironbird/scenarios',
  artifactsDir: '.ironbird',
  devices: { ios: 'booted' },                 // simctl device, or adb serial under `android`
});
```

## @ironbird/testing

Runs ironbird from Vitest or Jest against a headless definition, in process: no daemon, port, or child process. It needs Node 22 or later, ships ESM and CommonJS builds, and imports no test framework, so the same calls work in either runner. It reuses the CLI's headless target and scenario engine through `@ironbird/cli/runner` and is built on fast-check 4. `zod` 4 is a peer dependency, as for core.

### createTestTarget

```ts
function createTestTarget(options: TestTargetOptions): Promise<TestTarget>;

interface TestTargetOptions {
  headless: HeadlessDefinition;
  appId?: string;                              // reported as app.id; default 'test'
  env?: Record<string, string | undefined>;    // the factory's env; default {}, never process.env
  clockStart?: string;                         // ISO time the manual clock starts at on every boot; default the Unix epoch
  settleTimeoutMs?: number;                    // wall-clock settle bound per step; default 5000
}

interface TestTarget {
  readonly client: DaemonClient;               // the CLI's client interface, served in process
  send(command: string, payload?: unknown): Promise<StepResult>;
  fake(fake: string, control: string, payload?: unknown): Promise<StepResult>;
  advance(ms: number): Promise<StepResult & { now: number }>;
  state<T = unknown>(path?: string): Promise<T>;
  describe(): Promise<Description>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}
```

`client.call(op, params)` runs one protocol operation on the headless target and returns `{ target: 'headless', result }`, `client.rpc` returns the result alone, and failures are the target's `IronbirdError`s. A `target` argument other than `headless` fails with `NO_TARGET`, and `client.stream` fails with `UNSUPPORTED`; read events with `client.rpc('events', { since })`. `send`, `fake`, `advance`, `state`, `describe`, and `reset` are the `dispatch`, `fakeControl`, `clockAdvance`, `getState`, `describe`, and `reset` operations; `reset` boots the app again with fresh fakes and a fresh clock. After `dispose`, every call fails with `UNSUPPORTED`.

### runScenario

```ts
function runScenario(file: string, options: RunScenarioFileOptions): Promise<ScenarioResult>;

interface RunScenarioFileOptions {
  headless: HeadlessDefinition;
  env?: Record<string, string | undefined>;    // default {}
  artifacts?: string | false;                  // default false: write nothing
}
```

Runs one [scenario file](cli.md#scenario-files) the way `ironbird scenario run` does, on a fresh in-process target that is reset before the first step and disposed after the last. A relative `file` resolves against the working directory. The file always runs headless, whatever its own `target` says, so a device scenario's `screenshot` steps fail unless they are `optional`. An invalid file, a missing or unreadable path, or a directory fails with `INVALID_SCENARIO` before anything runs. A scenario that fails is not an error: the result has `passed: false` and `failedStep`, so assert on it and the step shows in the diff. With `artifacts` set to a directory, each run writes `runs/<stamp>-<slug>/` under it, with the files `scenario run` writes.

```ts
import { runScenario } from '@ironbird/testing';
import headless from '../src/ironbird/headless';

test('the saved-card checkout passes', async () => {
  const result = await runScenario('ironbird/scenarios/checkout-saved-card.yaml', { headless });
  expect(result.passed).toBe(true);
});
```

### modelTest

```ts
function modelTest<S = unknown>(options: ModelTestOptions<S>): Promise<ModelTestResult>;

interface ModelTestOptions<S> {
  headless: HeadlessDefinition;
  env?: Record<string, string | undefined>;    // default {}
  steps: ModelStep[];
  invariants: Record<string, (state: S) => boolean>;
  maxSteps?: number;                           // longest sequence; default 20
  numRuns?: number;                            // default 100
  seed?: number;                               // a 32-bit integer; default: fast-check's
  onStepError?: 'skip' | 'fail';               // default 'skip'
  artifacts?: string | false;                  // where traces go; default '.ironbird/model'
}

type ModelStep =
  | string                                                                         // a command; payload generated from its schema
  | { command: string; payload?: fc.Arbitrary<unknown> | unknown[]; weight?: number }
  | { fake: string; control: string; payload?: fc.Arbitrary<unknown> | unknown[]; weight?: number }
  | { clock: { maxMs: number }; weight?: number };                                 // advance 0 to maxMs ms

interface ModelTestResult { runs: number; seed: number; stepsApplied: number; stepsRejected: number }
```

Model-based testing in which the app is the model. Each run resets the target (a fresh app, fresh fakes, and the manual clock at its start), applies a random sequence of 1 to `maxSteps` steps, each one operation with settling, and after every step checks every invariant against the whole state. An invariant must be synchronous and return `true`; returning anything else, including `undefined` or a promise, or throwing, is a violation.

- **Generation.** Each step is drawn from the declared ones by `weight` (default 1). A `payload` list is picked from; a fast-check arbitrary, from any copy of fast-check, is used as is; with no `payload`, the payload comes from the command's or control's JSON Schema through `arbitraryFromSchema`. A clock step advances a whole number of milliseconds from 0 to `maxMs`.
- **Validation first.** Before any run the declared steps are checked against `describe()`: an unknown command, fake, or control fails with `UNKNOWN_COMMAND`, `UNKNOWN_FAKE`, or `UNKNOWN_CONTROL` and suggestions; a fake step on an app without fakes, or a clock step on a target without the `clock` capability, fails with `UNSUPPORTED`; a schema the generator can't honor, or an invalid option (a `numRuns`, `maxSteps`, or `weight` that is not a positive integer, a `seed` that is not a 32-bit integer, no steps), fails with `INVALID_PAYLOAD` whose details give the path (`{ name: 'modelTest', issues: [{ path: ['steps', 0, 'weight'], message }] }` for options).
- **Rejected steps.** A step the app rejects (`DISPATCH_FAILED`, `UNSUPPORTED`, a fake control's error) is counted in `stepsRejected` and the run continues; invariants are still checked. With `onStepError: 'fail'` it ends the run instead: after shrinking, `modelTest` throws the step's own error, with ` (modelTest step <k>, seed <seed>, path <path>)` appended to its message and `seed`, `path`, `runs`, and `steps` added to its details. `INVALID_PAYLOAD`, `CLOCK_RUNAWAY`, `INTERNAL`, `TARGET_DISCONNECTED`, and `HEADLESS_LOAD_FAILED` always end the run that way, because they mean the generator, the timing, or the target broke, not that the app declined. No trace is written for them.
- **Counterexample.** fast-check shrinks a failing run to a minimal sequence. `modelTest` then throws `IronbirdError('INVARIANT_FAILED')` with the message `Invariant "<name>" failed after <k> steps (seed <seed>, path <path>); trace: <file>` and details `{ invariant, message, seed, path, runs, steps, scenarioFile, traceReplayable }`: `message` is why the invariant failed (`returned false`, `threw: ...`), `runs` counts runs up to the failure, and `steps` are the shrunk steps up to the violation, as scenario steps, each with `rejected: true` or `false` for whether the app rejected it. `traceReplayable` is `false` when a rejected step changed the target's state or revision anyway (a dispatch that mutated and then threw, which the target reports as `DISPATCH_FAILED` without rolling back), and `true` otherwise. The same `seed` reproduces the same runs and the same counterexample.
- **Trace.** Unless `artifacts` is `false`, the applied steps are written to `<artifacts>/<UTC stamp>-<invariant slug>.trace.yaml`, a valid scenario file, and `scenarioFile` is its absolute path: a `reset`, then one `send`, `fake`, or `clock` (milliseconds) step per shrunk step the app applied. Rejected steps are left out: on replay their error would stop the scenario. A rejected step usually changed nothing; when one did, the trace is still written, `traceReplayable` is `false`, and a line in the trace's `description` names the rejected steps that changed state by their index in `details.steps`, because replay may not reproduce the violation. It has no `expect`, so `ironbird scenario run` on it passes: it reproduces the violating state rather than asserting on it. Replay it against the same environment the model test used, since the app may only misbehave under it: for the example's planted race, which `modelTest` finds with `env: { PLANT_RACE: '1' }`, run `PLANT_RACE=1 ironbird serve`, then `ironbird scenario run <trace>`. Add `wait` and `expect` steps to turn it into a regression scenario. Its `clock` steps are exact only on headless. With `artifacts: false`, `scenarioFile` is `null` and the message has no `trace:` clause. If the file can't be written, the violation is still thrown the same way, and the write error's message is in `details.traceError`, which is present only then.

```ts
import { modelTest } from '@ironbird/testing';
import type { CheckoutState } from '../src/core/checkout';
import headless from '../src/ironbird/headless';

test('no ordering of events completes an order with a zero total', async () => {
  await modelTest<CheckoutState>({
    headless,
    env: { PLANT_RACE: '1' },
    steps: [
      { command: 'cart.addItem', payload: [{ sku: 'cut-45', qty: 1 }, { sku: 'beard-20', qty: 2 }] },
      { command: 'payment.start', payload: [{ method: 'saved' }, { method: 'card' }] },
      { fake: 'api', control: 'setEcho', payload: [{ mode: 'manual' }, { mode: 'auto' }] },
      { fake: 'api', control: 'emit', payload: [{ event: 'payment.succeeded' }, { event: 'order.confirmed' }, { event: 'payment.failed' }] },
      { clock: { maxMs: 1000 } },
    ],
    invariants: {
      'completed orders have a non-zero total': (s) => !(s.order.status === 'completed' && s.order.totalCents === 0),
    },
    numRuns: 1000,
  });
});
```

The SKUs come from the example's catalog rather than the schema, because `sku` is a free string: that is what payload overrides are for.

### arbitraryFromSchema

```ts
function arbitraryFromSchema(schema: JsonSchema, options?: { name?: string }): fc.Arbitrary<unknown>;
```

A fast-check arbitrary for the JSON Schema `describe()` reports for a payload, the subset Zod 4's `toJSONSchema` emits. `modelTest` uses it for every step without a `payload`; it is exported for property tests of your own. Every value it generates is valid against the schema.

| Schema | Arbitrary |
|---|---|
| `type: object` with `properties` and `required`; `additionalProperties` absent or `false` | `fc.record`: keys in `required` always, the others sometimes, no other keys, never a null prototype |
| `enum`, `const` | `fc.constantFrom`, `fc.constant` |
| `type: string` with `minLength` / `maxLength` | `fc.string` with those bounds |
| `type: integer` / `number` with `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` | `fc.integer` / `fc.double` within the bounds, never NaN or infinite |
| `type: boolean`, `type: null` | `fc.boolean`, `fc.constant(null)` |
| `type: array` with `items`, `minItems`, `maxItems` | `fc.array` |
| `anyOf`, or `type` as a list (Zod's `.nullable()` and unions of primitives) | `fc.oneof` |
| `oneOf` | `fc.oneof` over the values that match exactly one branch. A branch whose values can be listed (`const`, `enum`, `type: boolean`, `type: null`, or a `type` list of those) contributes exactly its exclusive values, however rare. Any other branch is probed with a fixed-seed sample and kept, filtered to exclusive values, only if the sample finds one; a branch whose exclusive values the probe misses is dropped, so such a branch may never be generated. `INVALID_PAYLOAD` only when no branch contributes |

`description`, `title`, `default`, `examples`, `$schema`, `deprecated`, and `readOnly` are ignored. Any other keyword, such as `pattern` (`.regex`), `format` (`z.email()`), `multipleOf`, `propertyNames` (`z.record`), `prefixItems` (`z.tuple`), or `$ref`, and a schema with no type at all (`z.unknown()`, `z.date()`), throws `INVALID_PAYLOAD` with details `{ name, issues: [{ path, message }] }`, where `name` is `options.name` (the command, or `<fake>.<control>`; default `payload`) and `path` is the schema path, such as `['properties', 'sku', 'pattern']`. Pass a `payload` override for that step instead: the generator never guesses.

## Adapters

`@ironbird/redux` and `@ironbird/xstate` turn a state container into a core `Target`, so the daemon, the bridge, `@ironbird/testing`, and snapshots work with it unchanged. Both run in Node and Hermes and ship ESM and CommonJS builds with type declarations. Each lists `@ironbird/core`, `zod` ^4.2, and its library as peers. At runtime they import only `@ironbird/core`, plus `createActor` from `xstate`. Commands go through the registry first, so `toAction` and `toEvent` only ever see validated payloads.

### @ironbird/redux

```ts
function fromStore<R extends CommandRegistry, S, A extends Action = UnknownAction>(
  store: Store<S, A>,
  options: FromStoreOptions<R, S, A>,
): Target;

interface FromStoreOptions<R extends CommandRegistry, S, A extends Action = UnknownAction> {
  commands: R;
  toAction?: (command: CommandOf<R>) => A; // default: { type: name, payload }
  select?: (state: S) => unknown;          // default: the whole state
  restore?: { schema: z.ZodType<S> };      // requires withIronbirdRestore
}

function withIronbirdRestore<S, A extends Action, P = S>(reducer: Reducer<S, A, P>): Reducer<S, A, P>;
```

```ts
import { fromStore, withIronbirdRestore } from '@ironbird/redux';
import { configureStore } from '@reduxjs/toolkit';

export const store = configureStore({ reducer: withIronbirdRestore(rootReducer) });

// Command names match the slices' action types (`todos/add`), so the default toAction fits.
export const target = fromStore(store, { commands, select: (state) => state.todos, restore: { schema: rootStateSchema } });
```

- The default `toAction` produces the shape Redux Toolkit's action creators produce, so commands named after slice action types need no mapping.
- `select` shapes what `getState`, `waitFor`, and `watch` see. `persist` always returns the **root** state, `store.getState()`, because a projection can't rebuild the root reducer's state.
- The revision moves whenever the root state changes, including through dispatches made outside ironbird. A dispatch no reducer handles leaves it as it was.
- `restore` exists only with `restore: { schema }`, a Zod schema for the root state, and it requires the root reducer to be wrapped with `withIronbirdRestore`. The snapshot is parsed with `schema` first: a failure throws `INVALID_SNAPSHOT` with the first issue's `{ path, reason }` (a dot-separated path, `''` for the root) and leaves the store untouched. The adapter then dispatches one internal action, `@@ironbird/restore`, which the wrapper answers by returning the parsed value as the new state. If the store's state afterwards isn't that value, the reducer isn't wrapped, and the load fails `INVALID_SNAPSHOT` with `{ path: '', reason: 'the root reducer is not wrapped with withIronbirdRestore' }`.
- A command whose `toAction` returns the internal restore action fails `DISPATCH_FAILED`. Only a schema-checked snapshot may replace the state.
- Without `restore`, the target's capabilities are `['persist']`.

### @ironbird/xstate

```ts
function fromActor<R extends CommandRegistry, TLogic extends AnyStateMachine>(
  actor: Actor<TLogic>,
  options: FromActorOptions<R, TLogic>,
): ActorTarget<TLogic>;

interface FromActorOptions<R extends CommandRegistry, TLogic extends AnyStateMachine> {
  commands: R;
  toEvent?: (command: CommandOf<R>) => EventFromLogic<TLogic>; // default: { ...payload, type: name }
  select?: (snapshot: SnapshotFrom<TLogic>) => unknown;         // default: { value, context }
  restore?: {
    snapshotSchema: z.ZodType;
    actorOptions?: Omit<ActorOptions<TLogic>, 'snapshot' | 'state'>;
  };
}

type ActorTarget<TLogic extends AnyStateMachine> = Target & {
  /** The live actor; a restore replaces it. */
  actor(): Actor<TLogic>;
};
```

```ts
import { fromActor } from '@ironbird/xstate';
import { defineHeadless } from '@ironbird/core';
import { createActor } from 'xstate';
import { z } from 'zod';

export default defineHeadless(({ clock }) => {
  const actorOptions = { clock }; // delayed transitions run on the headless clock
  const target = fromActor(createActor(checkoutMachine, actorOptions).start(), {
    commands,
    restore: {
      snapshotSchema: z.looseObject({ status: z.literal('active'), value: z.string(), context: checkoutContextSchema }),
      actorOptions,
    },
  });
  return {
    target,
    dispose: () => {
      target.actor().stop();
    },
  };
});
```

- Pass a started **root** actor.
- The default event is the payload's keys plus `type: name`, with `type` applied last, so a payload key named `type` never renames the event. A payload that isn't an object is sent as `{ type: name, payload }`.
- The revision moves whenever the actor's snapshot changes, including through events sent outside ironbird and delayed transitions. An event no state handles leaves it as it was.
- `dispatch` fails `DISPATCH_FAILED` with `the actor is <status>` when the actor isn't active. It fails with `the actor failed: <message>` when the event puts the actor in error.
- The adapter observes the actor with an error callback, so an actor error never escapes through it as an uncaught exception. The error moves the revision, and the next dispatch reports it. XState rethrows an actor's error from a timer only when some observer lacks an error callback.
- `persist` returns `actor().getPersistedSnapshot()`. That value carries `undefined` properties, which `snapshotSave`'s strict serializer omits.
- `restore` exists only with `restore: { snapshotSchema, actorOptions? }`. It runs synchronously after validation, so no event reaches either actor in between:
  1. Parse the snapshot with `snapshotSchema`. On failure, it throws `INVALID_SNAPSHOT` with the first issue's `{ path, reason }`, and nothing has changed.
  2. Build and start the replacement: `createActor(actor().logic, { ...actorOptions, snapshot })`. If that throws or the actor's status is `error`, the replacement is stopped and the call throws `INVALID_SNAPSHOT` with `{ path: '', reason: 'actor failed to start: <message>' }`. The old actor stays live and subscribed.
  3. On success, the adapter moves its subscription to the replacement, stops the old actor, makes `actor()` return the replacement, and notifies once.
- Write `snapshotSchema` with `z.looseObject`, or declare `children` and `historyValue`. `z.object` strips the keys it doesn't declare, and XState can't restore a snapshot without `children`; that fails at step 2.
- Pass the options the original actor was created with as `actorOptions`, especially `clock` in a headless definition. The replacement doesn't inherit them.

Consequences of a restore:
- App code holding the old actor reference sees a stopped actor. Read `actor()` instead, and read it again when the target notifies, for example to re-render. While the old actor's observers run their `complete` callbacks, `actor()` still returns the old, stopped actor, so an event sent through it there is dropped; react to the target's notification instead, which comes once, after the swap.
- As in XState persistence, the restored state's invoked and spawned actors restart, and the old actor's stop. Entry actions aren't re-run. Both actors exist for one synchronous turn, so effects that start on `start()` can run once more than in the original timeline.
- Delayed transitions (`after`) that were pending when the snapshot was saved don't fire after a restore, because XState's persisted snapshot holds no scheduled events. A restored state waiting on a delay stays in it until an event moves it.
- `snapshotLoad` runs in the target's mutating queue, so no ironbird dispatch interleaves with a restore.
- Without `restore`, the target's capabilities are `['persist']`.
