import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createManualClock } from './clock';
import { createEventRecorder } from './recorder';

describe('createEventRecorder', () => {
  it('records events with increasing seq and clock timestamps', () => {
    const clock = createManualClock({ now: 1_767_225_600_000 });
    const recorder = createEventRecorder({ clock });
    const first = recorder.record('analytics', 'payment_started', { method: 'card' });
    clock.setNow(1_767_225_600_500);
    const second = recorder.record('reader', 'disconnected');
    expect(first).toEqual({ seq: 1, t: 1_767_225_600_000, source: 'analytics', name: 'payment_started', data: { method: 'card' } });
    expect(second).toEqual({ seq: 2, t: 1_767_225_600_500, source: 'reader', name: 'disconnected' });
  });

  it('returns only events newer than since, with a cursor for the next call', () => {
    const recorder = createEventRecorder({ clock: createManualClock() });
    recorder.record('a', 'one');
    recorder.record('a', 'two');
    recorder.record('a', 'three');
    const page = recorder.since(1, 1);
    expect(page.events.map((e) => e.name)).toEqual(['two']);
    expect(page.nextSeq).toBe(2);
    expect(page.truncated).toBe(false);
    const rest = recorder.since(page.nextSeq);
    expect(rest.events.map((e) => e.name)).toEqual(['three']);
    expect(rest.nextSeq).toBe(3);
    expect(recorder.since(3)).toEqual({ events: [], nextSeq: 3, truncated: false });
  });

  it('bounds the buffer and reports truncation for cursors older than the eviction point', () => {
    const recorder = createEventRecorder({ clock: createManualClock(), limit: 3 });
    for (let i = 0; i < 5; i += 1) recorder.record('a', `e${i}`);
    const page = recorder.since(0);
    expect(page.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(page.truncated).toBe(true);
    expect(recorder.since(2).truncated).toBe(false);
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const recorder = createEventRecorder({ clock: createManualClock() });
    const seen: string[] = [];
    const off = recorder.subscribe((event) => seen.push(event.name));
    recorder.record('a', 'one');
    off();
    recorder.record('a', 'two');
    expect(seen).toEqual(['one']);
  });

  it('clears the buffer and the eviction point', () => {
    const recorder = createEventRecorder({ clock: createManualClock(), limit: 1 });
    recorder.record('a', 'one');
    recorder.record('a', 'two');
    recorder.clear();
    expect(recorder.since(0)).toEqual({ events: [], nextSeq: 2, truncated: false });
    expect(recorder.record('a', 'three').seq).toBe(3);
  });

  it('is inert when disabled', () => {
    const recorder = createEventRecorder({ clock: createManualClock(), enabled: false });
    const seen: unknown[] = [];
    recorder.subscribe((event) => seen.push(event));
    expect(recorder.record('a', 'one').seq).toBe(0);
    expect(recorder.since(0)).toEqual({ events: [], nextSeq: 0, truncated: false });
    expect(seen).toEqual([]);
  });

  it('lastSeq reports the latest seq and survives clear', () => {
    const recorder = createEventRecorder({ clock: createManualClock() });
    expect(recorder.lastSeq()).toBe(0);
    recorder.record('a', 'one');
    const second = recorder.record('a', 'two');
    expect(recorder.lastSeq()).toBe(second.seq);
    recorder.clear();
    // `clear` drops the buffer, not the numbering: a seq must never be handed out twice.
    expect(recorder.lastSeq()).toBe(second.seq);
    expect(recorder.record('a', 'three').seq).toBe(second.seq + 1);
    expect(recorder.lastSeq()).toBe(second.seq + 1);
  });

  it('property: seq strictly increases and since(n) never returns seq <= n', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 45 }), fc.integer({ min: 1, max: 20 }), (count, n, limit) => {
        const recorder = createEventRecorder({ clock: createManualClock(), limit });
        let last = 0;
        for (let i = 0; i < count; i += 1) {
          const event = recorder.record('s', `e${i}`);
          expect(event.seq).toBeGreaterThan(last);
          last = event.seq;
        }
        for (const event of recorder.since(n).events) expect(event.seq).toBeGreaterThan(n);
      }),
    );
  });
});
