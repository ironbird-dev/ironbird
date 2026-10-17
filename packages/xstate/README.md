# @ironbird/xstate

Turn an XState actor into an ironbird target. Agents and tests drive it through your declared, validated commands, read its state, and save and load snapshots.

```sh
npm install @ironbird/core @ironbird/xstate
```

```ts
import { defineCommands } from '@ironbird/core';
import { fromActor } from '@ironbird/xstate';
import { createActor } from 'xstate';
import { z } from 'zod';
import { checkoutMachine } from './checkout';

const commands = defineCommands({
  'cart.add': z.object({ sku: z.string(), qty: z.number().int().min(1) }).describe('Add an item'),
});

// Sends { sku, qty, type: 'cart.add' }. After a restore, read the live actor with target.actor().
export const target = fromActor(createActor(checkoutMachine).start(), {
  commands,
  restore: { snapshotSchema: z.looseObject({ status: z.literal('active'), value: z.string(), context: z.unknown() }) },
});
```

Requires XState 5 and `zod` 4.2 or later. Runs in Node and React Native. Reference: [API](https://github.com/ironbird-dev/ironbird/blob/main/docs/api.md#ironbirdxstate). MIT licensed.
