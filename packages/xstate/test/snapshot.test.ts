import { isIronbirdError } from '@ironbird/core';
import { createTestTarget } from '@ironbird/testing';
import { describe, expect, it } from 'vitest';
import { timerApp } from './sample-app';

describe('@ironbird/xstate snapshots through the headless target', () => {
  it('saves a JSON-safe persisted snapshot and loads it into a replacement that later steps reach', async () => {
    const target = await createTestTarget({ headless: timerApp });
    try {
      await target.send('count.add', { by: 2 });
      const saved = await target.client.rpc<{ rev: number; snapshot: Record<string, unknown> }>('snapshotSave');
      expect(saved.snapshot).toMatchObject({ status: 'active', value: 'idle', context: { count: 2, rings: 0 } });
      // XState's persisted snapshot carries `output: undefined` and `error: undefined`; the strict
      // serializer omits them, as JSON does (M5 design §4).
      expect(saved.snapshot).not.toHaveProperty('output');
      expect(JSON.parse(JSON.stringify(saved.snapshot))).toEqual(saved.snapshot);
      await target.send('count.add', { by: 3 });
      await target.client.rpc('snapshotLoad', { snapshot: saved.snapshot });
      expect(await target.state()).toEqual({ value: 'idle', context: { count: 2, rings: 0 } });
      // dispatch reaches the replacement, and waitFor sees its change.
      const waiting = target.client.rpc<{ value: unknown }>('waitFor', { path: 'context.count', equals: 3, timeoutMs: 2_000 });
      await target.send('count.add', { by: 1 });
      expect((await waiting).value).toBe(3);
      // The replacement got the headless clock through actorOptions; 100 is the contract's ring delay.
      await target.send('timer.start');
      await target.advance(100);
      expect(await target.state('context.rings')).toBe(1);
    } finally {
      await target.dispose();
    }
  });

  it('fails INVALID_SNAPSHOT for a snapshot the schema rejects and keeps the live actor', async () => {
    const target = await createTestTarget({ headless: timerApp });
    try {
      await target.send('count.add', { by: 2 });
      const saved = await target.client.rpc<{ snapshot: Record<string, unknown> }>('snapshotSave');
      const error = await target.client.rpc('snapshotLoad', { snapshot: { ...saved.snapshot, context: { count: -1, rings: 0 } } }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(isIronbirdError(error) ? error.code : error).toBe('INVALID_SNAPSHOT');
      expect((error as { details: unknown }).details).toMatchObject({ path: 'context.count' });
      await target.send('count.add', { by: 1 });
      expect(await target.state('context.count')).toBe(3);
    } finally {
      await target.dispose();
    }
  });
});
