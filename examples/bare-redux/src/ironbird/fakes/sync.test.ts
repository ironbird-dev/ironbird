import { createEventRecorder, createManualClock, type EventRecorder } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { SyncAck } from '../../sync/port';
import { fakeSync } from './sync';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function boot() {
  const clock = createManualClock();
  const recorder = createEventRecorder({ clock });
  const sync = fakeSync.create({ clock, recorder });
  const acks: SyncAck[] = [];
  const save = (rev: number): void => {
    void sync.port.save({ id: 't1', title: 'Buy milk', done: rev % 2 === 0, rev }).then((ack) => acks.push(ack));
  };
  return { clock, recorder, sync, acks, save };
}

const names = (recorder: EventRecorder): string[] => recorder.since(0).events.map((event) => `${event.source}:${event.name}`);

describe('fake sync', () => {
  it('acknowledges on the alternating timer in auto mode and records saves and acknowledgements', async () => {
    const { clock, recorder, acks, save } = boot();
    save(1);
    save(2);
    await clock.advance(100);
    expect(acks).toEqual([{ id: 't1', rev: 2 }]);
    await clock.advance(200);
    expect(acks).toEqual([
      { id: 't1', rev: 2 },
      { id: 't1', rev: 1 },
    ]);
    expect(names(recorder)).toEqual(['sync:save', 'sync:save', 'sync:ack', 'sync:ack']);
    expect(recorder.since(0).events[2]?.data).toEqual({ id: 't1', rev: 2 });
  });

  it('holds acknowledgements in manual mode and releases them oldest or newest first', async () => {
    const { clock, sync, acks, save } = boot();
    await sync.control('setAcks', { mode: 'manual' });
    save(1);
    save(2);
    save(3);
    await clock.advance(1_000);
    expect(acks).toEqual([]);
    expect(clock.timers()).toEqual([]);

    await sync.control('release', { order: 'newest' });
    await sync.control('release', { order: 'oldest' });
    await sync.control('release', { order: 'oldest' });
    await flush();
    expect(acks.map((ack) => ack.rev)).toEqual([3, 1, 2]);
  });

  it('keeps held acknowledgements held after switching back to auto', async () => {
    const { clock, sync, acks, save } = boot();
    await sync.control('setAcks', { mode: 'manual' });
    save(1);
    await sync.control('setAcks', { mode: 'auto' });
    save(2);
    await clock.advance(300);
    expect(acks.map((ack) => ack.rev)).toEqual([2]);
    await sync.control('release', { order: 'oldest' });
    await flush();
    expect(acks.map((ack) => ack.rev)).toEqual([2, 1]);
  });

  it('fails release with DISPATCH_FAILED when nothing is held', async () => {
    const { sync } = boot();
    await expect(sync.control('release', { order: 'oldest' })).rejects.toMatchObject({
      code: 'DISPATCH_FAILED',
      details: { name: 'sync.release', message: expect.stringContaining('No acknowledgement is held') },
    });
  });

  it('validates control payloads and declares setAcks then release', async () => {
    const { sync } = boot();
    await expect(sync.control('release', { order: 'random' })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'sync.release' } });
    await expect(sync.control('setAcks', { mode: 'sometimes' })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'sync.setAcks' } });
    expect(sync.controls.names()).toEqual(['setAcks', 'release']);
  });
});
