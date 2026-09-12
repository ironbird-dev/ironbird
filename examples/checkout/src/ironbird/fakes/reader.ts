import { markFakePort, type Clock, type EventRecorder } from '@ironbird/core';
import type { ReaderEvent, ReaderPort } from '../../core/ports';

export function createFakeReader(deps: { clock: Clock; recorder: EventRecorder; latencyMs?: number }): { port: ReaderPort } {
  const { clock, recorder, latencyMs = 1_200 } = deps;
  const listeners = new Set<(event: ReaderEvent) => void>();
  const port: ReaderPort = markFakePort({
    collectPayment: (amountCents) => {
      recorder.record('reader', 'collectPayment', { amountCents });
      return new Promise((resolve) => {
        clock.setTimeout(
          () => {
            recorder.record('reader', 'collected', { amountCents });
            resolve({ token: `fake_${amountCents}` });
          },
          latencyMs,
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
  });
  return { port };
}
