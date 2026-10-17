# @ironbird/react-native

The in-app bridge for [ironbird](https://github.com/ironbird-dev/ironbird): a development build connects to the ironbird daemon over WebSocket, so the same typed commands that drive your app's logic headlessly drive the running app, with a screenshot after the UI settles. Pure JavaScript, no native code, and inert outside development builds.

```sh
npm install @ironbird/core @ironbird/react-native zod@^4.2
```

```ts
// src/ironbird/device.ts
import { startBridge } from '@ironbird/react-native';
import { clock, recorder, store, tracker } from '../instance';
import { toTarget } from './target';

export function startIronbird() {
  return startBridge({ target: toTarget(store), clock, tracker, recorder, appId: 'com.example.shop' });
}
```

```js
// index.js: keep the require inside the branch so release bundles drop the bridge
if (__DEV__) {
  require('./src/ironbird/device').startIronbird();
}
```

Then prove a release bundle is clean with `npx ironbird verify-bundle <bundle>`.

A bare React Native app needs one Metro setting so zod resolves to its CommonJS build, and an app running in Expo Go passes `reload: () => reloadAppAsync()` from `expo`; both are in the [API reference](https://github.com/ironbird-dev/ironbird/blob/main/docs/api.md#startbridge-p0).

- [Getting started](https://github.com/ironbird-dev/ironbird/blob/main/docs/guides/getting-started.md)
- [API reference](https://github.com/ironbird-dev/ironbird/blob/main/docs/api.md#ironbirdreact-native-p0-m1)

MIT licensed.
