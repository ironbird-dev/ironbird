import { createEventRecorder, createManualClock, createTracker, type HeadlessApp } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { CheckoutState } from '../core/checkout';
import headless from './headless';

async function boot(env: Record<string, string> = {}): Promise<{ app: HeadlessApp; clock: ReturnType<typeof createManualClock>; tracker: ReturnType<typeof createTracker>; recorder: ReturnType<typeof createEventRecorder> }> {
  const clock = createManualClock({ now: Date.parse('2026-01-01T00:00:00.000Z') });
  const recorder = createEventRecorder({ clock });
  const tracker = createTracker({ clock });
  const app = await headless.create({ clock, recorder, tracker, env });
  return { app, clock, tracker, recorder };
}

const state = (app: HeadlessApp): CheckoutState => app.target.getState() as CheckoutState;

describe('checkout headless entry', () => {
  it('describes the three commands', async () => {
    const { app } = await boot();
    expect(app.target.commands.names()).toEqual(['cart.addItem', 'cart.clear', 'payment.start']);
  });

  it('completes cart → payment → receipt by advancing the manual clock through quiescence', async () => {
    const { app, clock, tracker, recorder } = await boot();
    await app.target.dispatch('cart.addItem', { sku: 'cut-45', qty: 1 });
    await app.target.dispatch('payment.start', { method: 'card' });

    let settle = await tracker.whenIdle({ mode: 'quiescent', timeoutMs: 1_000 });
    expect(settle).toMatchObject({ idle: false, quiescent: true, nextTimerInMs: 1_200 });
    expect(settle.pending.map((p) => p.label)).toEqual(['reader.collectPayment']);

    await clock.advance(1_200);
    settle = await tracker.whenIdle({ mode: 'quiescent', timeoutMs: 1_000 });
    expect(state(app).payment.status).toBe('submitting');
    expect(settle.pending.map((p) => p.label)).toEqual(['api.submitPayment']);

    await clock.advance(300);
    await tracker.whenIdle({ mode: 'quiescent', timeoutMs: 1_000 });
    expect(state(app).payment.status).toBe('awaitingServerEcho');
    expect(clock.timers().map((t) => t.label).sort()).toEqual(['api.serverEcho', 'payment.serverTimeout']);

    await clock.advance(500);
    settle = await tracker.whenIdle({ mode: 'quiescent', timeoutMs: 1_000 });
    expect(settle.idle).toBe(true);
    expect(state(app).order).toEqual({ status: 'completed', orderId: 'ord_1', totalCents: 4_500, paymentSucceeded: true });
    expect(recorder.since(0).events.map((e) => `${e.source}:${e.name}`)).toEqual([
      'analytics:payment_started',
      'reader:collectPayment',
      'reader:collected',
      'api:submitPayment',
      'api:order.confirmed',
      'api:payment.succeeded',
      'analytics:order_completed',
    ]);
  });

  it('honors PLANT_RACE and disposes cleanly', async () => {
    const { app, clock } = await boot({ PLANT_RACE: '1' });
    await app.target.dispatch('cart.addItem', { sku: 'cut-45', qty: 1 });
    await app.target.dispatch('payment.start', { method: 'saved' });
    await clock.advance(800);
    expect(state(app).order.status).toBe('completed');
    expect(state(app).order.totalCents).toBe(4_500);
    await app.dispose?.();
    expect(clock.timers()).toEqual([]);
  });
});
