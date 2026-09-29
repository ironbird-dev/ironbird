import { createEventRecorder, createManualClock, type EventRecorder } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { ReaderEvent } from '../../core/ports';
import { fakeReader } from './reader';

function boot(): { clock: ReturnType<typeof createManualClock>; recorder: EventRecorder; reader: ReturnType<typeof fakeReader.create>; events: ReaderEvent[] } {
  const clock = createManualClock();
  const recorder = createEventRecorder({ clock });
  const reader = fakeReader.create({ clock, recorder });
  const events: ReaderEvent[] = [];
  reader.port.onEvent((event) => events.push(event));
  return { clock, recorder, reader, events };
}

const names = (recorder: EventRecorder): string[] => recorder.since(0).events.map((event) => `${event.source}:${event.name}`);

describe('fake reader', () => {
  it('collects a card 1,200 ms after collectPayment and records both events', async () => {
    const { clock, recorder, reader } = boot();
    let token: string | undefined;
    void reader.port.collectPayment(4_500).then((result) => {
      token = result.token;
    });
    expect(clock.timers().map((timer) => timer.label)).toEqual(['reader.collectPayment']);
    await clock.advance(1_199);
    expect(token).toBeUndefined();
    await clock.advance(1);
    expect(token).toBe('fake_4500');
    expect(names(recorder)).toEqual(['reader:collectPayment', 'reader:collected']);
    expect(recorder.since(0).events[0]?.data).toEqual({ amountCents: 4_500 });
  });

  it('emit delivers reader events to listeners and records them under the fake name', async () => {
    const { recorder, reader, events } = boot();
    await reader.control('emit', { event: 'disconnected' });
    await reader.control('emit', { event: 'connected' });
    expect(events).toEqual([{ type: 'disconnected' }, { type: 'connected' }]);
    expect(names(recorder)).toEqual(['reader:disconnected', 'reader:connected']);
  });

  it('validates the control payload and the control name', async () => {
    const { reader } = boot();
    await expect(reader.control('emit', { event: 'exploded' })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'reader.emit' } });
    await expect(reader.control('emitt', { event: 'connected' })).rejects.toMatchObject({ code: 'UNKNOWN_CONTROL', details: { fake: 'reader', control: 'emitt', suggestions: ['emit'] } });
    expect(reader.controls.names()).toEqual(['emit']);
  });
});
