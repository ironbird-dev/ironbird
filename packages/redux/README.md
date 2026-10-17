# @ironbird/redux

Turn a Redux store into an ironbird target. Agents and tests drive it through your declared, validated commands, read its state, and save and load snapshots.

```sh
npm install @ironbird/core @ironbird/redux
```

```ts
import { defineCommands } from '@ironbird/core';
import { fromStore, withIronbirdRestore } from '@ironbird/redux';
import { configureStore } from '@reduxjs/toolkit';
import { z } from 'zod';
import { rootReducer, rootStateSchema } from './store';

export const store = configureStore({ reducer: withIronbirdRestore(rootReducer) });

const commands = defineCommands({
  'todos/add': z.object({ text: z.string().min(1) }).describe('Add a to-do'),
});

// Command names match the slice's action types, so no toAction is needed.
export const target = fromStore(store, { commands, select: (state) => state.todos, restore: { schema: rootStateSchema } });
```

Requires Redux 5 (Redux Toolkit 2) and `zod` 4.2 or later. Runs in Node and React Native. Reference: [API](https://github.com/ironbird-dev/ironbird/blob/main/docs/api.md#ironbirdredux). MIT licensed.
