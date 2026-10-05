import { reloadAppAsync } from 'expo';
import { DevSettings } from 'react-native';
import { startBridge, type BridgeHandle } from '@ironbird/react-native';
import { appCore, clock, fakes, recorder, tracker } from '../core/instance';
import { routeDevReloads } from './dev-reload';
import { toTarget } from './target';

/** Called from index.js inside `if (__DEV__)`. The default URL, ws://localhost:4568, reaches the daemon from the iOS Simulator directly and from an Android emulator through `adb reverse`, which `ironbird serve` sets up. The fakes make `fakeControl` and `fakeCalls` available on the connected app. `reload` is Expo's `reloadAppAsync`: React Native's `DevSettings.reload` leaves Expo Go without its native modules, so the app would never reconnect. For the same reason Fast Refresh's full reloads, which go through `DevSettings.reload`, are routed to `reloadAppAsync` too. */
export function startIronbird(): BridgeHandle {
  routeDevReloads(DevSettings, reloadAppAsync);
  return startBridge({ target: toTarget(appCore), clock, tracker, recorder, fakes, appId: 'com.example.checkout', appName: 'Checkout', reload: () => reloadAppAsync('ironbird reload') });
}
