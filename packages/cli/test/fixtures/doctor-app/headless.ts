import { defineHeadless } from '@ironbird/core';

// `ironbird doctor` loads this entry the way the daemon does, from packages/cli/node_modules, but
// must never boot it.
export default defineHeadless(() => {
  throw new Error('doctor booted the headless app');
});
