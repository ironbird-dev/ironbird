# Integration exercise: add ironbird to this app

This folder is a bare React Native app whose logic lives in a Redux Toolkit store. It doesn't use ironbird yet. Your task is to wire ironbird into it, using only the ironbird documentation, so that a coding agent can drive the app's logic through typed commands: headlessly in Node, and in a development build.

Write your start time in RESULTS.md before you begin, and your end time when every check in CHECKLIST.md passes or when you stop. The target is one working day or less.

## Rules

- Use only the ironbird documentation: the README and the files under `docs/` in the ironbird repository (or the copy you were given), and the README of each `@ironbird/*` package. Don't read `examples/` in the ironbird repository, and don't ask the ironbird author for help. Note every place where the documentation wasn't enough in RESULTS.md.
- Keep the app working: don't change what it does, and `npm run typecheck` must still pass.
- Work inside this folder, and put build output under `build/`.

## Install

ironbird 0.1.0 is in `vendor/` as package tarballs. From this folder:

```sh
npm install ./vendor/ironbird-core-0.1.0.tgz ./vendor/ironbird-react-native-0.1.0.tgz ./vendor/ironbird-redux-0.1.0.tgz
npm install --save-dev ./vendor/ironbird-cli-0.1.0.tgz
```

Once 0.1.0 is on npm, `npm install @ironbird/core @ironbird/react-native @ironbird/redux` and `npm install --save-dev @ironbird/cli` do the same.

ironbird also needs `zod` 4.2 or later, which this app doesn't list yet:

```sh
npm install zod@^4.2
```

Start with the getting-started guide, `docs/guides/getting-started.md`: it covers installing and configuring ironbird in a React Native app, bare React Native included.

## What to build

1. **Commands.** Declare the commands `acceptance.yaml` sends, with Zod schemas for their payloads, mapped onto what the app's store already does.
2. **Fakes.** Declare the fakes and controls `acceptance.yaml` drives. Each one stands in for a port, a dependency on the outside world that the app already has, so a scenario can script it.
3. **A headless entry and `ironbird.config.ts`.** `npx ironbird serve` must load the app's logic in Node, with the fakes in place of the real ports.
4. **The bridge.** Start the ironbird bridge in development builds, and only there.
5. **Clean release builds.** A release bundle must not contain the bridge.

`acceptance.yaml` is the scenario that must pass. Don't change it; the scorer runs its own copy. It needs:

<!-- contract:start (written by examples/bare-redux/eval/render-task.mjs from acceptance.yaml; do not edit by hand) -->

### Commands

| Command | Payload in `acceptance.yaml` |
|---|---|
| `todos.add` | `{"title":"Buy milk"}` |
| `todos.toggle` | `{"id":"t1"}` |

### Fakes

| Fake | Control | Payload in `acceptance.yaml` |
|---|---|---|
| `sync` | `release` | `{"order":"newest"}` |
| `sync` | `setAcks` | `{"mode":"manual"}` |

### State the scenario checks

| Path | Condition |
|---|---|
| `sync.inFlight` | `{"equals":2}` |
| `todos.items.0.rev` | `{"equals":2}` |
| `todos.items.0.syncedRev` | `{"equals":2}` |

The scenario doesn't advance the clock.
<!-- contract:end -->

## Done

You are done when every check in CHECKLIST.md passes. Run them yourself; the scorer runs the same commands.
