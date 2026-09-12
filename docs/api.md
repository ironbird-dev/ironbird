# ironbird: API Reference (draft)

| | |
|---|---|
| Status | Draft; signatures will change during M0–M2 |
| Last updated | 2026-09-11 |
| Related | [protocol.md](protocol.md) for wire types and error codes · [cli.md](cli.md) for the CLI |

Priority markers match [spec.md](spec.md): **P0** ships in 0.1, **P1** is planned for 0.1 if milestones hold.

## @ironbird/core

Runs unmodified in Node and Hermes. Peer dependency: `zod@^4`.

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

### createTarget (P0)

```ts
function createTarget<R extends CommandRegistry, S>(definition: {
  commands: R;
  dispatch(command: CommandOf<R>): void | Promise<void>;
  getState(): S;
  subscribe?(listener: () => void): () => void;
  persist?(): unknown;                                // P1
  restore?(snapshot: unknown): void | Promise<void>;  // P1
}): Target<S>;

interface Target<S = unknown> {
  readonly commands: CommandRegistry;
  readonly capabilities: ReadonlyArray<'persist' | 'restore'>;
  /** Validates with the registry, then calls definition.dispatch with the parsed payload. */
  dispatch(name: string, payload?: unknown): Promise<void>;
  getState(): S;
  /** Increments on every subscribe notification, or on every dispatch when subscribe is absent. */
  revision(): number;
  subscribe(listener: () => void): () => void;
}
```

`capabilities` lists only what the `Target` itself provides. The daemon and bridge add `settle`, `events`, `fakes`, `clock`, and `reset` as appropriate when they describe the target; see [protocol.md §5](protocol.md#5-types).

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

`advance` throws `IronbirdError('CLOCK_RUNAWAY')` after 10,000 firings in one call. App code under test should take time only from an injected `Clock`.

### createTracker (P0)

```ts
interface Tracker {
  track<T>(promise: Promise<T>, label: string, options?: { fake?: boolean }): Promise<T>;
  /** Shallow proxy: each method returning a thenable is tracked as `${name}.${method}`. */
  wrap<P extends object>(port: P, name: string, options?: { fake?: boolean }): P;
  pending(): PendingItem[];
  whenIdle(options?: { timeoutMs?: number; mode?: 'idle' | 'quiescent' }): Promise<SettleResult>;
  onChange(listener: () => void): () => void;
}

function createTracker(options?: { clock?: Clock; timerThresholdMs?: number; enabled?: boolean }): Tracker;

/** Tags a port so wrap marks its calls fake: true; defineFake does this for every fake port. */
function markFakePort<P extends object>(port: P): P;
```

With a real clock, timers due within `timerThresholdMs` (default 1,000) count as pending. Manual-clock timers never count. Wrapping is always explicit, so the app chooses the label; when the port passed to `wrap` is a `FakeInstance.port`, which the fake tags with a private symbol, its calls are marked `fake: true`, which is what allows `mode: 'quiescent'` to finish without advancing time. Hand-written fakes, such as the M0 example's, call `markFakePort` on the port or pass `{ fake: true }` to `wrap`. With `enabled: false` (app code passes `enabled: __DEV__`), `wrap` returns the port untouched, `track` returns the promise untouched, `pending()` is empty, and `whenIdle` resolves idle at once, so release builds carry no tracking. `PendingItem` and `SettleResult` are defined in [protocol.md](protocol.md#5-types). `whenIdle`'s `timeoutMs` and every `ageMs` are wall-clock milliseconds, because a manual clock never advances on its own; only the settle result's `nextTimerInMs` is manual-clock time.

### defineFake (P0)

```ts
function defineFake<Port extends object, C extends Schemas>(
  name: string,
  definition: {
    description?: string;
    controls: C;
    create(context: FakeContext<C>): Port;
  },
): FakeFactory<Port, C>;

interface FakeContext<C extends Schemas> {
  readonly clock: Clock;
  on<K extends keyof C & string>(
    control: K,
    handler: (payload: z.output<C[K]>) => void | Promise<void>,
  ): void;
  /** Records an event with source = the fake's name. */
  record(name: string, data?: unknown): void;
}

interface FakeFactory<Port extends object, C extends Schemas> {
  readonly name: string;
  create(deps: { clock: Clock; recorder?: EventRecorder }): FakeInstance<Port, C>;
}

interface FakeInstance<Port extends object = object, C extends Schemas = Schemas> {
  readonly name: string;
  /** Call-recording proxy over the port returned by create(). */
  readonly port: Port;
  readonly controls: CommandRegistry<C>;
  control(name: string, payload?: unknown): Promise<void>;
  calls(since?: number): FakeCall[]; // P1
}
```

Example: a fake card reader. Annotating the return type of `create` lets TypeScript infer both generics.

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
  create({ on, clock, record }): CardReaderPort {
    const listeners = new Set<(event: ReaderEvent) => void>();
    let failReason: string | undefined;
    let latencyMs = 1200;

    on('emit', ({ event }) => {
      record(event);
      listeners.forEach((listener) => listener({ type: event }));
    });
    on('failNextPayment', ({ reason }) => {
      failReason = reason;
    });
    on('setLatency', ({ ms }) => {
      latencyMs = ms;
    });

    return {
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
  },
});
```

### createEventRecorder (P0)

```ts
interface EventRecorder {
  record(source: string, name: string, data?: unknown): RecordedEvent;
  since(seq?: number, limit?: number): { events: RecordedEvent[]; nextSeq: number; truncated: boolean };
  subscribe(listener: (event: RecordedEvent) => void): () => void;
  clear(): void;
}

function createEventRecorder(options?: { clock?: Clock; limit?: number; enabled?: boolean }): EventRecorder;
```

`limit` defaults to 10,000. With `enabled: false`, `record` is a no-op and `since` returns nothing, so release builds carry no event log. To capture analytics, wrap your analytics adapter so each call also records: `recorder.record('analytics', name, properties)`.

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

The module named by `headless` in `ironbird.config.ts` must default-export the result. The daemon calls the factory on start and again on `reset`, each time with a fresh context. `HeadlessDefinition` has `kind: 'ironbird.headless'` and an async `create(context)`; the daemon checks the loaded default export with `isHeadlessDefinition` and fails with `HEADLESS_LOAD_FAILED` otherwise.

### IronbirdError (P0)

```ts
class IronbirdError extends Error {
  readonly code: ErrorCode;   // see protocol.md §6
  readonly details?: unknown;
}

const PROTOCOL_VERSION: 1;
```

## @ironbird/react-native

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
  url?: string;                                                 // default 'ws://localhost:4568'
  token?: string;
  settle?: { frames?: number; timeoutMs?: number };             // defaults 2 and 5000
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number }; // defaults 500 and 5000
  allowInNonDevBuilds?: boolean;                                // default false
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

interface BridgeHandle {
  readonly connected: boolean;
  readonly targetId: string | null;
  stop(): void;
}
```

Behavior:

- When `__DEV__` is false and `allowInNonDevBuilds` isn't set, `startBridge` logs one warning and returns an inert handle.
- Platform comes from `Platform.OS`.
- Settle timing uses `clock`, never `Date.now` or global timers, so the bridge can be tested in Node with a manual clock. Animation frames come from `requestAnimationFrame`.
- iOS Simulator reaches the daemon at `localhost`. Android emulators need `adb reverse tcp:4568 tcp:4568`, which `ironbird serve` runs automatically when `adb` is available. Physical devices use the host's LAN address, and the daemon must be started with `--host` and a token.
- Every incoming payload is validated against the app's own registry before dispatch.

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

## @ironbird/cli

The binary is documented in [cli.md](cli.md). The package also exports configuration helpers.

### defineConfig (P0)

```ts
// ironbird.config.ts
import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({
  headless: './src/ironbird/headless.ts',     // omit to run remote-only
  defaultTarget: 'headless',
  daemon: { host: '127.0.0.1', port: 4567 },  // token comes from IRONBIRD_TOKEN, never from config
  bridge: { port: 4568 },
  clock: { start: '2026-01-01T00:00:00.000Z' },
  settle: { timeoutMs: 5000 },                // headless settle; remote settle is set in startBridge
  scenarios: 'ironbird/scenarios',
  artifactsDir: '.ironbird',
  devices: { ios: 'booted' },                 // simctl device, or adb serial under `android`
});
```

## @ironbird/testing (P1, sketch)

Depends on the resolution of open question Q6.

```ts
function runScenario(file: string, options: { headless: HeadlessDefinition }): Promise<ScenarioResult>;

function modelTest<S>(options: {
  headless: HeadlessDefinition;
  steps: Array<
    | string                                          // a command; payloads generated from its schema
    | { fake: string; control: string }               // a fake control; payloads generated from its schema
    | { clock: { maxMs: number } }                    // advance the clock by a random amount
  >;
  invariants: Record<string, (state: S) => boolean>;  // name → must hold after every step
  numRuns?: number;                                   // default 100
  seed?: number;
}): Promise<void>;
```

```ts
test('no ordering of events completes an order with a zero total', async () => {
  await modelTest<AppState>({
    headless,
    steps: [
      'cart.addItem',
      'payment.start',
      { fake: 'api', control: 'emit' },
      { fake: 'reader', control: 'emit' },
      { clock: { maxMs: 5000 } },
    ],
    invariants: {
      'completed orders have a non-zero total': (s) => !(s.order.status === 'completed' && s.order.total === 0),
    },
    numRuns: 1000,
  });
});
```

## Adapters (P1)

### @ironbird/xstate

```ts
function fromActor<R extends CommandRegistry>(
  actor: AnyActorRef,
  options: {
    commands: R;
    toEvent?: (command: CommandOf<R>) => EventObject;   // default: { type: name, ...payload }
    select?: (snapshot: AnyMachineSnapshot) => unknown; // default: { value, context }
  },
): Target;
```

Supports `persist` through `getPersistedSnapshot()`. `restore` requires recreating the actor, so the adapter exposes it only when given an actor factory.

### @ironbird/redux

```ts
function fromStore<R extends CommandRegistry, S>(
  store: Store<S>,
  options: {
    commands: R;
    toAction?: (command: CommandOf<R>) => UnknownAction; // default: { type: name, payload }
    select?: (state: S) => unknown;                      // default: identity
  },
): Target;
```
