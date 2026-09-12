import { markFakePort, type Clock, type EventRecorder } from '@ironbird/core';
import type { ApiPort, ServerEvent } from '../../core/ports';

export function createFakeApi(deps: { clock: Clock; recorder: EventRecorder; latencyMs?: number; echoDelayMs?: number }): { port: ApiPort } {
  const { clock, recorder, latencyMs = 300, echoDelayMs = 500 } = deps;
  const listeners = new Set<(event: ServerEvent) => void>();
  let counter = 0;
  const emit = (event: ServerEvent): void => {
    recorder.record('api', event.type, event);
    for (const listener of listeners) listener(event);
  };
  const port: ApiPort = markFakePort({
    submitPayment: ({ amountCents }) => {
      counter += 1;
      const paymentId = `pay_${counter}`;
      const orderId = `ord_${counter}`;
      recorder.record('api', 'submitPayment', { amountCents, paymentId });
      return new Promise((resolve) => {
        clock.setTimeout(
          () => {
            resolve({ paymentId });
            clock.setTimeout(
              () => {
                emit({ type: 'order.confirmed', orderId, totalCents: amountCents });
                emit({ type: 'payment.succeeded', paymentId });
              },
              echoDelayMs,
              'api.serverEcho',
            );
          },
          latencyMs,
          'api.submitPayment',
        );
      });
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return { port };
}
