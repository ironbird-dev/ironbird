---
"@ironbird/core": patch
---
`defineCommands`, and through it a fake's `create`, now checks every schema when it is called and throws `IronbirdError` with code `INVALID_CONFIG` and details `{ name, reason }` for a schema that isn't a Zod 4.2+ schema: one from `zod` 3 or `zod/v3`, one from `zod/mini`, or anything else. Before, such a schema validated payloads, and `describe()` failed with a bare `TypeError` the first time an agent listed the commands. The message points to docs/migrating-from-zod-3.md.
