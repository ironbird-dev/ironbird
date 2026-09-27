import { startBridge, type BridgeHandle } from '@ironbird/react-native';
import { appCore, clock, fakes, recorder, tracker } from '../core/instance';
import { toTarget } from './target';

/** Called from index.js inside `if (__DEV__)`. The default URL, ws://localhost:4568, reaches the daemon from the iOS Simulator directly and from an Android emulator through `adb reverse`, which `ironbird serve` sets up. The fakes make `fakeControl` and `fakeCalls` available on the connected app. */
export function startIronbird(): BridgeHandle {
  return startBridge({ target: toTarget(appCore), clock, tracker, recorder, fakes, appId: 'com.example.checkout', appName: 'Checkout' });
}
