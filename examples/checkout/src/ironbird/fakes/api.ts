import { defineFake } from '@ironbird/core';
import { z } from 'zod';
import type { ApiPort, ServerEvent } from '../../core/ports';

/** Submission latency and echo delay on the injected clock. Unchanged since M0: the M1 harness numbers depend on them. */
export const API_LATENCY_MS = 300;
export const API_ECHO_DELAY_MS = 500;

interface Submission {
  paymentId: string;
  orderId: string;
  amountCents: number;
}

const missingFields = (event: string, fields: string[]): Error =>
  new Error(`No payment has been submitted yet, so ${event} needs ${fields.join(' and ')} in the payload`);

export const fakeApi = defineFake('api', {
  description: 'Payment API: resolves a submission after 300 ms and, in auto mode, echoes order.confirmed then payment.succeeded 500 ms later',
  controls: {
    emit: z
      .object({
        event: z.enum(['order.confirmed', 'payment.succeeded', 'payment.failed']).describe('The server event to deliver'),
        paymentId: z.string().optional().describe('Defaults to the most recent submitted payment'),
        orderId: z.string().optional().describe('Defaults to the order of the most recent submitted payment'),
        totalCents: z.number().int().min(0).optional().describe('Defaults to the amount of the most recent submitted payment'),
        reason: z.string().optional().describe('payment.failed only; defaults to "Declined by the server"'),
      })
      .describe('Deliver one server event now. Omitted ids and the total come from the most recent submitted payment; with none, the control fails and names the fields to pass'),
    setEcho: z
      .object({ mode: z.enum(['auto', 'manual']).describe('auto echoes order.confirmed then payment.succeeded 500 ms after a submission resolves; manual emits nothing on its own') })
      .describe('Turn the automatic server echo on or off for submissions that resolve after this call'),
  },
  create({ clock, record }) {
    const listeners = new Set<(event: ServerEvent) => void>();
    let counter = 0;
    let echo: 'auto' | 'manual' = 'auto';
    let last: Submission | undefined;

    const emit = (event: ServerEvent): void => {
      record(event.type, event);
      for (const listener of listeners) listener(event);
    };

    const port: ApiPort = {
      submitPayment: ({ amountCents }) => {
        counter += 1;
        const submitted: Submission = { paymentId: `pay_${counter}`, orderId: `ord_${counter}`, amountCents };
        last = submitted;
        record('submitPayment', { amountCents, paymentId: submitted.paymentId });
        return new Promise((resolve) => {
          clock.setTimeout(
            () => {
              resolve({ paymentId: submitted.paymentId });
              if (echo !== 'auto') return;
              clock.setTimeout(
                () => {
                  emit({ type: 'order.confirmed', orderId: submitted.orderId, totalCents: submitted.amountCents });
                  emit({ type: 'payment.succeeded', paymentId: submitted.paymentId });
                },
                API_ECHO_DELAY_MS,
                'api.serverEcho',
              );
            },
            API_LATENCY_MS,
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
    };

    return {
      port,
      controls: {
        setEcho: ({ mode }) => {
          echo = mode;
        },
        emit: (payload) => {
          switch (payload.event) {
            case 'order.confirmed': {
              const orderId = payload.orderId ?? last?.orderId;
              const totalCents = payload.totalCents ?? last?.amountCents;
              if (orderId === undefined || totalCents === undefined) {
                throw missingFields(payload.event, [...(orderId === undefined ? ['orderId'] : []), ...(totalCents === undefined ? ['totalCents'] : [])]);
              }
              emit({ type: 'order.confirmed', orderId, totalCents });
              return;
            }
            case 'payment.succeeded': {
              const paymentId = payload.paymentId ?? last?.paymentId;
              if (paymentId === undefined) throw missingFields(payload.event, ['paymentId']);
              emit({ type: 'payment.succeeded', paymentId });
              return;
            }
            case 'payment.failed':
              emit({ type: 'payment.failed', reason: payload.reason ?? 'Declined by the server' });
              return;
          }
        },
      },
    };
  },
});
