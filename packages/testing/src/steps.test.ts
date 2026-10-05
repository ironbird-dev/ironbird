import type { Description } from '@ironbird/core';
import * as fc from 'fast-check';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAction, planSteps, toTraceStep, type Action, type ModelStep } from './steps';
import { createTestTarget, type TestTarget } from './target';
import { counterApp } from './test-app';

let target: TestTarget;
let description: Description;

beforeAll(async () => {
  target = await createTestTarget({ headless: counterApp });
  description = await target.describe();
});

afterAll(async () => {
  await target.dispose();
});

function samples(steps: ModelStep[]): Action[] {
  const [first] = planSteps(steps, description);
  if (!first) throw new Error('planSteps returned nothing');
  return fc.sample(first.arbitrary, { seed: 1, numRuns: 30 });
}

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const BARE: Description = { app: { id: 'bare', platform: 'headless' }, commands: {}, fakes: {}, capabilities: ['settle', 'events', 'reset'] };

describe('planSteps', () => {
  it('treats a bare string as a command with a payload from its schema', () => {
    for (const action of samples(['count.inc'])) expect(action).toEqual({ kind: 'send', command: 'count.inc', payload: {} });
    for (const action of samples([{ command: 'count.add' }])) {
      expect(action).toMatchObject({ kind: 'send', command: 'count.add' });
      expect([1, 2, 3]).toContain((action as { payload: { by: number } }).payload.by);
    }
  });

  it("generates a control's payload from its schema", () => {
    for (const action of samples([{ fake: 'bell', control: 'strike' }])) {
      expect(action).toMatchObject({ kind: 'fake', fake: 'bell', control: 'strike' });
      expect([1, 2]).toContain((action as { payload: { times: number } }).payload.times);
    }
  });

  it('draws clock advances from 0 to maxMs', () => {
    const values = samples([{ clock: { maxMs: 5 } }]).map((action) => (action as { ms: number }).ms);
    expect(values.every((ms) => Number.isInteger(ms) && ms >= 0 && ms <= 5)).toBe(true);
  });

  it('picks from a payload list and uses an arbitrary as is', () => {
    const picked = samples([{ command: 'count.add', payload: [{ by: 1 }, { by: 3 }] }]).map((action) => (action as { payload: unknown }).payload);
    expect(picked.every((payload) => [1, 3].includes((payload as { by: number }).by))).toBe(true);
    for (const action of samples([{ command: 'count.add', payload: fc.constant({ by: 2 }) }])) expect(action).toMatchObject({ payload: { by: 2 } });
  });

  it('accepts an arbitrary from another copy of fast-check', () => {
    const commonjs = createRequire(import.meta.url)('fast-check') as typeof fc;
    const foreign = commonjs.constant({ by: 2 });
    expect(foreign instanceof fc.Arbitrary).toBe(false);
    for (const action of samples([{ command: 'count.add', payload: foreign }])) expect(action).toMatchObject({ payload: { by: 2 } });
  });

  it('weights each step, 1 by default', () => {
    expect(planSteps(['count.inc', { clock: { maxMs: 5 }, weight: 3 }], description).map((planned) => planned.weight)).toEqual([1, 3]);
  });

  it.each<[string, ModelStep[], Record<string, unknown>]>([
    ['an unknown command', ['count.inx'], { code: 'UNKNOWN_COMMAND', details: { name: 'count.inx', suggestions: expect.arrayContaining(['count.inc']) } }],
    ['an unknown fake', [{ fake: 'bel', control: 'strike' }], { code: 'UNKNOWN_FAKE', details: { fake: 'bel', available: ['bell'], suggestions: expect.arrayContaining(['bell']) } }],
    ['an unknown control', [{ fake: 'bell', control: 'strik' }], { code: 'UNKNOWN_CONTROL', details: { fake: 'bell', control: 'strik', suggestions: expect.arrayContaining(['strike']) } }],
    ['a negative clock bound', [{ clock: { maxMs: -1 } }], { code: 'INVALID_PAYLOAD', details: { name: 'modelTest', issues: [{ path: ['steps', 0, 'clock', 'maxMs'] }] } }],
    ['an empty payload list', [{ command: 'count.inc', payload: [] }], { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['steps', 0, 'payload'] }] } }],
    ['a payload that is neither a list nor an arbitrary', [{ command: 'count.inc', payload: { by: 1 } as unknown as unknown[] }], { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['steps', 0, 'payload'] }] } }],
    ['a fractional weight', [{ command: 'count.inc', weight: 0.5 }], { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['steps', 0, 'weight'] }] } }],
    ['no steps', [], { code: 'INVALID_PAYLOAD', details: { issues: [{ path: ['steps'] }] } }],
  ])('rejects %s', (_label, steps, expected) => {
    expect(thrownBy(() => planSteps(steps, description))).toMatchObject(expected);
  });

  it('refuses a fake step on a target without fakes and a clock step on a target without a clock', () => {
    expect(thrownBy(() => planSteps([{ fake: 'bell', control: 'strike' }], BARE))).toMatchObject({ code: 'UNSUPPORTED', details: { op: 'fakeControl' } });
    expect(thrownBy(() => planSteps([{ clock: { maxMs: 5 } }], BARE))).toMatchObject({ code: 'UNSUPPORTED', details: { op: 'clockAdvance' } });
  });
});

describe('applyAction and toTraceStep', () => {
  it('runs each kind of step and writes it as a scenario step', async () => {
    await target.reset();
    const actions: Action[] = [
      { kind: 'send', command: 'count.inc', payload: {} },
      { kind: 'fake', fake: 'bell', control: 'strike', payload: { times: 1 } },
      { kind: 'clock', ms: 100 },
    ];
    for (const action of actions) await applyAction(target, action);
    expect(await target.state()).toEqual({ count: 1, rings: 1 });
    expect(actions.map(toTraceStep)).toEqual([{ send: 'count.inc', payload: {} }, { fake: 'bell', control: 'strike', payload: { times: 1 } }, { clock: 100 }]);
  });
});
