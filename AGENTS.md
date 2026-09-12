# AGENTS.md

Instructions for coding agents and human contributors working in this repository. Read this file before changing code.

## Orientation

ironbird lets coding agents drive React Native app logic through typed commands, headlessly in Node or remotely in a running dev build. Read [docs/spec.md](docs/spec.md) for scope and non-goals, [docs/architecture.md](docs/architecture.md) for the design, and [docs/roadmap.md](docs/roadmap.md) for the current milestone and its exit criteria. Work that doesn't move the current milestone's exit criteria should be questioned before it is built.

## Repository layout (planned)

```text
packages/
  core/           @ironbird/core: runtime-agnostic, runs in Node and Hermes
  react-native/   @ironbird/react-native: in-app bridge and settle detection
  cli/            @ironbird/cli: daemon, CLI, scenarios, screenshots, MCP server
  ironbird/       ironbird: unscoped wrapper exposing the CLI binary for npx
  testing/        @ironbird/testing: scenario runner, model-based helpers (M4)
  xstate/         @ironbird/xstate: target adapter (M5)
  redux/          @ironbird/redux: target adapter (M5)
examples/
  checkout/       Expo app: cart → payment → receipt, fake card reader and API, planted race behind a flag
  bare-redux/     Bare React Native app using Redux (M5)
docs/
```

## Commands

These are the workspace scripts.

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Build all packages | `pnpm build` |
| Unit and integration tests | `pnpm test` |
| Device tests (macOS with a booted simulator) | `pnpm test:device` |
| Lint, including import boundaries | `pnpm lint` |
| Type check | `pnpm typecheck` |
| Run the example on iOS | `pnpm example:ios` |
| Add a release note | `pnpm changeset` |

Tooling: pnpm workspaces, TypeScript in strict mode, Vitest for packages, Jest with React Native Testing Library inside `examples/`, ESLint for import boundaries, and Changesets for releases. Vitest runs with `test.projects`: `unit` is the default and `device` holds `*.device.test.ts`.

## Hard rules

1. `@ironbird/core` imports only `zod`. No `react-native`, no `node:*` modules, no DOM or browser globals. It must run unmodified in Node and Hermes. Lint enforces this.
2. No arbitrary code execution anywhere. No `eval`, no `new Function`, and no protocol operation that runs caller-supplied code. Agents act only through declared commands and fake controls ([ADR-0001](docs/adr/0001-commands-only-agent-surface.md)).
3. The bridge stays dev-only. `startBridge` must no-op when `__DEV__` is false unless `allowInNonDevBuilds` is set, and the bridge marker must stay referenced in the `hello` message so `ironbird verify-bundle` can detect it after minification. The marker constant is defined in `@ironbird/react-native` and nowhere else: `@ironbird/core` ships in release bundles, so the string must not appear in it or in any other package.
4. Validate every payload where it is applied, including inside the app. Never trust the daemon.
5. Protocol changes update [docs/protocol.md](docs/protocol.md) in the same PR. Breaking changes bump `PROTOCOL_VERSION` and need an ADR.
6. Public API or CLI changes update [docs/api.md](docs/api.md) or [docs/cli.md](docs/cli.md) in the same PR and include a changeset.
7. New runtime dependencies in `core` or `react-native` need an ADR. New dependencies in `cli` need a one-line justification in the PR.
8. Errors that cross a package boundary are `IronbirdError` with a code from the protocol error table. No bare string throws.
9. Headless determinism is a feature. Library code and example app logic take time from the injected `Clock`, never from global `setTimeout`, `setInterval`, or `Date.now`. The bridge is library code too: it uses the `Clock` passed to `startBridge`, which defaults to the real clock. `requestAnimationFrame` is a rendering signal rather than a clock and may be used directly. Inside `@ironbird/core`, `clock.ts` and `scheduler.ts` are the only files that may use global timers or `Date.now`, and lint enforces that.

## Conventions

- Named exports only, except `ironbird.config.ts` and headless definition files, which use default exports.
- Public APIs, the protocol, and MCP tools take durations in milliseconds; only the CLI accepts `ms`, `s`, and `m` suffixes.
- CLI output is JSON when stdout isn't a TTY or `--json` is passed, and its shapes must match docs/cli.md.
- Tests live next to code as `*.test.ts`. Device tests are named `*.device.test.ts` and are excluded from `pnpm test`.
- Packages publish ESM and CommonJS builds with type declarations.

## Definition of done

- [ ] Tests at the right layer, per [docs/testing-strategy.md](docs/testing-strategy.md)
- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass
- [ ] Docs updated wherever behavior, API, CLI output, or protocol changed
- [ ] Changeset added for published packages
- [ ] PR description explains in plain language what changed, why, and what could break, written so a reviewer can check understanding and not only the diff
- [ ] For milestone work: which exit criterion this moves and how it was measured

## When unsure

Prefer the smallest change that satisfies the current milestone. If a task seems to require something listed under non-goals, stop and ask instead of building it. If the docs don't answer a design question, add it to the open questions table in docs/spec.md rather than deciding silently.
