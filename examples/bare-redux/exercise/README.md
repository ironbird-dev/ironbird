# Bare Redux to-dos

A bare React Native 0.87 app: a to-do list on Redux Toolkit. Every change is saved to a sync server, simulated in `src/sync/server.ts`, which acknowledges saves after 300 ms or 100 ms, alternating, so acknowledgements can arrive out of order. Each to-do shows "Saving…" until the server has acknowledged its latest revision.

## Layout

| Path | What it holds |
|---|---|
| `App.tsx` | The screen |
| `src/store/todos.ts` | The state, the action creators (`added`, `toggled`, `renamed`, and the sync actions), and the reducers |
| `src/store/middleware.ts` | Saves every change through the sync port and reports each acknowledgement |
| `src/store/store.ts` | `createAppStore(ports, options)` |
| `src/sync/port.ts`, `src/sync/server.ts` | The sync port and the simulated server |
| `src/app/instance.ts` | The store the screen renders |

## Run

```sh
npm install
cd ios && pod install && cd ..     # set LANG=en_US.UTF-8 if CocoaPods warns about the encoding
npm start                          # Metro, in its own terminal
npm run ios                        # build and launch; add `-- --udid <udid>` to pick a simulator
npm run typecheck
```
