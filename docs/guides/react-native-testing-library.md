# Pairing ironbird with React Native Testing Library

React Native Testing Library (RNTL) and ironbird test different layers of one app, and they work best when both drive the same app core through the same commands. This guide shows how to share that core, how to drive the same commands from both, and when to reach for which. The code follows the layout of [`examples/checkout`](../../examples/checkout), with two differences: the example builds its core inline in `headless.ts`, and its screen imports a module-level instance. This guide factors the first into a shared function and passes the second through React context, which is what lets a test supply its own. The screen code and the RNTL tests are illustrative, because the example app deliberately has no component tests.

## Which one to use

| | RNTL component test | ironbird (`@ironbird/testing`, or an agent through the CLI) |
|---|---|---|
| Runs | Your components, rendered by Jest with the React Native preset | The app core and its fakes, headless in Node; or the full app on a device |
| Drives the app by | Pressing and typing into elements found by text, role, or test ID | Typed commands, fake controls, and clock advances |
| Checks | What the screen shows | The state, events, and fake calls; screenshots on a device |
| Best for | Wiring: a button sends the right command; a state renders the right text | Logic: orderings of events, races, retries, timeouts; scenarios an agent can replay |

Write an RNTL test when the question is "does the screen do the right thing with this state?". Write a scenario or a model test when the question is "can the app ever reach this state?". The race the example plants is invisible to a component test that presses buttons in the usual order, and a model test finds it; a model test can't tell you that the receipt shows the wrong total, and a component test can.

## Share one app core

Keep the app's logic in a plain TypeScript core (the example's `createAppCore` in `src/core/app.ts`) that takes its ports, including the `Clock`, as arguments. Then build it in exactly one place for tests, and use that place from both the headless definition and the RNTL helper. The example does this inline in `src/ironbird/headless.ts`; pull the body out into a function both can call:

```ts
// src/ironbird/checkout.ts: the core wired to its fakes, for every test
import type { HeadlessContext } from '@ironbird/core';
import { createAppCore } from '../core/app';
import { fakeApi } from './fakes/api';
import { fakeReader } from './fakes/reader';
import { toTarget } from './target';

export function createCheckout({ clock, recorder, tracker, env }: HeadlessContext) {
  const reader = fakeReader.create({ clock, recorder });
  const api = fakeApi.create({ clock, recorder });
  const app = createAppCore(
    {
      reader: tracker.wrap(reader.port, 'reader'),
      api: tracker.wrap(api.port, 'api'),
      analytics: { track: (name, properties) => void recorder.record('analytics', name, properties) },
      clock,
    },
    { plantRace: env['PLANT_RACE'] === '1' },
  );
  return { app, target: toTarget(app), reader, api };
}
```

```ts
// src/ironbird/headless.ts
import { defineHeadless } from '@ironbird/core';
import { createCheckout } from './checkout';

export default defineHeadless((context) => {
  const { app, target, reader, api } = createCheckout(context);
  return { target, fakes: [reader, api], dispose: () => app.dispose() };
});
```

The example's screen reads a module-level instance (`appCore` from `src/core/instance.ts`), which is built on the real clock. For a component test, the screen should receive the core instead, so a test can hand it one built on the manual clock. A React context is enough:

```tsx
// src/core/AppCoreContext.tsx
import { createContext, useContext } from 'react';
import type { AppCore } from './app';

export const AppCoreContext = createContext<AppCore | null>(null);

export function useAppCore(): AppCore {
  const app = useContext(AppCoreContext);
  if (!app) throw new Error('Wrap the screen in AppCoreContext.Provider');
  return app;
}
```

Replace the screen's `appCore` import with `useAppCore()`. The device build provides the instance it creates on the real clock; tests provide one from `createCheckout`.

## Drive the same commands in both

The RNTL helper builds the core on a manual clock and renders the screen around it. It returns the `Target` too, so a test can set up state with the same commands an agent sends, and the clock, so it controls time the way `ironbird clock` does:

```tsx
// test/render-checkout.tsx
import { createEventRecorder, createManualClock, createTracker } from '@ironbird/core';
import { render } from '@testing-library/react-native';
import { AppCoreContext } from '../src/core/AppCoreContext';
import { CheckoutScreen } from '../src/CheckoutScreen';
import { createCheckout } from '../src/ironbird/checkout';

export function renderCheckout(env: Record<string, string | undefined> = {}) {
  const clock = createManualClock({ now: 0 });
  const recorder = createEventRecorder({ clock });
  const tracker = createTracker({ clock });
  const checkout = createCheckout({ clock, recorder, tracker, env });
  const view = render(
    <AppCoreContext.Provider value={checkout.app}>
      <CheckoutScreen />
    </AppCoreContext.Provider>,
  );
  return { ...view, ...checkout, clock };
}
```

```tsx
// test/checkout-screen.test.tsx
import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderCheckout } from './render-checkout';

test('paying with the saved card shows the receipt', async () => {
  const { target, clock } = renderCheckout();
  await act(() => target.dispatch('ui.setMotion', { motion: 'reduced' }));
  await act(() => target.dispatch('cart.addItem', { sku: 'cut-45', qty: 1 }));
  fireEvent.press(screen.getByText('Pay with saved card'));
  await act(() => clock.advance(800));                  // the fake API's 300 ms submission and 500 ms echo
  expect(screen.getByText('succeeded')).toBeOnTheScreen();
  expect(screen.getByText('$45.00')).toBeOnTheScreen();
});
```

The same flow headless, with no rendering, through `@ironbird/testing`:

```ts
// test/checkout.logic.test.ts
import { createTestTarget } from '@ironbird/testing';
import headless from '../src/ironbird/headless';

test('a saved-card payment completes', async () => {
  const target = await createTestTarget({ headless });
  try {
    await target.send('cart.addItem', { sku: 'cut-45', qty: 1 });
    await target.send('payment.start', { method: 'saved' });
    expect(await target.state('payment.status')).toBe('submitting');
    await target.advance(800);
    expect(await target.state('order.status')).toBe('completed');
  } finally {
    await target.dispose();
  }
});
```

Or as a scenario file an agent can also run against a device: `runScenario('ironbird/scenarios/checkout-saved-card.yaml', { headless })`. And to search for orderings nobody wrote down, a `modelTest` over the same commands; see [api.md](../api.md#modeltest).

## Practical notes

- Dispatch through `target.dispatch`, not `app.send`, in component tests too: it validates the payload with the same schema an agent's command goes through, so a test can't set up a state the app could never receive.
- Wrap `target.dispatch` and `clock.advance` in `act`, because both change state the screen renders.
- Switch motion to `reduced` (`ui.setMotion` in the example) so animations don't depend on wall-clock time while the app's own time comes from the manual clock.
- `@ironbird/testing` ships a CommonJS build, so it runs in the same Jest setup as RNTL with no transform for it; keep logic tests in `*.logic.test.ts` if you want to run them without the React Native preset.
- When a model test fails, its trace in `.ironbird/model/` replays with `ironbird scenario run` on headless or a device. Add an `expect` for the bad state, and keep it as a regression scenario next to your RNTL tests.
