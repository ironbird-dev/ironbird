import { describe, expect, it } from 'vitest';
import * as runner from './runner';

describe('the runner entry', () => {
  it('exports the headless target and the scenario engine, and nothing else', () => {
    expect(Object.keys(runner).sort()).toEqual(['createHeadlessTarget', 'loadScenarioFiles', 'parseScenario', 'runScenario']);
    for (const value of Object.values(runner)) expect(typeof value).toBe('function');
  });
});
