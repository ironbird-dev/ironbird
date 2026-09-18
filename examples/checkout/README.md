# Checkout example

A cart, a card reader, and a payment API behind ports, with the reader and the API faked. Headlessly it runs in Node through `src/ironbird/headless.ts`; on a device it runs in Expo Go through `index.js`, which starts the ironbird bridge in dev builds.

## Run

Run `pnpm build` from the repository root once first: this example resolves `@ironbird/react-native` through `packages/react-native/dist`, which only exists after a build.

```sh
pnpm example:ios        # Expo Go on the booted iOS Simulator
pnpm example:android    # Expo Go on the running Android emulator
```

In another terminal, from this directory, `ironbird serve` starts the daemon; `ironbird status` lists the connected app once the bridge is up.

## Monorepo note

Metro resolves through pnpm's isolated node_modules with no extra configuration (Expo SDK 57).

Build scripts allowed for the app in `pnpm-workspace.yaml`: none.
