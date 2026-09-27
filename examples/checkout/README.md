# Checkout example

A cart, a card reader, and a payment API behind ports, with the reader and the API faked. Headlessly it runs in Node through `src/ironbird/headless.ts`; on a device it runs in Expo Go through `index.js`, which starts the ironbird bridge in dev builds.

## Run

Run `pnpm build` from the repository root once first: this example resolves `@ironbird/react-native` through `packages/react-native/dist`, which only exists after a build.

```sh
pnpm example:ios        # Expo Go on the booted iOS Simulator
pnpm example:android    # Expo Go on the running Android emulator
```

In another terminal, from this directory, `ironbird serve` starts the daemon; `ironbird status` lists the connected app once the bridge is up.

## Plant the race

The checkout core carries a planted ordering bug (docs/roadmap.md, M0): with it on, an early `payment.succeeded` completes the order before `order.confirmed` brings the total, so the receipt shows 0. Headlessly, the daemon reads `PLANT_RACE`:

```sh
PLANT_RACE=1 ironbird serve
```

On a device the flag is baked into the bundle, because Expo inlines `EXPO_PUBLIC_*` variables when Metro bundles. Restart Metro with the variable set and its cache cleared:

```sh
EXPO_PUBLIC_PLANT_RACE=1 npx expo start --ios --clear
```

With several simulators booted, `--ios` cannot tell them apart; start Metro without it and open the app on the simulator you mean by udid: `EXPO_PUBLIC_PLANT_RACE=1 npx expo start --clear`, then `xcrun simctl openurl <udid> exp://127.0.0.1:8081`.

Restart Metro the same way without the variable to unplant it. `ironbird fakes` lists the two fakes, `reader` and `api`, with their controls on either target.

## Scenarios

`ironbird/scenarios/` holds five scenarios: the saved-card happy path, the planted race (`race-success-before-confirmation.yaml`, the M2 gate scenario, which fails only with the race planted), a duplicated `payment.succeeded`, a missing server echo that times out, and a reader disconnect while collecting. The first three run on both targets; the last two declare `target: headless` because they need the manual clock or a settle that does not outrun the reader. With the daemon running:

```sh
ironbird scenario run ironbird/scenarios                 # every scenario, headless by default
ironbird scenario run ironbird/scenarios --target ios    # missing-echo fails with UNSUPPORTED at its clock step, and reader-disconnect fails at its first expect, because a remote settle finishes the collection first
```

On a remote target, `scenario run` does not reset between files, so the scenarios share the app's state: running the three both-target scenarios together on iOS makes later files see the earlier ones' cart quantities and totals accumulate, so they fail (reproduced with `duplicate-success` failing on an actual of 9000 and the race scenario on 13500). Run a both-target file one at a time against a freshly reloaded app, for example `xcrun simctl openurl <udid> exp://127.0.0.1:8081` after terminating Expo Go, or pressing `r` in Metro.

Each run writes its result, events, final state, and fake calls under `.ironbird/runs/`.

## Monorepo note

Metro resolves through pnpm's isolated node_modules with no extra configuration (Expo SDK 57).

Build scripts allowed for the app in `pnpm-workspace.yaml`: none.
