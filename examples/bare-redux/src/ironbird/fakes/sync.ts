import { defineFake } from '@ironbird/core';
import { z } from 'zod';
import type { SyncAck, SyncPort } from '../../sync/port';
import { FAST_ACK_MS, SLOW_ACK_MS, createSimulatedServer } from '../../sync/server';

interface Held {
  ack: SyncAck;
  resolve: (ack: SyncAck) => void;
}

export const fakeSync = defineFake('sync', {
  description: `Sync API: in auto mode acknowledges each save after ${SLOW_ACK_MS} ms or ${FAST_ACK_MS} ms, alternating, so two saves less than ${SLOW_ACK_MS - FAST_ACK_MS} ms apart are acknowledged newest first; in manual mode holds every acknowledgement until release`,
  controls: {
    setAcks: z
      .object({ mode: z.enum(['auto', 'manual']).describe('auto acknowledges on the alternating timer; manual holds each acknowledgement until release') })
      .describe('Choose how saves made after this call are acknowledged; acknowledgements already held stay held'),
    release: z
      .object({ order: z.enum(['oldest', 'newest']).describe('oldest delivers in save order; newest delivers the latest save first, out of order') })
      .describe('Deliver one held acknowledgement now; fails when none is held'),
  },
  create({ clock, record }) {
    // The same timing the app's own simulated server uses, on the injected clock.
    const server = createSimulatedServer(clock);
    const held: Held[] = [];
    let mode: 'auto' | 'manual' = 'auto';

    const acknowledged = (ack: SyncAck): SyncAck => {
      record('ack', ack);
      return ack;
    };

    const port: SyncPort = {
      save: (todo) => {
        record('save', todo);
        if (mode === 'auto') return server.save(todo).then(acknowledged);
        return new Promise((resolve) => {
          held.push({ ack: { id: todo.id, rev: todo.rev }, resolve });
        });
      },
    };

    return {
      port,
      controls: {
        setAcks: ({ mode: next }) => {
          mode = next;
        },
        release: ({ order }) => {
          const entry = order === 'oldest' ? held.shift() : held.pop();
          if (!entry) throw new Error('No acknowledgement is held: switch to manual with setAcks, then change a to-do');
          entry.resolve(acknowledged(entry.ack));
        },
      },
    };
  },
});
