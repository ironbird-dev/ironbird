# Migrating from Zod 3

| | |
|---|---|
| Applies to | ironbird 0.1 and later |
| Last updated | 2026-10-04 |
| Related | [api.md](api.md) (`defineCommands`, `defineFake`) · [ADR-0004](adr/0004-zod-4-schemas.md) · [spec.md](spec.md) Q8 |

ironbird describes every command and fake control to agents as JSON Schema, and it gets that JSON Schema from each schema's own `toJSONSchema` method, which Zod added in 4.2. So ironbird needs the `zod` package at 4.2 or later: `zod` is a peer dependency of `@ironbird/core`, `@ironbird/redux`, `@ironbird/xstate`, and `@ironbird/testing`, with the range `^4.2.0`. Zod 3 is not supported (spec Q8, closed in M5).

An app still on Zod 3 doesn't have to migrate all its schemas first. Zod 4 ships the Zod 3 API at the subpath `zod/v3`, so the old schemas keep working while the schemas you give ironbird use Zod 4.

## Steps

1. Install Zod 4:

   ```sh
   npm install zod@^4.2
   ```

2. Point the schemas you haven't migrated at the Zod 3 API that Zod 4 carries. Only the import changes:

   ```ts
   // before
   import { z } from 'zod';
   // after, for a schema still written against Zod 3
   import { z } from 'zod/v3';
   ```

   Zod's own guide covers moving each schema to Zod 4 later: <https://zod.dev/v4/changelog>.

3. Write the schemas you give ironbird, in `defineCommands` and in `defineFake`'s `controls`, against Zod 4, imported from `zod` or `zod/v4`:

   ```ts
   import { z } from 'zod';
   import { defineCommands } from '@ironbird/core';

   export const commands = defineCommands({
     'cart.addItem': z.object({ sku: z.string(), qty: z.number().int().positive() }).describe('Add an item to the cart'),
   });
   ```

## What doesn't work

- **A Zod 3 schema in `defineCommands` or in a fake's `controls`.** TypeScript rejects it with `TS2740`: the Zod 3 object lacks `toJSONSchema` and the other Zod 4 members. Without type checking, `defineCommands`, or the fake's `create`, throws `IronbirdError` with code `INVALID_CONFIG`, details `{ name, reason }`, and a message that names the command, says what is wrong with its schema, and points to this page; a headless entry that throws it fails to load with `HEADLESS_LOAD_FAILED` carrying that message.
- **`zod/mini` schemas.** They have no `toJSONSchema` method, so they fail the same way.
- **`zod` 3.25.x.** It offers a `zod/v4` subpath, but the package's own version, 3.25, doesn't satisfy ironbird's `^4.2.0` peer range, so package managers report the peer dependency as unmet (npm stops with `ERESOLVE`). Install `zod@^4.2` instead.
- **Nesting across versions.** A `zod/v3` schema can't be used inside a Zod 4 schema, or the other way round.

## Sharing a shape between old and new schemas

When a command's payload has the same shape as a schema that is still on Zod 3, write the Zod 4 schema next to it and let TypeScript check that the two infer the same type:

```ts
import { z as z3 } from 'zod/v3';
import { z } from 'zod';

export const legacyItem = z3.object({ sku: z3.string(), qty: z3.number().int() });
export const addItem = z.object({ sku: z.string(), qty: z.number().int() });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Fails to compile when the two shapes drift apart.
export const sameShape: Same<z3.infer<typeof legacyItem>, z.infer<typeof addItem>> = true;
```
