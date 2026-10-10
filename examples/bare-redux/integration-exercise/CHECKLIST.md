# Checklist

Run each check from the root of your copy, after `npm install`. A check passes only as written.

1. **The daemon loads the headless entry.** In one terminal run `npx ironbird serve`. In another, `npx ironbird status` exits 0 and its `targets` include `{ "id": "headless", "appId": "com.example.bareredux" }`.
2. **The commands are declared.** `npx ironbird commands` exits 0 and lists exactly `todos.add`, `todos.rename`, and `todos.toggle`.
3. **The acceptance scenario passes headlessly.** With the daemon running, `npx ironbird scenario run acceptance.yaml` exits 0.
4. **The bridge is in development builds.** The code that calls `startBridge` runs only when `__DEV__` is true, and

   ```sh
   mkdir -p build
   npx react-native bundle --platform ios --dev true --entry-file index.js --bundle-output build/dev.jsbundle
   npx ironbird verify-bundle build/dev.jsbundle
   ```

   exits 1: the bridge marker is found.
5. **The bridge is not in release builds.**

   ```sh
   npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output build/release.jsbundle
   npx ironbird verify-bundle build/release.jsbundle
   ```

   exits 0.
