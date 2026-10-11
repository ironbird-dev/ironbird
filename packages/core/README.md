# @ironbird/core

Commands, targets, fakes, clocks, effect tracking, and event recording for [ironbird](https://github.com/ironbird-dev/ironbird), which lets coding agents drive a React Native app's logic through typed commands, headlessly in Node or in a running development build.

```sh
npm install @ironbird/core zod@^4.2
```

It runs unmodified in Node and Hermes and depends on nothing but `zod` 4.2 or later, a peer dependency. Apps on Zod 3: [migrating from Zod 3](https://github.com/ironbird-dev/ironbird/blob/main/docs/migrating-from-zod-3.md).

```ts
import { z } from 'zod';
import { createTarget, defineCommands } from '@ironbird/core';

export const commands = defineCommands({
  'counter.add': z.object({ by: z.number().int() }).describe('Add to the counter'),
});

let count = 0;
const listeners = new Set<() => void>();

export const target = createTarget({
  commands,
  dispatch: ({ payload }) => {
    count += payload.by;
    for (const listener of listeners) listener();
  },
  getState: () => ({ count }),
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
});
```

For a Redux store or an XState actor, `@ironbird/redux` and `@ironbird/xstate` build the target for you.

- [Getting started](https://github.com/ironbird-dev/ironbird/blob/main/docs/guides/getting-started.md)
- [API reference](https://github.com/ironbird-dev/ironbird/blob/main/docs/api.md#ironbirdcore)

MIT licensed.
