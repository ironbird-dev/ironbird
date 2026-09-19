import { priceOf } from './catalog';
import type { ReaderEvent, ServerEvent } from './ports';

export interface CartItem {
  sku: string;
  name: string;
  qty: number;
  unitCents: number;
}

export type PaymentMethod = 'card' | 'saved';

export interface CheckoutState {
  cart: { items: CartItem[]; subtotalCents: number };
  payment: {
    status: 'idle' | 'collecting' | 'submitting' | 'awaitingServerEcho' | 'succeeded' | 'failed';
    method?: PaymentMethod;
    token?: string;
    paymentId?: string;
    error?: string;
  };
  order: { status: 'none' | 'confirmed' | 'completed'; orderId?: string; totalCents: number; paymentSucceeded: boolean };
  reader: { connected: boolean };
  ui: { motion: 'full' | 'reduced' };
}

export type CheckoutEvent =
  | { type: 'cart.addItem'; sku: string; qty: number }
  | { type: 'cart.clear' }
  | { type: 'payment.start'; method: PaymentMethod }
  | { type: 'reader.event'; event: ReaderEvent }
  | { type: 'reader.collected'; token: string }
  | { type: 'reader.failed'; reason: string }
  | { type: 'api.submitted'; paymentId: string }
  | { type: 'api.failed'; reason: string }
  | { type: 'server.event'; event: ServerEvent }
  | { type: 'server.timeout' }
  | { type: 'ui.setMotion'; motion: 'full' | 'reduced' };

export const SERVER_TIMEOUT_MS = 30_000;

export const initialState: CheckoutState = {
  cart: { items: [], subtotalCents: 0 },
  payment: { status: 'idle' },
  order: { status: 'none', totalCents: 0, paymentSucceeded: false },
  reader: { connected: true },
  ui: { motion: 'full' },
};

const IN_PROGRESS = new Set<CheckoutState['payment']['status']>(['collecting', 'submitting', 'awaitingServerEcho']);

function subtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.qty * item.unitCents, 0);
}

function fail(state: CheckoutState, error: string): CheckoutState {
  return { ...state, payment: { ...state.payment, status: 'failed', error } };
}

function complete(state: CheckoutState): CheckoutState {
  return {
    ...state,
    payment: { ...state.payment, status: 'succeeded' },
    order: { ...state.order, status: 'completed', paymentSucceeded: true },
  };
}

export function reduce(state: CheckoutState, event: CheckoutEvent, options: { plantRace: boolean }): CheckoutState {
  switch (event.type) {
    case 'cart.addItem': {
      if (IN_PROGRESS.has(state.payment.status)) throw new Error('Cart is locked while a payment is in progress');
      const price = priceOf(event.sku);
      if (!price) throw new Error(`Unknown SKU ${event.sku}`);
      const existing = state.cart.items.find((item) => item.sku === event.sku);
      const items = existing
        ? state.cart.items.map((item) => (item.sku === event.sku ? { ...item, qty: item.qty + event.qty } : item))
        : [...state.cart.items, { sku: event.sku, name: price.name, qty: event.qty, unitCents: price.unitCents }];
      return { ...state, cart: { items, subtotalCents: subtotal(items) } };
    }
    case 'cart.clear': {
      if (IN_PROGRESS.has(state.payment.status)) throw new Error('Cart is locked while a payment is in progress');
      return { ...state, cart: { items: [], subtotalCents: 0 } };
    }
    case 'payment.start': {
      if (state.cart.items.length === 0) throw new Error('Cart is empty');
      if (IN_PROGRESS.has(state.payment.status)) throw new Error('Payment already in progress');
      const order: CheckoutState['order'] = { status: 'none', totalCents: 0, paymentSucceeded: false };
      if (event.method === 'saved') return { ...state, order, payment: { status: 'submitting', method: 'saved', token: 'saved-card' } };
      return { ...state, order, payment: { status: 'collecting', method: 'card' } };
    }
    case 'reader.event': {
      switch (event.event.type) {
        case 'connected':
          return { ...state, reader: { connected: true } };
        case 'disconnected': {
          const next = { ...state, reader: { connected: false } };
          return state.payment.status === 'collecting' ? fail(next, 'Reader disconnected') : next;
        }
        case 'declined':
          return state.payment.status === 'collecting' ? fail(state, 'Card declined') : state;
        case 'cardPresented':
          return state;
      }
      return state;
    }
    case 'reader.collected':
      if (state.payment.status !== 'collecting') return state;
      return { ...state, payment: { ...state.payment, status: 'submitting', token: event.token } };
    case 'reader.failed':
      return state.payment.status === 'collecting' ? fail(state, event.reason) : state;
    case 'api.submitted':
      if (state.payment.status !== 'submitting') return state;
      return { ...state, payment: { ...state.payment, status: 'awaitingServerEcho', paymentId: event.paymentId } };
    case 'api.failed':
      return state.payment.status === 'submitting' ? fail(state, event.reason) : state;
    case 'server.timeout':
      return state.payment.status === 'awaitingServerEcho' ? fail(state, 'Server did not confirm within 30 s') : state;
    case 'server.event': {
      if (state.payment.status !== 'awaitingServerEcho' && state.payment.status !== 'succeeded') return state;
      const server = event.event;
      switch (server.type) {
        case 'order.confirmed': {
          if (state.order.status === 'completed') return state;
          const next = { ...state, order: { ...state.order, status: 'confirmed' as const, orderId: server.orderId, totalCents: server.totalCents } };
          return next.order.paymentSucceeded ? complete(next) : next;
        }
        case 'payment.succeeded': {
          if (state.order.status === 'completed') return state;
          if (options.plantRace) {
            // Planted bug: completes as soon as the server says the payment succeeded, even if
            // order.confirmed (which carries the total) hasn't arrived yet. The receipt then shows 0.
            return complete(state);
          }
          const next = { ...state, order: { ...state.order, paymentSucceeded: true } };
          return next.order.status === 'confirmed' ? complete(next) : next;
        }
        case 'payment.failed':
          return state.payment.status === 'awaitingServerEcho' ? fail(state, server.reason) : state;
      }
      return state;
    }
    case 'ui.setMotion':
      return state.ui.motion === event.motion ? state : { ...state, ui: { motion: event.motion } };
  }
}
