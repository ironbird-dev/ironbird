/**
 * @format
 */

import { AppRegistry } from 'react-native';
import { App } from './App';
import { name as appName } from './app.json';

// exercise:begin-remove
// The bridge is dev-only. Metro replaces `__DEV__` with false in release builds and drops this
// branch, require() included, before it collects dependencies, so the bridge never reaches a
// release bundle; `ironbird verify-bundle` checks that (test/bundle.test.ts).
if (__DEV__) {
  require('./src/ironbird/device').startIronbird();
}
// exercise:end

AppRegistry.registerComponent(appName, () => App);
