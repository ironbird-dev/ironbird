import { createEventRecorder, createManualClock, type EventRecorder } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '../../core/ports';
import { fakeApi } from './api';

function boot(): { clock: ReturnType<typeof createManualClock>; recorder: EventRecorder; api: ReturnType<typeof fakeApi.create>; events: ServerEvent[] } {
  const clock = createManualClock();
  const recorder = createEventRecorder({ clock });
  const api = fakeApi.create({ clock, recorder });
  const events: ServerEvent[] = [];
  api.port.onEvent((event) => events.push(event));
  return { clock, recorder, api, events };
}

const names = (recorder: EventRecorder): string[] => recorder.since(0).events.map((event) => `${event.source}:${event.name}`);

describe('fake api', () => {
  it('resolves a submission after 300 ms and echoes confirmation then success 500 ms later', async () => {
    const { clock, recorder, api, events } = boot();
    let paymentId: string | undefined;
    void api.port.submitPayment({ token: 'saved-card', amountCents: 4_500 }).then((result) => {
      paymentId = result.paymentId;
    });
    await clock.advance(299);
    expect(paymentId).toBeUndefined();
    await clock.advance(1);
    expect(paymentId).toBe('pay_1');
    expect(events).toEqual([]);
    expect(clock.timers().map((timer) => timer.label)).toEqual(['api.serverEcho']);
    await clock.advance(500);
    expect(events).toEqual([
      { type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 },
      { type: 'payment.succeeded', paymentId: 'pay_1' },
    ]);
    expect(names(recorder)).toEqual(['api:submitPayment', 'api:order.confirmed', 'api:payment.succeeded']);
    expect(recorder.since(0).events[0]?.data).toEqual({ amountCents: 4_500, paymentId: 'pay_1' });
  });

  it('numbers payments per instance and restarts at 1 for a new instance', async () => {
    const { clock, api } = boot();
    void api.port.submitPayment({ token: 'a', amountCents: 1 });
    void api.port.submitPayment({ token: 'b', amountCents: 2 });
    await clock.advance(800);
    expect(api.calls().calls.filter((call) => call.method === 'submitPayment').map((call) => call.outcome)).toEqual(['resolved', 'resolved']);
    const fresh = boot();
    let paymentId: string | undefined;
    void fresh.api.port.submitPayment({ token: 'c', amountCents: 3 }).then((result) => {
      paymentId = result.paymentId;
    });
    await fresh.clock.advance(300);
    expect(paymentId).toBe('pay_1');
  });

  it('holds the echo in manual mode and lets emit deliver events with defaults from the last submission', async () => {
    const { clock, api, events } = boot();
    await api.control('setEcho', { mode: 'manual' });
    void api.port.submitPayment({ token: 'saved-card', amountCents: 4_500 });
    await clock.advance(300);
    expect(clock.timers()).toEqual([]);
    await api.control('emit', { event: 'payment.succeeded' });
    await api.control('emit', { event: 'order.confirmed' });
    expect(events).toEqual([
      { type: 'payment.succeeded', paymentId: 'pay_1' },
      { type: 'order.confirmed', orderId: 'ord_1', totalCents: 4_500 },
    ]);
  });

  it('lets explicit fields override the defaults and defaults the failure reason', async () => {
    const { api, events } = boot();
    await api.control('setEcho', { mode: 'manual' });
    void api.port.submitPayment({ token: 'saved-card', amountCents: 100 });
    await api.control('emit', { event: 'order.confirmed', orderId: 'ord_9', totalCents: 1 });
    await api.control('emit', { event: 'payment.succeeded', paymentId: 'pay_9' });
    await api.control('emit', { event: 'payment.failed' });
    await api.control('emit', { event: 'payment.failed', reason: 'insufficient funds' });
    expect(events).toEqual([
      { type: 'order.confirmed', orderId: 'ord_9', totalCents: 1 },
      { type: 'payment.succeeded', paymentId: 'pay_9' },
      { type: 'payment.failed', reason: 'Declined by the server' },
      { type: 'payment.failed', reason: 'insufficient funds' },
    ]);
  });

  it('fails emit with DISPATCH_FAILED naming the fields when there is no submission to default from', async () => {
    const { api } = boot();
    await expect(api.control('emit', { event: 'order.confirmed' })).rejects.toMatchObject({
      code: 'DISPATCH_FAILED',
      details: { name: 'api.emit', message: expect.stringContaining('orderId and totalCents') },
    });
    await expect(api.control('emit', { event: 'order.confirmed', orderId: 'ord_1' })).rejects.toMatchObject({
      code: 'DISPATCH_FAILED',
      details: { message: expect.not.stringContaining('orderId') },
    });
    await expect(api.control('emit', { event: 'payment.succeeded' })).rejects.toMatchObject({
      code: 'DISPATCH_FAILED',
      details: { name: 'api.emit', message: expect.stringContaining('paymentId') },
    });
  });

  it('validates control payloads through the schemas', async () => {
    const { api } = boot();
    await expect(api.control('emit', { event: 'order.cancelled' })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'api.emit' } });
    await expect(api.control('setEcho', { mode: 'sometimes' })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'api.setEcho' } });
    expect(api.controls.names()).toEqual(['emit', 'setEcho']);
  });

  it('records port calls with their arguments and outcome', async () => {
    const { clock, api } = boot();
    void api.port.submitPayment({ token: 'saved-card', amountCents: 4_500 });
    expect(api.calls().calls.map((call) => [call.method, call.outcome])).toEqual([
      ['onEvent', 'returned'],
      ['submitPayment', 'pending'],
    ]);
    await clock.advance(300);
    const submit = api.calls().calls.find((call) => call.method === 'submitPayment');
    expect(submit).toMatchObject({ fake: 'api', seq: 2, args: [{ token: 'saved-card', amountCents: 4_500 }], outcome: 'resolved' });
  });
});
