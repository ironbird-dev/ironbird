import { defineFake } from '@ironbird/core';
import { z } from 'zod';
import type { ReaderEvent, ReaderPort } from '../../core/ports';

/** How long the fake reader takes to collect a card, on the injected clock. Unchanged since M0. */
export const READER_LATENCY_MS = 1_200;

export const fakeReader = defineFake('reader', {
  description: 'Card reader: collects a card 1,200 ms after a payment starts; emit injects reader events',
  controls: {
    emit: z
      .object({ event: z.enum(['connected', 'disconnected', 'cardPresented', 'declined']).describe('The reader event to deliver to the app') })
      .describe('Deliver a reader event now, such as a disconnect while a card is being collected'),
  },
  create({ clock, record }) {
    const listeners = new Set<(event: ReaderEvent) => void>();
    const port: ReaderPort = {
      collectPayment: (amountCents) => {
        record('collectPayment', { amountCents });
        return new Promise((resolve) => {
          clock.setTimeout(
            () => {
              record('collected', { amountCents });
              resolve({ token: `fake_${amountCents}` });
            },
            READER_LATENCY_MS,
            'reader.collectPayment',
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
        emit: ({ event }) => {
          record(event);
          for (const listener of listeners) listener({ type: event });
        },
      },
    };
  },
});
