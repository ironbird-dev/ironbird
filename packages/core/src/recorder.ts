import type { Clock } from './clock';
import type { RecordedEvent } from './protocol';
import { messageOf } from './errors';
import { scheduler } from './scheduler';

export interface EventRecorder {
  record(source: string, name: string, data?: unknown): RecordedEvent;
  since(seq?: number, limit?: number): { events: RecordedEvent[]; nextSeq: number; truncated: boolean };
  /** The seq of the most recently recorded event, or 0 before the first one. Survives `clear`. */
  lastSeq(): number;
  subscribe(listener: (event: RecordedEvent) => void): () => void;
  clear(): void;
}

export function createEventRecorder(options: { clock?: Clock; limit?: number; enabled?: boolean } = {}): EventRecorder {
  const { clock, limit = 10_000, enabled = true } = options;
  const now = (): number => (clock ? clock.now() : scheduler.now());
  const buffer: RecordedEvent[] = [];
  const listeners = new Set<(event: RecordedEvent) => void>();
  let lastSeq = 0;
  let evictedThrough = 0;

  return {
    record(source, name, data) {
      const base = { t: now(), source, name };
      const payload = data === undefined ? base : { ...base, data };
      if (!enabled) return { seq: 0, ...payload };
      lastSeq += 1;
      const event: RecordedEvent = { seq: lastSeq, ...payload };
      buffer.push(event);
      if (buffer.length > limit) {
        const dropped = buffer.shift();
        if (dropped) evictedThrough = dropped.seq;
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.warn(`ironbird: an event subscriber threw and was skipped: ${messageOf(error)}`);
        }
      }
      return event;
    },
    since(seq = 0, limit = Number.POSITIVE_INFINITY) {
      const events = buffer.filter((event) => event.seq > seq).slice(0, limit);
      const last = events[events.length - 1];
      return {
        events,
        nextSeq: last ? last.seq : Math.max(seq, lastSeq),
        truncated: seq < evictedThrough,
      };
    },
    lastSeq() {
      return lastSeq;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      buffer.length = 0;
      evictedThrough = 0;
    },
  };
}
