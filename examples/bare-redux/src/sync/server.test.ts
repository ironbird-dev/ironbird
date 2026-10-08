import { createManualClock } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { SyncAck } from './port';
import { FAST_ACK_MS, SLOW_ACK_MS, createSimulatedServer } from './server';

const todo = (rev: number) => ({ id: 't1', title: 'Buy milk', done: rev % 2 === 0, rev });

describe('the simulated sync server', () => {
  it('alternates a slow and a fast acknowledgement, so a quick second save is acknowledged first', async () => {
    const clock = createManualClock();
    const server = createSimulatedServer(clock);
    const acks: SyncAck[] = [];
    void server.save(todo(1)).then((ack) => acks.push(ack));
    void server.save(todo(2)).then((ack) => acks.push(ack));
    expect(clock.timers().map((timer) => timer.label)).toEqual(['sync.ack', 'sync.ack']);

    await clock.advance(FAST_ACK_MS);
    expect(acks).toEqual([{ id: 't1', rev: 2 }]);
    await clock.advance(SLOW_ACK_MS - FAST_ACK_MS);
    expect(acks).toEqual([
      { id: 't1', rev: 2 },
      { id: 't1', rev: 1 },
    ]);
  });

  it('keeps alternating: the third save is slow again', async () => {
    const clock = createManualClock();
    const server = createSimulatedServer(clock);
    const acks: number[] = [];
    for (const rev of [1, 2, 3]) void server.save(todo(rev)).then((ack) => acks.push(ack.rev));
    await clock.advance(FAST_ACK_MS);
    expect(acks).toEqual([2]);
    await clock.advance(SLOW_ACK_MS - FAST_ACK_MS);
    expect(acks).toEqual([2, 1, 3]);
  });
});
