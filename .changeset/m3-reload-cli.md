---
"@ironbird/cli": patch
---

New operation and command: `ironbird reload [--timeout <duration>]` loads the app's current code from a fresh start and prints `{ target, rev }`. The headless target re-bundles its entry (`createHeadlessTarget` takes `loadDefinition`, which `serve` passes). A failed reload leaves `HEADLESS_LOAD_FAILED` on every later operation, `reset` included, until a reload succeeds, and `reset` and `reload` run as one serialized lifecycle transition. A connected app reloads through its bridge's `reload` option or `DevSettings.reload()`, and the daemon waits up to `timeoutMs` (default 60 s) for it to reconnect on the same id. It fails with `AMBIGUOUS_TARGET` when another build of the same app is connected on the same platform. `MUTATING_OPS` includes `reload`, `createTargetRegistry().claim` takes a preferred id, and `startBridgeServer` takes a `replacementFor` hook that returns a `ReplacementTicket`.
