import type { Clock, TimerId } from '@ironbird/core';
import { SERVER_TIMEOUT_MS, initialState, reduce, type CheckoutEvent, type CheckoutState } from './checkout';
import type { AnalyticsPort, ApiPort, ReaderPort } from './ports';

export interface AppPorts {
  reader: ReaderPort;
  api: ApiPort;
  analytics: AnalyticsPort;
  clock: Clock;
}

export interface AppCore {
  send(event: CheckoutEvent): void;
  getSnapshot(): CheckoutState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createAppCore(ports: AppPorts, options: { plantRace?: boolean } = {}): AppCore {
  const plantRace = options.plantRace ?? false;
  let state = initialState;
  let disposed = false;
  let serverTimeout: TimerId | undefined;
  const listeners = new Set<() => void>();

  const clearServerTimeout = (): void => {
    if (serverTimeout !== undefined) ports.clock.clearTimeout(serverTimeout);
    serverTimeout = undefined;
  };

  const runEffects = (previous: CheckoutState, next: CheckoutState, event: CheckoutEvent): void => {
    const entered = (status: CheckoutState['payment']['status']): boolean => previous.payment.status !== status && next.payment.status === status;

    if (event.type === 'payment.start') ports.analytics.track('payment_started', { method: event.method });

    if (entered('collecting')) {
      ports.reader.collectPayment(next.cart.subtotalCents).then(
        ({ token }) => send({ type: 'reader.collected', token }),
        (error: unknown) => send({ type: 'reader.failed', reason: messageOf(error) }),
      );
    }
    if (entered('submitting') && next.payment.token !== undefined) {
      ports.api.submitPayment({ token: next.payment.token, amountCents: next.cart.subtotalCents }).then(
        ({ paymentId }) => send({ type: 'api.submitted', paymentId }),
        (error: unknown) => send({ type: 'api.failed', reason: messageOf(error) }),
      );
    }
    if (entered('awaitingServerEcho')) {
      serverTimeout = ports.clock.setTimeout(() => send({ type: 'server.timeout' }), SERVER_TIMEOUT_MS, 'payment.serverTimeout');
    } else if (previous.payment.status === 'awaitingServerEcho' && next.payment.status !== 'awaitingServerEcho') {
      clearServerTimeout();
    }
    if (entered('succeeded')) ports.analytics.track('order_completed', { orderId: next.order.orderId, totalCents: next.order.totalCents });
    if (entered('failed')) ports.analytics.track('payment_failed', { error: next.payment.error });
  };

  const send = (event: CheckoutEvent): void => {
    if (disposed) return;
    const previous = state;
    const next = reduce(previous, event, { plantRace });
    if (next === previous) return;
    state = next;
    for (const listener of listeners) listener();
    runEffects(previous, next, event);
  };

  const unsubscribeApi = ports.api.onEvent((event) => send({ type: 'server.event', event }));
  const unsubscribeReader = ports.reader.onEvent((event) => send({ type: 'reader.event', event }));

  return {
    send,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      clearServerTimeout();
      unsubscribeApi();
      unsubscribeReader();
      listeners.clear();
    },
  };
}
