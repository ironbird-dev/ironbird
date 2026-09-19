// The condition helpers moved into @ironbird/core in M1 so the bridge can evaluate `waitFor`
// inside the app. This module stays so @ironbird/cli's public exports are unchanged.
export { conditionHolds, deepEqual, parseCondition } from '@ironbird/core';
export type { Condition } from '@ironbird/core';
