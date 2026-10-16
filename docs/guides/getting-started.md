# Getting started: add ironbird to a React Native app

| | |
|---|---|
| Applies to | ironbird 0.1 |
| Last updated | 2026-10-11 |
| Related | [api.md](../api.md) · [cli.md](../cli.md) · [architecture.md §5](../architecture.md#5-integrating-an-app) · [agents.md](../agents.md) |

This guide wires ironbird into an existing React Native app whose logic lives in a Redux Toolkit store. When you finish, `npx ironbird serve` runs the app's logic in Node, a scenario file drives it through typed commands, a development build connects to the same daemon, and release builds leave the bridge out; `ironbird verify-bundle` checks that (step 9). With an XState actor instead of a store, follow the same steps with `fromActor` from `@ironbird/xstate` in step 5 ([api.md](../api.md#adapters)).

The examples use a small cart: a `cart` slice and an `api` port that submits orders. Use your app's names instead. [`examples/bare-redux`](../../examples/bare-redux) is a complete bare React Native app wired this way.

## 1. Install

```sh
npm install @ironbird/core @ironbird/react-native @ironbird/redux zod@^4.2
npm install --save-dev @ironbird/cli
```

ironbird needs Node 22 or later and `zod` 4.2 or later. An app still on Zod 3 can follow [migrating-from-zod-3.md](../migrating-from-zod-3.md).

## 2. Make the store buildable in Node

The daemon runs your logic in Node, so the store and everything it imports must not import `react-native`. Ports, the interfaces through which the logic reaches the outside world, are passed in, so headless mode can pass fakes. Effects that call a port, here a listener middleware, run as usual.

```ts
// src/ports.ts
export interface CartApi {
  submitOrder(items: Array<{ sku: string; qty: number }>): Promise<{ orderId: string }>;
}

export interface Ports {
  api: CartApi;
}
```

```ts
// src/cart.ts
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface CartState {
  items: Array<{ sku: string; qty: number }>;
  status: 'open' | 'submitting' | 'confirmed';
  orderId?: string;
}

const initialState: CartState = { items: [], status: 'open' };

export const cartSlice = createSlice({
  name: 'cart',
  initialState,
  reducers: {
    addItem(state, action: PayloadAction<{ sku: string; qty: number }>) {
      state.items.push(action.payload);
    },
    checkoutRequested(state) {
      state.status = 'submitting';
    },
    orderConfirmed(state, action: PayloadAction<{ orderId: string }>) {
      state.status = 'confirmed';
      state.orderId = action.payload.orderId;
    },
  },
});
```

```ts
// src/store.ts
import { configureStore, createListenerMiddleware } from '@reduxjs/toolkit';
import { cartSlice, type CartState } from './cart';
import type { Ports } from './ports';

export function makeStore(ports: Ports) {
  const listener = createListenerMiddleware();
  listener.startListening({
    actionCreator: cartSlice.actions.checkoutRequested,
    effect: async (_action, api) => {
      const { cart } = api.getState() as { cart: CartState };
      const { orderId } = await ports.api.submitOrder(cart.items);
      api.dispatch(cartSlice.actions.orderConfirmed({ orderId }));
    },
  });
  return configureStore({
    reducer: { cart: cartSlice.reducer },
    middleware: (getDefault) => getDefault().prepend(listener.middleware),
  });
}

export type AppStore = ReturnType<typeof makeStore>;
```

If a `react-native` import sneaks into this graph, the daemon refuses to load it with `HEADLESS_LOAD_FAILED` and names the chain of imports that led to it.

## 3. Declare commands

Commands are what an agent may do. Name them for the user's intent and give each payload a Zod schema; the daemon validates every payload before your code sees it, and agents read the schemas as JSON Schema.

```ts
// src/ironbird/commands.ts
import { z } from 'zod';
import { defineCommands } from '@ironbird/core';

export const commands = defineCommands({
  'cart.addItem': z.object({ sku: z.string(), qty: z.number().int().positive() }).describe('Add an item to the cart'),
  'cart.checkout': z.object({}).describe('Submit the cart as an order'),
});
```

## 4. Fake the ports

A fake implements a port for headless runs and declares controls, so a scenario or an agent can script the outside world. It takes time from the `clock` it is given, never from global timers, so headless runs are deterministic.

```ts
// src/ironbird/fakes.ts
import { z } from 'zod';
import { defineFake } from '@ironbird/core';
import type { CartApi } from '../ports';

export const fakeApi = defineFake('api', {
  description: 'The order API',
  controls: {
    setLatency: z.object({ ms: z.number().int().min(0) }).describe('Delay every response by this many milliseconds'),
    failNext: z.object({}).describe('Make the next submitOrder call reject'),
  },
  create({ clock, record }) {
    let latencyMs = 200;
    let failNext = false;
    let next = 1;
    const port: CartApi = {
      submitOrder: (items) =>
        new Promise((resolve, reject) => {
          clock.setTimeout(
            () => {
              if (failNext) {
                failNext = false;
                reject(new Error('order rejected'));
                return;
              }
              const orderId = `order-${next++}`;
              record('order.submitted', { orderId, items: items.length });
              resolve({ orderId });
            },
            latencyMs,
            'api.submitOrder',
          );
        }),
    };
    return {
      port,
      controls: {
        setLatency: ({ ms }) => {
          latencyMs = ms;
        },
        failNext: () => {
          failNext = true;
        },
      },
    };
  },
});
```

## 5. Adapt the store

`fromStore` turns a store into a target, the thing the daemon drives. By default a command becomes the action `{ type: name, payload }`; when your actions are named differently, map them with `toAction`, which receives the validated command as `{ name, payload }`:

```ts
// src/ironbird/target.ts
import { fromStore } from '@ironbird/redux';
import { cartSlice } from '../cart';
import type { AppStore } from '../store';
import { commands } from './commands';

export const toTarget = (store: AppStore) =>
  fromStore(store, {
    commands,
    toAction: (command) => {
      switch (command.name) {
        case 'cart.addItem':
          return cartSlice.actions.addItem(command.payload);
        case 'cart.checkout':
          return cartSlice.actions.checkoutRequested();
      }
    },
  });
```

`fromStore` also takes `select`, to show agents part of the state, and `restore`, for `ironbird snapshot load`; see [api.md](../api.md#ironbirdredux).

## 6. Write the headless entry and the config

The daemon calls this factory at start and on every `reset`, each time with a fresh manual clock, event recorder, and tracker. Wrap each port with the tracker, so `send` waits for the effects it starts.

```ts
// src/ironbird/headless.ts
import { defineHeadless } from '@ironbird/core';
import { makeStore } from '../store';
import { fakeApi } from './fakes';
import { toTarget } from './target';

export default defineHeadless(({ clock, recorder, tracker }) => {
  const api = fakeApi.create({ clock, recorder });
  const store = makeStore({ api: tracker.wrap(api.port, 'api') });
  return { target: toTarget(store), fakes: [api] };
});
```

```ts
// ironbird.config.ts
import { defineConfig } from '@ironbird/cli/config';

export default defineConfig({
  appId: 'com.example.shop',
  headless: './src/ironbird/headless.ts',
  scenarios: 'ironbird/scenarios',
});
```

Add `.ironbird/` to `.gitignore`: the daemon writes its address and run artifacts there. `npx ironbird doctor` checks the Node version, the config, the headless entry, the daemon and bridge ports, `.gitignore`, and that every installed ironbird package has the same version, in one go ([cli.md](../cli.md#doctor)).

## 7. Drive it

```sh
npx ironbird serve                                    # leave it running in its own terminal
npx ironbird commands                                 # names, descriptions, JSON Schemas
npx ironbird send cart.addItem '{"sku":"tee","qty":2}'
npx ironbird send cart.checkout --path cart           # ends quiescent: the fake's 200 ms timer is pending
npx ironbird clock advance 200ms --path cart
npx ironbird state cart.status                        # "confirmed"
npx ironbird fake api failNext                        # script the outside world
```

Pin the flow down as a scenario, which runs the same way against a device later:

```yaml
# ironbird/scenarios/checkout.yaml
name: Checkout confirms the order
steps:
  - send: cart.addItem
    payload: { sku: tee, qty: 2 }
  - send: cart.checkout
  - clock: 200ms
    optional: true   # headless only; on a device the real API answers
  - expect: cart.status
    equals: confirmed
```

```sh
npx ironbird scenario run ironbird/scenarios --target headless
```

The same file runs from Vitest or Jest without a daemon through `runScenario` in [`@ironbird/testing`](../api.md#ironbirdtesting).

## 8. Connect a development build

The app builds its real store once, with the real ports wrapped by a tracker and a recorder that are switched off outside development builds. `realApi` is your app's own implementation of `CartApi`; this file and the ones below run only in the app, so they may import `react-native`.

```ts
// src/instance.ts
import { createEventRecorder, createRealClock, createTracker } from '@ironbird/core';
import { realApi } from './adapters/api';
import { makeStore } from './store';

export const clock = createRealClock();
export const tracker = createTracker({ clock, enabled: __DEV__ });
export const recorder = createEventRecorder({ clock, enabled: __DEV__ });
export const store = makeStore({ api: tracker.wrap(realApi, 'api') });
```

```ts
// src/ironbird/device.ts
import { startBridge } from '@ironbird/react-native';
import { clock, recorder, store, tracker } from '../instance';
import { toTarget } from './target';

export function startIronbird() {
  return startBridge({ target: toTarget(store), clock, tracker, recorder, appId: 'com.example.shop' });
}
```

Start the bridge from `index.js`, inside a `__DEV__` branch, with `require`, so release bundles drop it entirely. Metro replaces `__DEV__` with `false` in a release build and removes the branch, `require` included, before it collects dependencies; a top-level `import` of `device.ts` would keep the bridge in the bundle.

```js
// index.js
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

if (__DEV__) {
  require('./src/ironbird/device').startIronbird();
}

AppRegistry.registerComponent(appName, () => App);
```

The app's UI keeps using `store` from `src/instance.ts`.

A bare React Native app also needs one Metro setting. Without it, the first development bundle that reaches your command schemas can fail with `Export namespace should be first transformed by @babel/plugin-transform-export-namespace-from`, naming a file under `zod/v4/`: Metro picks zod's ESM build, and the React Native Babel preset doesn't transform files inside `node_modules`. Resolve zod to its CommonJS build in `metro.config.js` ([api.md](../api.md#startbridge-p0)):

```js
// metro.config.js
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const isZod = (name) => name === 'zod' || name.startsWith('zod/');

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    resolveRequest: (context, moduleName, platform) =>
      context.resolveRequest(isZod(moduleName) ? { ...context, isESMImport: false } : context, moduleName, platform),
  },
});
```

An Expo app doesn't need that setting. It puts the same `if (__DEV__)` block in its entry file, before `registerRootComponent(App)`. An app that runs in Expo Go must also pass `reload: () => reloadAppAsync()` to `startBridge`, with `reloadAppAsync` from `expo`; the default, `DevSettings.reload`, restarts the JavaScript without Expo Go's native modules, so the app never comes back for `ironbird reload`. [`examples/checkout`](../../examples/checkout) is wired this way.

With `npx ironbird serve` running, start the app on a simulator; `npx ironbird status` then lists an `ios` (or `android`) target next to `headless`, and every command above works with `--target ios`, except `clock`, which is headless only, and `fake`: the app above wires its real API, so the bridge has no fakes and `ironbird fake` fails there with `UNSUPPORTED`. To script fakes in a development build, wire them in `instance.ts` and pass them to `startBridge` as `fakes` ([api.md](../api.md#startbridge-p0)). The `appId` in `startBridge` must match the config's `appId`, or the daemon refuses the connection with `APP_MISMATCH`. The iOS Simulator reaches the daemon at `localhost` directly; for an Android emulator, `ironbird serve` runs `adb reverse` when `adb` is on the path.

## 9. Prove release builds are clean

```sh
npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output build/main.jsbundle
npx ironbird verify-bundle build/main.jsbundle    # exit code 0: the bridge isn't in the bundle
```

For an Expo app, bundle with `npx expo export --platform all --output-dir dist` and run `npx ironbird verify-bundle dist`. Run the same two commands in CI on every release build.

## Next

- Let a coding agent use it: [agents.md](../agents.md) (`npx ironbird agent setup`).
- Run scenarios and model-based tests from Vitest or Jest: [`@ironbird/testing`](../api.md#ironbirdtesting).
- Save and restore state, and watch it change: `ironbird snapshot` and `ironbird watch` in [cli.md](../cli.md).
