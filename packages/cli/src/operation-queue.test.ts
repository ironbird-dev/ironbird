import { isIronbirdError } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { createOperationQueue } from './operation-queue';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const failure = async (promise: Promise<unknown>): Promise<{ code: string; message: string; details: unknown }> => {
  const error = await promise.catch((caught: unknown) => caught);
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return { code: error.code, message: error.message, details: error.details };
};

describe('createOperationQueue', () => {
  it('runs queued actions one at a time in arrival order', async () => {
    const queue = createOperationQueue('t');
    const order: string[] = [];
    let release: () => void = () => {};
    const first = queue.enqueue('dispatch', () => new Promise<void>((resolve) => (release = () => (order.push('first'), resolve()))));
    const second = queue.enqueue('dispatch', async () => {
      order.push('second');
    });
    await tick();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('abandon rejects everything waiting and in flight with the cause, bumps the epoch, and frees the queue', async () => {
    const queue = createOperationQueue('ios');
    const stuck = queue.enqueue('dispatch', () => queue.raceAbandon('dispatch', new Promise<never>(() => {})));
    const waiting = queue.enqueue('fakeControl', async () => 'never');
    await tick();
    expect(queue.epoch).toBe(0);
    queue.abandon('disconnected');
    expect(queue.epoch).toBe(1);
    expect(await failure(stuck)).toEqual({ code: 'TARGET_DISCONNECTED', message: 'Target was disconnected before dispatch completed', details: { target: 'ios', op: 'dispatch' } });
    expect(await failure(waiting)).toMatchObject({ code: 'TARGET_DISCONNECTED', details: { target: 'ios', op: 'fakeControl' } });
    expect(await queue.enqueue('dispatch', async () => 'runs again')).toBe('runs again');
    expect(queue.abandoned('settle').message).toBe('Target was disconnected before settle completed');
  });

  it('an action enqueued before an abandon but started after it is rejected without running', async () => {
    const queue = createOperationQueue('headless');
    let ran = false;
    let release: () => void = () => {};
    const blocker = queue.enqueue('dispatch', () => new Promise<void>((resolve) => (release = resolve)));
    const late = queue.enqueue('dispatch', async () => {
      ran = true;
    });
    await tick();
    queue.abandon('reset');
    release();
    await blocker.catch(() => undefined);
    expect(await failure(late)).toMatchObject({ code: 'TARGET_DISCONNECTED', message: 'Target was reset before dispatch completed' });
    expect(ran).toBe(false);
  });

  it('raceAbandon lets a promise that wins on its own through unchanged', async () => {
    const queue = createOperationQueue('t');
    expect(await queue.raceAbandon('settle', Promise.resolve(42))).toBe(42);
    await expect(queue.raceAbandon('settle', Promise.reject(new Error('own failure')))).rejects.toThrow('own failure');
  });
});
