import { startBridge, type BridgeHandle } from '@ironbird/react-native';
import { appCore, clock, recorder, tracker } from '../core/instance';
import { toTarget } from './target';

/** Called from index.js inside `if (__DEV__)`. The default URL, ws://localhost:4568, reaches the daemon from the iOS Simulator directly and from an Android emulator through `adb reverse`, which `ironbird serve` sets up. */
export function startIronbird(): BridgeHandle {
  return startBridge({ target: toTarget(appCore), clock, tracker, recorder, appId: 'com.example.checkout', appName: 'Checkout' });
}
