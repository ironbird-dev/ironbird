import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The spec §8 check that the subpath this package depends on loads in both module systems. It
// reads packages/cli/dist, so run `pnpm --filter @ironbird/cli build` first.
const requireFromHere = createRequire(import.meta.url);
const EXPORTS = ['createHeadlessTarget', 'loadScenarioFiles', 'parseScenario', 'runScenario'];

describe('@ironbird/cli/runner', () => {
  it('loads with require', () => {
    const runner = requireFromHere('@ironbird/cli/runner') as Record<string, unknown>;
    for (const name of EXPORTS) expect(typeof runner[name], name).toBe('function');
  });

  it('loads with import', async () => {
    const runner = (await import('@ironbird/cli/runner')) as Record<string, unknown>;
    for (const name of EXPORTS) expect(typeof runner[name], name).toBe('function');
  });
});
