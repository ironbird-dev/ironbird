import { describe, expect, it } from 'vitest';
import { initialState, reduce, type CheckoutEvent, type CheckoutState } from './checkout';

const run = (events: CheckoutEvent[], plantRace = false): CheckoutState =>
  events.reduce((state, event) => reduce(state, event, { plantRace }), initialState);

const toAwaitingEcho: CheckoutEvent[] = [
  { type: 'cart.addItem', sku: 'cut-45', qty: 1 },
  { type: 'payment.start', method: 'card' },
  { type: 'reader.collected', token: 'tok' },
  { type: 'api.submitted', paymentId: 'pay_1' },
];

describe('cart', () => {
  it('adds priced items, merges quantities, and totals the subtotal', () => {
    const state = run([
      { type: 'cart.addItem', sku: 'cut-45', qty: 1 },
      { type: 'cart.addItem', sku: 'cut-45', qty: 2 },
      { type: 'cart.addItem', sku: 'shampoo-12', qty: 1 },
    ]);
    expect(state.cart.items).toEqual([
      { sku: 'cut-45', name: 'Haircut', qty: 3, unitCents: 4_500 },
      { sku: 'shampoo-12', name: 'Shampoo', qty: 1, unitCents: 1_200 },
    ]);
    expect(state.cart.subtotalCents).toBe(14_700);
  });

  it('rejects unknown SKUs and edits during payment', () => {
    expect(() => run([{ type: 'cart.addItem', sku: 'nope', qty: 1 }])).toThrow('Unknown SKU nope');
    expect(() => run([...toAwaitingEcho, { type: 'cart.clear' }])).toThrow('Cart is locked while a payment is in progress');
  });

  it('clears the cart', () => {
    expect(run([{ type: 'cart.addItem', sku: 'cut-45', qty: 1 }, { type: 'cart.clear' }]).cart).toEqual({ items: [], subtotalCents: 0 });
  });
});

describe('payment', () => {
  it('requires a non-empty cart and an idle payment', () => {
    expect(() => run([{ type: 'payment.start', method: 'card' }])).toThrow('Cart is empty');
    expect(() => run([...toAwaitingEcho, { type: 'payment.start', method: 'card' }])).toThrow('Payment already in progress');
  });

  it('collects with the reader for card and skips the reader for a saved card', () => {
    const card = run([{ type: 'cart.addItem', sku: 'cut-45', qty: 1 }, { type: 'payment.start', method: 'card' }]);
    expect(card.payment).toEqual({ status: 'collecting', method: 'card' });
    const saved = run([{ type: 'cart.addItem', sku: 'cut-45', qty: 1 }, { type: 'payment.start', method: 'saved' }]);
    expect(saved.payment).toEqual({ status: 'submitting', method: 'saved', token: 'saved-card' });
  });

  it('moves through collected and submitted to awaitingServerEcho', () => {
    const state = run(toAwaitingEcho);
    expect(state.payment).toEqual({ status: 'awaitingServerEcho', method: 'card', token: 'tok', paymentId: 'pay_1' });
    expect(state.order).toEqual({ status: 'none', totalCents: 0, paymentSucceeded: false });
  });

  it('fails on reader disconnect or decline while collecting, and ignores late reader results', () => {
    const disconnected = run([{ type: 'cart.addItem', sku: 'cut-45', qty: 1 }, { type: 'payment.start', method: 'card' }, { type: 'reader.event', event: { type: 'disconnected' } }]);
    expect(disconnected.payment).toEqual({ status: 'failed', method: 'card', error: 'Reader disconnected' });
    expect(disconnected.reader.connected).toBe(false);
    const late = reduce(disconnected, { type: 'reader.collected', token: 'tok' }, { plantRace: false });
    expect(late).toBe(disconnected);
    const declined = run([{ type: 'cart.addItem', sku: 'cut-45', qty: 1 }, { type: 'payment.start', method: 'card' }, { type: 'reader.event', event: { type: 'declined' } }]);
    expect(declined.payment.error).toBe('Card declined');
  });

  it('fails on api errors and on the server timeout, and allows a retry from failed', () => {
    const failed = run([...toAwaitingEcho, { type: 'server.timeout' }]);
    expect(failed.payment).toEqual({ status: 'failed', method: 'card', token: 'tok', paymentId: 'pay_1', error: 'Server did not confirm within 30 s' });
    const retried = reduce(failed, { type: 'payment.start', method: 'saved' }, { plantRace: false });
    expect(retried.payment.status).toBe('submitting');
    const apiFailed = run([...toAwaitingEcho.slice(0, 3), { type: 'api.failed', reason: 'network' }]);
    expect(apiFailed.payment.error).toBe('network');
  });
});

describe('order completion', () => {
  const confirmed: CheckoutEvent = { type: 'server.event', event: { type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 } };
  const succeeded: CheckoutEvent = { type: 'server.event', event: { type: 'payment.succeeded', paymentId: 'pay_1' } };

  it('completes only when both confirmation and success have arrived, in either order', () => {
    const inOrder = run([...toAwaitingEcho, confirmed, succeeded]);
    expect(inOrder.order).toEqual({ status: 'completed', orderId: 'ord_1', totalCents: 4_500, paymentSucceeded: true });
    expect(inOrder.payment.status).toBe('succeeded');
    const reversed = run([...toAwaitingEcho, succeeded, confirmed]);
    expect(reversed.order).toEqual(inOrder.order);
    expect(run([...toAwaitingEcho, succeeded]).order.status).toBe('none');
  });

  it('treats duplicate server events as idempotent', () => {
    const state = run([...toAwaitingEcho, confirmed, succeeded, succeeded, confirmed]);
    expect(state.order.totalCents).toBe(4_500);
    expect(state.order.status).toBe('completed');
  });

  it('fails the payment on payment.failed and ignores server events outside awaitingServerEcho', () => {
    const failed = run([...toAwaitingEcho, { type: 'server.event', event: { type: 'payment.failed', reason: 'insufficient funds' } }]);
    expect(failed.payment).toMatchObject({ status: 'failed', error: 'insufficient funds' });
    const idle = run([{ type: 'cart.addItem', sku: 'cut-45', qty: 1 }, succeeded]);
    expect(idle.order.status).toBe('none');
  });

  it('with the planted race, an early success completes the order with a zero total', () => {
    const buggy = run([...toAwaitingEcho, succeeded, confirmed], true);
    expect(buggy.order.status).toBe('completed');
    expect(buggy.order.totalCents).toBe(0);
    const healthy = run([...toAwaitingEcho, confirmed, succeeded], true);
    expect(healthy.order.totalCents).toBe(4_500);
  });
});
