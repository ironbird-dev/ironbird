import { createManualClock, createTracker, type ManualClock } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { settle, type SettleDeps } from './settle';

function harness(): SettleDeps & { clock: ManualClock; flushFrames(): number; frames: Array<() => void> } {
  const clock = createManualClock();
  const tracker = createTracker({ clock });
  const frames: Array<() => void> = [];
  return {
    clock,
    tracker,
    frames,
    requestFrame: (callback) => {
      frames.push(callback);
    },
    flushFrames() {
      const pending = frames.splice(0);
      for (const frame of pending) frame();
      return pending.length;
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('settle', () => {
  it('yields a macrotask, waits the requested frames, and reports idle', async () => {
    const h = harness();
    const result = settle(h, { frames: 2, timeoutMs: 5_000 });
    // The macrotask yield is a zero-delay timer on the clock; nothing happens until it fires.
    expect(h.frames).toHaveLength(0);
    await h.clock.advance(0);
    expect(h.flushFrames()).toBe(1);
    await tick();
    expect(h.flushFrames()).toBe(1);
    await expect(result).resolves.toEqual({ idle: true, quiescent: false, waitedMs: 0, pending: [] });
    expect(h.clock.timers()).toEqual([]);
  });

  it('reports the pending items when the timeout elapses', async () => {
    const h = harness();
    void h.tracker.track(new Promise(() => {}), 'api.load');
    const result = settle(h, { frames: 2, timeoutMs: 100 });
    await h.clock.advance(0);
    for (let elapsed = 0; elapsed < 100; elapsed += 16) await h.clock.advance(16);
    const settled = await result;
    expect(settled.idle).toBe(false);
    expect(settled.waitedMs).toBeGreaterThanOrEqual(100);
    expect(settled.pending.map((item) => item.label)).toEqual(['api.load']);
    expect(h.frames).toHaveLength(0);
    expect(h.clock.timers()).toEqual([]);
  });

  it('keeps waiting when an effect starts during the frame wait, then settles once it ends', async () => {
    const h = harness();
    let finish: () => void = () => {};
    const result = settle(h, { frames: 1, timeoutMs: 5_000 });
    await h.clock.advance(0);
    expect(h.frames).toHaveLength(1);
    void h.tracker.track(new Promise<void>((resolve) => (finish = resolve)), 'reader.collect');
    h.flushFrames();
    await tick();
    // Pending again, so no frame is requested; the loop is waiting on a change or a 16 ms tick.
    expect(h.frames).toHaveLength(0);
    finish();
    await tick();
    await tick();
    expect(h.flushFrames()).toBe(1);
    const settled = await result;
    expect(settled.idle).toBe(true);
    expect(settled.pending).toEqual([]);
    expect(h.clock.timers()).toEqual([]);
  });

  it('gives up on frames that never arrive once the timeout elapses', async () => {
    const h = harness();
    const result = settle(h, { frames: 2, timeoutMs: 50 });
    await h.clock.advance(0);
    expect(h.frames).toHaveLength(1);
    await h.clock.advance(50);
    const settled = await result;
    expect(settled).toMatchObject({ idle: false, pending: [] });
    expect(settled.waitedMs).toBeGreaterThanOrEqual(50);
    expect(h.clock.timers()).toEqual([]);
  });
});
