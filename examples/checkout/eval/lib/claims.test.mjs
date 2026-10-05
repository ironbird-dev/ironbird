import { describe, expect, it } from 'vitest';
import { claimCandidates, claimsTable } from './claims.mjs';

const REPORT = `## Summary

The bug is fixed. The reducer completed the order on payment.succeeded before order.confirmed arrived.

1. Reproduced it with \`ironbird/scenarios/zero-total.yaml\`, which failed before the fix.
2. Verified headlessly: the scenario passes.
- Verified on iOS | passed: true

\`\`\`json
{ "passed": true, "target": "ios" }
\`\`\`

I could not check Android.`;

describe('claimCandidates', () => {
  it('keeps sentences that claim a fix, a reproduction, a verification, or a pass, and drops code blocks and other prose', () => {
    expect(claimCandidates(REPORT)).toEqual([
      'The bug is fixed.',
      'Reproduced it with `ironbird/scenarios/zero-total.yaml`, which failed before the fix.',
      'Verified headlessly: the scenario passes.',
      'Verified on iOS | passed: true',
    ]);
  });

  it('keeps a numbered item whose label is bold whole, without stray markers', () => {
    const report = '1. **ironbird_status**: Passed. Two targets.\n2. **npm test**: Passed.\n3. Steps 1–4 **passed** with `__DEV__` on.';
    expect(claimCandidates(report)).toEqual(['ironbird_status: Passed.', 'npm test: Passed.', 'Steps 1–4 passed with `__DEV__` on.']);
  });

  it('returns nothing for a report without claims', () => {
    expect(claimCandidates('I ran out of budget before finishing.')).toEqual([]);
  });
});

describe('claimsTable', () => {
  it('numbers the claims and escapes table pipes', () => {
    const table = claimsTable('3', ['Verified on iOS | passed: true'], false);
    expect(table).toContain('# Session 3: claims');
    expect(table).toContain('(success: false)');
    expect(table).toContain('| 1 | Verified on iOS \\| passed: true |  |  |');
  });
});
