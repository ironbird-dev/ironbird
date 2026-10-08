import { startBridge, type BridgeHandle } from '@ironbird/react-native';
import { clock, fakes, recorder, store, tracker } from '../app/instance';
import { toTarget } from './target';

/**
 * Called from index.js inside `if (__DEV__)`, so release bundles never contain the bridge. The
 * default URL, ws://localhost:4568, reaches the daemon from the iOS Simulator directly. The sync
 * fake makes `ironbird fake sync ...` work against the running app, and React Native's own
 * `DevSettings.reload` serves `ironbird reload` in a bare app.
 */
export function startIronbird(): BridgeHandle {
  return startBridge({ target: toTarget(store), clock, tracker, recorder, fakes, appId: 'com.example.bareredux', appName: 'Bare Redux' });
}
