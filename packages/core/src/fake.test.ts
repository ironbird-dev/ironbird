import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createManualClock } from './clock';
import { IronbirdError, isIronbirdError } from './errors';
import { defineFake } from './fake';
import { createEventRecorder } from './recorder';
import { isFakePort } from './tracker';

interface ReaderPort {
  collectPayment(amountCents: number): Promise<{ token: string }>;
  onEvent(listener: (event: string) => void): () => void;
}

const fakeReader = defineFake('reader', {
  description: 'Fake card reader',
  controls: {
    emit: z.object({ event: z.enum(['connected', 'disconnected']) }).describe('Emit a reader event'),
    setLatency: z.object({ ms: z.number().int().min(0) }),
    boom: z.object({}),
    refuse: z.object({}),
  },
  create({ clock, record }) {
    const listeners = new Set<(event: string) => void>();
    let latencyMs = 100;
    const port: ReaderPort = {
      collectPayment: (amountCents) =>
        new Promise((resolve) => {
          clock.setTimeout(() => resolve({ token: `fake_${amountCents}` }), latencyMs, 'reader.collectPayment');
        }),
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
          record(event, { latencyMs });
          for (const listener of listeners) listener(event);
        },
        setLatency: async ({ ms }) => {
          latencyMs = ms;
        },
        boom: () => {
          throw new Error('control exploded');
        },
        refuse: () => {
          throw new IronbirdError('UNSUPPORTED', 'not now', { op: 'refuse' });
        },
      },
    };
  },
});

const failure = async (promise: Promise<unknown>): Promise<{ code: string; message: string; details: unknown }> => {
  const error = await promise.catch((caught: unknown) => caught);
  if (!isIronbirdError(error)) throw new Error(`expected an IronbirdError, got ${String(error)}`);
  return { code: error.code, message: error.message, details: error.details };
};

describe('defineFake', () => {
  it('creates an instance with a registry over the controls and a marked, recording port', async () => {
    const clock = createManualClock({ now: 5 });
    const instance = fakeReader.create({ clock });
    expect(fakeReader.name).toBe('reader');
    expect(instance).toMatchObject({ name: 'reader', description: 'Fake card reader' });
    expect(instance.controls.names()).toEqual(['emit', 'setLatency', 'boom', 'refuse']);
    expect(instance.controls.describe()['emit']?.description).toBe('Emit a reader event');
    expect(isFakePort(instance.port)).toBe(true);
    const paying = instance.port.collectPayment(4_500);
    expect(instance.calls()).toMatchObject({ calls: [{ seq: 1, t: 5, fake: 'reader', method: 'collectPayment', args: [4_500], outcome: 'pending' }], nextSeq: 1, truncated: false });
    await clock.advance(100);
    await expect(paying).resolves.toEqual({ token: 'fake_4500' });
    expect(instance.calls(0, 1).calls[0]?.outcome).toBe('resolved');
    const terse = defineFake('terse', { controls: {}, create: () => ({ port: {}, controls: {} }) }).create({ clock });
    expect('description' in terse).toBe(false);
  });

  it('runs a control through the registry and records events with the fake as the source, or silently without a recorder', async () => {
    const clock = createManualClock();
    const recorder = createEventRecorder({ clock });
    const instance = fakeReader.create({ clock, recorder });
    const seen: string[] = [];
    instance.port.onEvent((event) => seen.push(event));
    await instance.control('emit', { event: 'connected' });
    await instance.control('setLatency', { ms: 5 });
    await instance.control('emit', { event: 'disconnected' });
    expect(seen).toEqual(['connected', 'disconnected']);
    expect(recorder.since().events.map((event) => [event.source, event.name, event.data])).toEqual([
      ['reader', 'connected', { latencyMs: 100 }],
      ['reader', 'disconnected', { latencyMs: 5 }],
    ]);
    await expect(fakeReader.create({ clock }).control('emit', { event: 'connected' })).resolves.toBeUndefined();
  });

  it('fails unknown controls with UNKNOWN_CONTROL and suggestions', async () => {
    const instance = fakeReader.create({ clock: createManualClock() });
    expect(await failure(instance.control('emitt', { event: 'connected' }))).toEqual({
      code: 'UNKNOWN_CONTROL',
      message: 'Unknown control emitt on fake reader',
      details: { fake: 'reader', control: 'emitt', suggestions: ['emit', 'boom', 'refuse'] },
    });
  });

  it('names the control as fake.control in INVALID_PAYLOAD and DISPATCH_FAILED, and passes an IronbirdError through', async () => {
    const instance = fakeReader.create({ clock: createManualClock() });
    const invalid = await failure(instance.control('setLatency', { ms: -1 }));
    expect(invalid).toMatchObject({ code: 'INVALID_PAYLOAD', message: 'Invalid payload for reader.setLatency', details: { name: 'reader.setLatency' } });
    expect((invalid.details as { issues: Array<{ path: unknown[] }> }).issues.map((issue) => issue.path)).toEqual([['ms']]);
    expect(await failure(instance.control('emit'))).toMatchObject({ code: 'INVALID_PAYLOAD', details: { name: 'reader.emit' } });
    expect(await failure(instance.control('boom'))).toEqual({
      code: 'DISPATCH_FAILED',
      message: 'Control reader.boom failed: control exploded',
      details: { name: 'reader.boom', message: 'control exploded' },
    });
    expect(await failure(instance.control('refuse'))).toEqual({ code: 'UNSUPPORTED', message: 'not now', details: { op: 'refuse' } });
  });

  it('rejects a handler map whose keys differ from the declared controls when the instance is created', () => {
    const clock = createManualClock();
    const extra = defineFake('reader', {
      controls: { emit: z.object({}) },
      create: () => ({ port: {}, controls: { emit: () => {}, emitt: () => {} } }),
    });
    let error: unknown;
    try {
      extra.create({ clock });
    } catch (caught) {
      error = caught;
    }
    expect(isIronbirdError(error) && error.code).toBe('UNKNOWN_CONTROL');
    expect(isIronbirdError(error) && error.details).toEqual({ fake: 'reader', control: 'emitt', suggestions: ['emit'] });

    // Only a JavaScript caller can omit a handler; TypeScript rejects the missing key.
    const missing = defineFake('api', {
      controls: { emit: z.object({}), setEcho: z.object({}) },
      create: () => ({ port: {}, controls: { emit: () => {} } as never }),
    });
    expect(() => missing.create({ clock })).toThrow(/declares the control setEcho/);
  });
});
