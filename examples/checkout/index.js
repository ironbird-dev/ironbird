import { registerRootComponent } from 'expo';
import App from './App';

// The bridge is dev-only. Keeping the require inside this branch is what lets Metro drop the
// module from production exports; `ironbird verify-bundle` proves it. EXPO_PUBLIC_FORCE_BRIDGE
// is the deliberate "broken build" switch that check is measured against: Expo inlines it at
// export time, so `EXPO_PUBLIC_FORCE_BRIDGE=1 expo export` ships the bridge on purpose.
if (__DEV__ || process.env.EXPO_PUBLIC_FORCE_BRIDGE === '1') {
  require('./src/ironbird/device').startIronbird();
}

registerRootComponent(App);
