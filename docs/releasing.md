# Releasing

| | |
|---|---|
| Status | Current for 0.1.0 |
| Last updated | 2026-10-04 |
| Related | [.github/workflows/release.yml](../.github/workflows/release.yml) · [roadmap.md](roadmap.md) (M5) · [M5 design](superpowers/specs/2026-10-04-m5-adapters-and-0.1-design.md) §9 |

## How a release happens

1. Every pull request that changes a published package adds a changeset (`pnpm changeset`), per AGENTS.md rule 6.
2. When changesets reach `main`, the Release workflow opens or updates the "Version packages" pull request, which applies them: versions, changelogs, and internal dependency ranges.
3. Merging that pull request publishes every bumped package over npm trusted publishing (OIDC, no token), pushes the tags, and creates the GitHub releases.

The published packages are `@ironbird/core`, `@ironbird/react-native`, `@ironbird/cli`, `ironbird`, `@ironbird/testing`, `@ironbird/redux`, and `@ironbird/xstate`. They form one fixed group in `.changeset/config.json`, so they always move to the same version together. `scripts/release/check-packs.mjs` packs each one and fails on a missing README or LICENSE, a missing ESM or CommonJS entry or declaration, shipped sources or tests, a `workspace:` range, an exact internal peer pin, or a `zod` peer other than `^4.2.0`. CI runs it on every commit; locally, `pnpm release:check` builds first. `--expect-version <version>` also checks every package's version and its internal dependencies.

## A package's first publish

A package that has never been published can't publish over OIDC: npm attaches a trusted publisher to an existing package, and one failed package stops `pnpm -r publish` before the packages after it, so the tags are never pushed. Before merging the Version packages pull request that introduces a package, publish its first version by hand from that pull request's branch, logged in to npm with 2FA:

```sh
gh pr checkout <Version packages pull request number>
pnpm install --frozen-lockfile && pnpm build
cd packages/<dir> && pnpm publish --access public --no-git-checks && cd ../..
npm trust github <package> --file release.yml --repo ironbird-dev/ironbird --allow-publish
```

Never publish from `main` before the Version packages pull request merges: `main` still carries the old version.

## 0.1.0

0.1.0 is prepared by the M5 pull request and published by the maintainer, by merging the Version packages pull request, after the human integration trial (M5 design D10 and §9). Every published package has a `minor` changeset, so the Version packages pull request moves all seven to 0.1.0, `@ironbird/testing`, `@ironbird/redux`, and `@ironbird/xstate` from 0.0.0.

Before merging the Version packages pull request:

- [ ] **First publishes.** For `@ironbird/redux`, `@ironbird/xstate`, and `@ironbird/testing` if it is still unpublished (`npm view @ironbird/testing version` fails with `E404`), publish the first version by hand from the Version packages pull request's branch, then run `npm trust github <package> --file release.yml --repo ironbird-dev/ironbird --allow-publish` (see above).
- [ ] **Pack contents.** On that branch, `pnpm build && node scripts/release/check-packs.mjs --expect-version 0.1.0` exits 0: ESM and CommonJS builds where they apply, type declarations, README and LICENSE, and no tests or sources that shouldn't ship.
- [ ] **Compatibility.** The `compat` job passes on the Version packages pull request.
- [ ] **Human trial.** The integration trial's result and elapsed time are recorded, in `RESULTS.md` of the trial's copy and in [docs/evals/m5-adapters-and-0.1.md](evals/m5-adapters-and-0.1.md).

The human trial is the go/no-go for 0.1.0: a developer other than the author wires ironbird into `examples/bare-redux/integration-exercise/`, a copy of `examples/bare-redux` without ironbird, using only the docs, in one day or less. `examples/bare-redux/eval/README.md` says how to prepare the participant's folder and score it. If 0.1.0 is released with the trial failed or skipped, roadmap M5's first criterion stays unticked with that outcome and the release date written next to it, and the evals record says so.
