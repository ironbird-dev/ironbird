# Integration exercise: add ironbird to a bare React Native app

This folder is a bare React Native 0.87 app: a to-do list on Redux Toolkit whose changes are saved to a simulated sync server. It has no ironbird in it. Your task is to add ironbird using **only the ironbird documentation you were given**: the README and the `docs/` pages. Don't read ironbird's source code, its tests, or the examples in its repository.

Write your start time in RESULTS.md before you begin, and your end time when every check in CHECKLIST.md passes or when you stop.

## Setup

1. Copy this folder somewhere outside the ironbird repository and run `npm install` in the copy.
2. Install the ironbird packages and Zod 4. Until 0.1.0 is on npm, install them from the tarballs you were given (the maintainer makes them with `node scripts/pack-packages.mjs <dir> core react-native redux cli` in the ironbird repository):

       npm install <dir>/ironbird-core-*.tgz <dir>/ironbird-react-native-*.tgz <dir>/ironbird-redux-*.tgz zod@^4.2.0
       npm install --save-dev <dir>/ironbird-cli-*.tgz

   Once 0.1.0 is published, `npm install @ironbird/core @ironbird/react-native @ironbird/redux zod` and `npm install --save-dev @ironbird/cli` do the same.

## What to build

- An ironbird config for the app id `com.example.bareredux`, with a headless entry, so `npx ironbird serve` runs the app in Node without a simulator.
- Three commands, served through the Redux adapter, each dispatching the app's existing action:

  | Command | Payload | Dispatches |
  |---|---|---|
  | `todos.add` | `{ title }`, a non-empty string | `added` |
  | `todos.toggle` | `{ id }`, such as `t1` | `toggled` |
  | `todos.rename` | `{ id, title }` | `renamed` |

- The target's state is the store's root state, not a projection: the acceptance scenario reads `todos.items` and `sync.inFlight`.
- In the headless entry the simulated sync server runs on ironbird's clock, so the scenario's `clock` step decides when saves are acknowledged.
- The in-app bridge, started in development builds only, so the app can be driven on a simulator and release bundles don't contain it.

You may add files and restructure as you see fit, but don't change what the app does.

## Done when

Every check in CHECKLIST.md passes. Running the app on a simulator is optional and isn't scored.
