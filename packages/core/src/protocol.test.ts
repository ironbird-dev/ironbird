import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Capability, Description } from './protocol';

describe('protocol types', () => {
  it('names reload as a capability a description can declare', () => {
    expectTypeOf<'reload'>().toExtend<Capability>();
    const description: Description = { app: { id: 'a', platform: 'ios' }, commands: {}, fakes: {}, capabilities: ['settle', 'events', 'reload'] };
    expect(description.capabilities).toContain('reload');
  });
});
