# @ironbird/testing

Run ironbird scenarios and model-based tests from Vitest or Jest against your app's headless definition, in process, with no daemon.

```sh
npm install --save-dev @ironbird/testing
```

```ts
import { modelTest, runScenario } from '@ironbird/testing';
import type { CheckoutState } from './src/core/checkout';
import headless from './src/ironbird/headless';

test('the saved-card checkout passes', async () => {
  const result = await runScenario('ironbird/scenarios/checkout-saved-card.yaml', { headless });
  expect(result.passed).toBe(true);
});

test('no ordering of events completes an order with a zero total', async () => {
  await modelTest<CheckoutState>({
    headless,
    // Payload lists where a schema allows values the app rejects: `sku` is a free string, but only
    // catalog SKUs add anything, so generated SKUs would make nearly every add a rejected step.
    steps: [
      { command: 'cart.addItem', payload: [{ sku: 'cut-45', qty: 1 }, { sku: 'beard-20', qty: 2 }, { sku: 'shampoo-12', qty: 1 }] },
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

A failing model test throws `INVARIANT_FAILED` with the seed and the shrunk steps, and writes them as a scenario file under `.ironbird/model/` that `ironbird scenario run` replays.

Node 22 or later, ESM or CommonJS, with `zod` 4 installed. Reference: [API](https://github.com/ironbird-dev/ironbird/blob/main/docs/api.md#ironbirdtesting) · [Pairing with React Native Testing Library](https://github.com/ironbird-dev/ironbird/blob/main/docs/guides/react-native-testing-library.md). MIT licensed.
