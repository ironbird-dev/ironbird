import { createManualClock } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import { createAppCore } from './app';
import type { ApiPort, ReaderEvent, ReaderPort, ServerEvent } from './ports';

interface Harness {
  app: ReturnType<typeof createAppCore>;
  clock: ReturnType<typeof createManualClock>;
  tracked: string[];
  emitServer: (event: ServerEvent) => void;
  emitReader: (event: ReaderEvent) => void;
  reader: { resolve: (token: string) => void; reject: (reason: string) => void; calls: number[] };
  api: { resolve: (paymentId: string) => void; reject: (reason: string) => void; calls: Array<{ token: string; amountCents: number }> };
}

function harness(options: { plantRace?: boolean } = {}): Harness {
  const clock = createManualClock();
  const tracked: string[] = [];
  const serverListeners = new Set<(event: ServerEvent) => void>();
  const readerListeners = new Set<(event: ReaderEvent) => void>();
  let readerResolve: ((v: { token: string }) => void) | undefined;
  let readerReject: ((e: Error) => void) | undefined;
  let apiResolve: ((v: { paymentId: string }) => void) | undefined;
  let apiReject: ((e: Error) => void) | undefined;
  const readerCalls: number[] = [];
  const apiCalls: Array<{ token: string; amountCents: number }> = [];
  const reader: ReaderPort = {
    collectPayment: (amountCents) => {
      readerCalls.push(amountCents);
      return new Promise((resolve, reject) => {
        readerResolve = resolve;
        readerReject = reject;
      });
    },
    onEvent: (listener) => {
      readerListeners.add(listener);
      return () => readerListeners.delete(listener);
    },
  };
  const api: ApiPort = {
    submitPayment: (input) => {
      apiCalls.push(input);
      return new Promise((resolve, reject) => {
        apiResolve = resolve;
        apiReject = reject;
      });
    },
    onEvent: (listener) => {
      serverListeners.add(listener);
      return () => serverListeners.delete(listener);
    },
  };
  const app = createAppCore({ reader, api, analytics: { track: (name) => tracked.push(name) }, clock }, options);
  return {
    app,
    clock,
    tracked,
    emitServer: (event) => serverListeners.forEach((l) => l(event)),
    emitReader: (event) => readerListeners.forEach((l) => l(event)),
    reader: { resolve: (token) => readerResolve?.({ token }), reject: (reason) => readerReject?.(new Error(reason)), calls: readerCalls },
    api: { resolve: (paymentId) => apiResolve?.({ paymentId }), reject: (reason) => apiReject?.(new Error(reason)), calls: apiCalls },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createAppCore', () => {
  it('runs the happy path: reader, api, then server echo completes the order', async () => {
    const h = harness();
    const revs: string[] = [];
    h.app.subscribe(() => revs.push(h.app.getSnapshot().payment.status));
    h.app.send({ type: 'cart.addItem', sku: 'cut-45', qty: 1 });
    h.app.send({ type: 'payment.start', method: 'card' });
    expect(h.reader.calls).toEqual([4_500]);
    h.reader.resolve('tok');
    await flush();
    expect(h.app.getSnapshot().payment.status).toBe('submitting');
    expect(h.api.calls).toEqual([{ token: 'tok', amountCents: 4_500 }]);
    h.api.resolve('pay_1');
    await flush();
    expect(h.app.getSnapshot().payment.status).toBe('awaitingServerEcho');
    expect(h.clock.timers().map((t) => t.label)).toEqual(['payment.serverTimeout']);
    h.emitServer({ type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 });
    h.emitServer({ type: 'payment.succeeded', paymentId: 'pay_1' });
    expect(h.app.getSnapshot().order).toEqual({ status: 'completed', orderId: 'ord_1', totalCents: 4_500, paymentSucceeded: true });
    expect(h.clock.timers()).toEqual([]);
    expect(h.tracked).toEqual(['payment_started', 'order_completed']);
    expect(revs).toEqual(['idle', 'collecting', 'submitting', 'awaitingServerEcho', 'awaitingServerEcho', 'succeeded']);
  });

  it('skips the reader for a saved card', () => {
    const h = harness();
    h.app.send({ type: 'cart.addItem', sku: 'beard-20', qty: 2 });
    h.app.send({ type: 'payment.start', method: 'saved' });
    expect(h.reader.calls).toEqual([]);
    expect(h.api.calls).toEqual([{ token: 'saved-card', amountCents: 4_000 }]);
  });

  it('fails the payment when the server never echoes within 30 s of manual time', async () => {
    const h = harness();
    h.app.send({ type: 'cart.addItem', sku: 'cut-45', qty: 1 });
    h.app.send({ type: 'payment.start', method: 'saved' });
    h.api.resolve('pay_1');
    await flush();
    await h.clock.advance(29_999);
    expect(h.app.getSnapshot().payment.status).toBe('awaitingServerEcho');
    await h.clock.advance(1);
    expect(h.app.getSnapshot().payment).toMatchObject({ status: 'failed', error: 'Server did not confirm within 30 s' });
    expect(h.tracked).toEqual(['payment_started', 'payment_failed']);
  });

  it('turns port rejections into failures and reader disconnects into failed payments', async () => {
    const h = harness();
    h.app.send({ type: 'cart.addItem', sku: 'cut-45', qty: 1 });
    h.app.send({ type: 'payment.start', method: 'card' });
    h.reader.reject('Reader timed out');
    await flush();
    expect(h.app.getSnapshot().payment).toMatchObject({ status: 'failed', error: 'Reader timed out' });

    h.app.send({ type: 'payment.start', method: 'card' });
    h.emitReader({ type: 'disconnected' });
    expect(h.app.getSnapshot().payment).toMatchObject({ status: 'failed', error: 'Reader disconnected' });
    h.reader.resolve('late');
    await flush();
    expect(h.app.getSnapshot().payment.status).toBe('failed');
  });

  it('propagates reducer errors to the caller without changing state', () => {
    const h = harness();
    expect(() => h.app.send({ type: 'payment.start', method: 'card' })).toThrow('Cart is empty');
    expect(h.app.getSnapshot().payment.status).toBe('idle');
  });

  it('reproduces the planted race when the server echoes success before confirmation', async () => {
    const h = harness({ plantRace: true });
    h.app.send({ type: 'cart.addItem', sku: 'cut-45', qty: 1 });
    h.app.send({ type: 'payment.start', method: 'saved' });
    h.api.resolve('pay_1');
    await flush();
    h.emitServer({ type: 'payment.succeeded', paymentId: 'pay_1' });
    h.emitServer({ type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 });
    expect(h.app.getSnapshot().order).toMatchObject({ status: 'completed', totalCents: 0 });
  });

  it('stops listening and clears timers on dispose', async () => {
    const h = harness();
    h.app.send({ type: 'cart.addItem', sku: 'cut-45', qty: 1 });
    h.app.send({ type: 'payment.start', method: 'saved' });
    h.api.resolve('pay_1');
    await flush();
    h.app.dispose();
    expect(h.clock.timers()).toEqual([]);
    h.emitServer({ type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 });
    expect(h.app.getSnapshot().order.status).toBe('none');
  });
});
