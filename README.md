# ironbird

Ground-test React Native apps for AI coding agents.

> **Status: M0 implemented.** This repository holds the spec, architecture, and roadmap. No packages are published yet, and every API shown here is a draft. M0 (headless loop) is implemented; see [docs/roadmap.md](docs/roadmap.md) for what's next.

Repository: [github.com/ironbird-dev/ironbird](https://github.com/ironbird-dev/ironbird) · npm: [`@ironbird`](https://www.npmjs.com/org/ironbird) and `ironbird`

In aerospace, an *iron bird* is the ground rig where an aircraft's hydraulics, flight controls, and avionics are wired together and exercised before first flight, with some components real and others simulated. ironbird does the same for React Native apps. A coding agent drives your app's logic through typed commands, with real or fake dependencies, and gets state back in milliseconds. When it needs to see pixels, the same commands drive your dev build on a simulator.

## Why

Coding agents verify mobile changes by tapping through a simulator and reading accessibility trees or screenshots. Each check takes minutes, fails for reasons unrelated to the change, and shows the agent pixels rather than the state it needs. The bugs that hurt production apps most, such as events arriving out of order, duplicate server events, timeouts, and hardware disconnects, are nearly impossible to reproduce that way.

Tools like [agent-device](https://github.com/callstack/agent-device), [agent-react-devtools](https://github.com/callstackincubator/agent-react-devtools), and Maestro work on the running app from the outside. ironbird adds the missing inner loop: your business logic running headlessly in Node, addressable by commands, with a controllable clock and scriptable fakes. It is designed to sit alongside those tools, not replace them.

## Two modes, one protocol

| Mode | Where app logic runs | What the agent gets back | Typical step |
|---|---|---|---|
| Headless | Inside the ironbird daemon, in Node | State, recorded events, pending effects | Milliseconds |
| Remote | Your dev build on a simulator, emulator, or device | State, events, and a screenshot taken after the UI settles | About a second |

Commands, scenario files, and agent workflows work the same against either mode.

## A quick tour (draft API)

Declare what an agent is allowed to do:

```ts
// src/ironbird/commands.ts
import { z } from 'zod';
import { defineCommands } from '@ironbird/core';

export const commands = defineCommands({
  'cart.addItem': z
    .object({ sku: z.string(), qty: z.number().int().positive() })
    .describe('Add an item to the current cart'),
  'payment.start': z
    .object({ method: z.enum(['card', 'saved']) })
    .describe('Start payment for the current cart'),
});
```

Adapt your store or state machine once and use it in both modes:

```ts
// src/ironbird/target.ts
import { createTarget } from '@ironbird/core';
import { commands } from './commands';
import type { AppCore } from '../core';

export const toTarget = (app: AppCore) =>
  createTarget({
    commands,
    dispatch: ({ name, payload }) => app.send({ type: name, ...payload }),
    getState: () => app.getSnapshot(),
    subscribe: (listener) => app.subscribe(listener),
  });
```

Headless mode: the daemon loads this file in Node, with fake ports and a manual clock.

```ts
// src/ironbird/headless.ts
import { defineHeadless } from '@ironbird/core';
import { createAppCore } from '../core';
import { fakeApi, fakeReader } from './fakes';
import { toTarget } from './target';

export default defineHeadless(({ clock, recorder, tracker }) => {
  const reader = fakeReader.create({ clock, recorder });
  const api = fakeApi.create({ clock, recorder });
  const app = createAppCore({
    reader: tracker.wrap(reader.port, 'reader'),
    api: tracker.wrap(api.port, 'api'),
    clock,
  });
  return { target: toTarget(app), fakes: [reader, api] };
});
```

Remote mode: your dev build connects out to the daemon. The bridge is dev-only and verifiably absent from release bundles.

```ts
// index.js
if (__DEV__) {
  require('./src/ironbird/device').startIronbird(); // calls startBridge() from @ironbird/react-native
}
```

An agent session:

```sh
ironbird serve &                                        # daemon with the headless target; it runs in the foreground
ironbird commands                                       # names, descriptions, JSON Schemas
ironbird send cart.addItem '{"sku":"cut-45","qty":1}'
ironbird send payment.start '{"method":"card"}'
ironbird fake reader emit '{"event":"disconnected"}'    # inject a failure mid-payment
ironbird clock advance 30s
ironbird state payment
ironbird step payment.start '{"method":"card"}' --target ios   # dev build: state + screenshot
```

## Packages

| Package | Runs in | Purpose | Priority |
|---|---|---|---|
| `@ironbird/core` | Node and React Native | Commands, targets, fakes, clocks, effect tracking, event recording, protocol types | P0 |
| `@ironbird/react-native` | Your dev build | Bridge to the daemon, settle detection | P0 |
| `@ironbird/cli` | Node 22+ | `ironbird` binary: daemon, commands, scenarios, screenshots, MCP server | P0 (MCP is P1) |
| `ironbird` | Node 22+ | Thin wrapper that exposes the same binary, so `npx ironbird` works without a local install | P0 |
| `@ironbird/testing` | Vitest or Jest | Scenario runner and model-based testing helpers | P1 |
| `@ironbird/xstate`, `@ironbird/redux` | Node and React Native | Target adapters for common state containers | P1 |

## What ironbird is not

It is not a UI automation tool, a state management library, or a way to run arbitrary code inside your app. The bridge never ships in release builds, and the parts of `@ironbird/core` that can, the clock, tracker, and recorder, are switched off outside dev builds. See [non-goals](docs/spec.md#non-goals).

## Documentation

| Document | Read it for |
|---|---|
| [docs/spec.md](docs/spec.md) | Problem, goals, requirements, success metrics, open questions |
| [docs/architecture.md](docs/architecture.md) | Components, data flow, settle detection, security model |
| [docs/protocol.md](docs/protocol.md) | Wire protocol v1: operations, messages, error codes |
| [docs/api.md](docs/api.md) | TypeScript API for each package |
| [docs/cli.md](docs/cli.md) | CLI commands, scenario file format, MCP tools |
| [docs/testing-strategy.md](docs/testing-strategy.md) | How ironbird itself is tested and how its reliability is measured |
| [docs/roadmap.md](docs/roadmap.md) | Milestones M0–M5 with exit criteria |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [AGENTS.md](AGENTS.md) | Rules and conventions for contributors, human or agent |

## License

To be decided before the first npm publish at the end of M0 (open question Q7 in the spec).
