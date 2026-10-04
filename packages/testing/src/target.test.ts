import type { Description, StepResult } from '@ironbird/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestTarget, type TestTarget, type TestTargetOptions } from './target';
import { counterApp, type CounterState } from './test-app';

let target: TestTarget | undefined;

afterEach(async () => {
  await target?.dispose();
  target = undefined;
});

async function boot(options: Partial<TestTargetOptions> = {}): Promise<TestTarget> {
  target = await createTestTarget({ headless: counterApp, ...options });
  return target;
}

describe('createTestTarget', () => {
  it('serves the DaemonClient interface in process', async () => {
    const { client } = await boot();
    expect(client.url).toBe('in-process:headless');
    const described = await client.call<Description>('describe');
    expect(described.target).toBe('headless');
    expect(described.result.app).toEqual({ id: 'test', platform: 'headless' });
    expect(Object.keys(described.result.commands).sort()).toEqual(['count.add', 'count.fail', 'count.inc']);
    const step = await client.rpc<StepResult>('dispatch', { name: 'count.inc', payload: {} });
    expect(step.state).toEqual({ count: 1, rings: 0 });
    expect(await client.call('getState', { path: 'count' }, 'headless')).toMatchObject({ target: 'headless', result: { value: 1 } });
  });

  it("propagates the target's errors", async () => {
    const { client } = await boot();
    await expect(client.rpc('dispatch', { name: 'count.nope' })).rejects.toMatchObject({ name: 'IronbirdError', code: 'UNKNOWN_COMMAND' });
    await expect(client.rpc('dispatch', { name: 'count.fail' })).rejects.toMatchObject({ code: 'DISPATCH_FAILED', details: { name: 'count.fail' } });
  });

  it('has no event stream', async () => {
    const { client } = await boot();
    await expect(client.stream({ signal: new AbortController().signal, onMessage: () => {} })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      details: { op: 'stream', target: 'headless' },
    });
  });

  it('answers only to the headless target id', async () => {
    const { client } = await boot();
    await expect(client.rpc('describe', {}, 'ios')).rejects.toMatchObject({ code: 'NO_TARGET', details: { available: ['headless'] } });
  });

  it('drives commands, fakes, and the clock through the convenience methods', async () => {
    const t = await boot();
    expect((await t.send('count.inc')).state).toEqual({ count: 1, rings: 0 });
    await t.fake('bell', 'strike', { times: 2 });
    const advanced = await t.advance(100);
    expect(advanced.now).toBe(100);
    expect(advanced.state).toEqual({ count: 1, rings: 2 });
    expect(await t.state<number>('count')).toBe(1);
    expect(await t.state<CounterState>()).toEqual({ count: 1, rings: 2 });
    expect(Object.keys((await t.describe()).fakes)).toEqual(['bell']);
  });

  it('reset boots a fresh app and a fresh clock', async () => {
    const t = await boot();
    await t.send('count.inc');
    await t.advance(50);
    await t.reset();
    expect(await t.state()).toEqual({ count: 0, rings: 0 });
    expect((await t.advance(0)).now).toBe(0);
  });

  it('passes appId, env, and clockStart to the app', async () => {
    const t = await boot({ appId: 'com.example.counter', env: { BUG: '1' }, clockStart: '2026-01-01T00:00:00.000Z' });
    expect((await t.describe()).app.id).toBe('com.example.counter');
    expect((await t.advance(0)).now).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    for (let i = 0; i < 3; i += 1) await t.send('count.inc');
    expect(await t.state('count')).toBe(3);
  });

  it('never reads process.env', async () => {
    process.env['BUG'] = '1';
    try {
      const t = await boot();
      for (let i = 0; i < 3; i += 1) await t.send('count.inc');
      expect(await t.state('count')).toBe(2);
    } finally {
      delete process.env['BUG'];
    }
  });

  it('fails every call after dispose', async () => {
    const t = await boot();
    await t.dispose();
    await expect(t.send('count.inc')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
