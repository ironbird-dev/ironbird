import { IronbirdError } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { DaemonClient } from '../cli/client';
import { runWatch } from './watch';

type Kind = 'event' | 'state' | 'target' | 'error';

interface PendingRead {
  params: Record<string, unknown>;
  target: string | undefined;
  resolve(result: Record<string, unknown>): void;
  reject(error: unknown): void;
}

/** A scripted daemon: the test emits stream frames and settles each getState read by hand. */
function fakeDaemon(options: { streamError?: unknown; stallEvents?: boolean } = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown>; target: string | undefined }> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const reads: PendingRead[] = [];
  let onMessage: ((kind: Kind, data: unknown) => void) | undefined;
  let endStream: () => void = () => {};
  const client: DaemonClient = {
    url: 'http://fake',
    call<T>(op: string, params: Record<string, unknown> = {}, target?: string, callOptions: { signal?: AbortSignal } = {}): Promise<{ target?: string; result: T }> {
      calls.push({ op, params, target });
      signals.push(callOptions.signal);
      if (op === 'events' && options.stallEvents) return new Promise(() => {});
      if (op === 'events') return Promise.resolve({ target: target ?? 'headless', result: { events: [], nextSeq: 7, truncated: false } as T });
      if (op === 'getState') {
        return new Promise((resolve, reject) => {
          reads.push({ params, target, resolve: (result) => resolve({ target: target ?? 'headless', result: result as T }), reject });
        });
      }
      return Promise.reject(new Error(`unexpected ${op}`));
    },
    async rpc<T>(op: string, params?: Record<string, unknown>, target?: string): Promise<T> {
      return (await client.call<T>(op, params, target)).result;
    },
    stream(streamOptions) {
      calls.push({ op: 'stream', params: { since: streamOptions.since }, target: streamOptions.target });
      if (options.streamError !== undefined) return Promise.reject(options.streamError);
      onMessage = streamOptions.onMessage;
      return new Promise<void>((resolve) => {
        endStream = resolve;
        streamOptions.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
  return { client, calls, signals, reads, frame: (kind: Kind, data: unknown) => onMessage?.(kind, data), end: () => endStream() };
}

function watch(daemon: ReturnType<typeof fakeDaemon>, path = '', target?: string) {
  const lines: unknown[] = [];
  const controller = new AbortController();
  const done = runWatch({ client: daemon.client, target, path, signal: controller.signal, write: (line) => lines.push(JSON.parse(line)) });
  return { lines, controller, done };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('runWatch', () => {
  it('opens the stream at the event cursor on the pinned target and reads only after the first state frame', async () => {
    const d = fakeDaemon();
    const w = watch(d, 'cart');
    await tick();
    expect(d.calls).toEqual([
      { op: 'events', params: { limit: 0 }, target: undefined },
      { op: 'stream', params: { since: 7 }, target: 'headless' },
    ]);
    d.frame('event', { seq: 8, t: 0, source: 'app', name: 'x' });
    d.frame('target', { id: 'ios', platform: 'ios', appId: 'a', status: 'connected' });
    expect(d.reads).toHaveLength(0);
    d.frame('state', { rev: 3 });
    expect(d.reads).toHaveLength(1);
    expect(d.reads[0]).toMatchObject({ params: { path: 'cart' }, target: 'headless' });
    d.reads[0]!.resolve({ rev: 3, path: 'cart', value: { items: [] } });
    await tick();
    expect(w.lines).toEqual([{ rev: 3, patch: [{ op: 'add', path: '', value: { items: [] } }] }]);
    w.controller.abort();
    expect(await w.done).toBe(0);
  });

  it('uses the given target for every call', async () => {
    const d = fakeDaemon();
    const w = watch(d, '', 'ios');
    await tick();
    d.frame('state', { rev: 0 });
    expect(d.calls.map((call) => call.target)).toEqual(['ios', 'ios', 'ios']);
    w.controller.abort();
    await w.done;
  });

  it('keeps one read in flight and reads once more after frames that arrived during it, labelling lines with the revision read', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.frame('state', { rev: 2 });
    d.frame('state', { rev: 3 });
    expect(d.reads).toHaveLength(1);
    d.reads[0]!.resolve({ rev: 1, path: '', value: { n: 1 } });
    await tick();
    expect(d.reads).toHaveLength(2);
    d.reads[1]!.resolve({ rev: 3, path: '', value: { n: 3 } });
    await tick();
    expect(d.reads).toHaveLength(2);
    expect(w.lines).toEqual([
      { rev: 1, patch: [{ op: 'add', path: '', value: { n: 1 } }] },
      { rev: 3, patch: [{ op: 'replace', path: '/n', value: 3 }] },
    ]);
    w.controller.abort();
    await w.done;
  });

  it('reads again after a frame during a read even when it carries the revision the read returned', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 5 });
    d.frame('state', { rev: 5 });
    d.reads[0]!.resolve({ rev: 5, path: '', value: { n: 1 } });
    await tick();
    // After a reset and five quick dispatches the revision is 5 again, with another state.
    expect(d.reads).toHaveLength(2);
    d.reads[1]!.resolve({ rev: 5, path: '', value: { n: 2 } });
    await tick();
    expect(w.lines).toEqual([
      { rev: 5, patch: [{ op: 'add', path: '', value: { n: 1 } }] },
      { rev: 5, patch: [{ op: 'replace', path: '/n', value: 2 }] },
    ]);
    w.controller.abort();
    await w.done;
  });

  it('reads on a frame that arrives while idle, prints nothing for an unchanged value, and follows revisions backwards', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 5 });
    d.reads[0]!.resolve({ rev: 5, path: '', value: { n: 1 } });
    await tick();
    d.frame('state', { rev: 5 });
    d.reads[1]!.resolve({ rev: 5, path: '', value: { n: 1 } });
    await tick();
    d.frame('state', { rev: 0 });
    d.reads[2]!.resolve({ rev: 0, path: '', value: { n: 0 } });
    await tick();
    expect(w.lines).toEqual([
      { rev: 5, patch: [{ op: 'add', path: '', value: { n: 1 } }] },
      { rev: 0, patch: [{ op: 'replace', path: '/n', value: 0 }] },
    ]);
    w.controller.abort();
    await w.done;
  });

  it('prints [] first for a missing path, then an add and a remove at the root as it appears and disappears', async () => {
    const d = fakeDaemon();
    const w = watch(d, 'extra');
    await tick();
    const step = async (index: number, result: Record<string, unknown>): Promise<void> => {
      d.frame('state', { rev: index });
      d.reads[index]!.resolve(result);
      await tick();
    };
    await step(0, { rev: 0, path: 'extra' });
    await step(1, { rev: 1, path: 'extra', value: null });
    await step(2, { rev: 2, path: 'extra' });
    await step(3, { rev: 3, path: 'extra' });
    expect(w.lines).toEqual([
      { rev: 0, patch: [] },
      { rev: 1, patch: [{ op: 'add', path: '', value: null }] },
      { rev: 2, patch: [{ op: 'remove', path: '' }] },
    ]);
    w.controller.abort();
    await w.done;
  });

  it('ends on an error frame with its exit code, after nothing else', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.frame('error', { code: 'TARGET_DISCONNECTED', message: 'Target ios disconnected', details: { target: 'ios', op: 'stream' } });
    d.reads[0]!.resolve({ rev: 1, path: '', value: {} });
    expect(await w.done).toBe(1);
    await tick();
    expect(w.lines).toEqual([{ error: { code: 'TARGET_DISCONNECTED', message: 'Target ios disconnected', details: { target: 'ios', op: 'stream' } } }]);
  });

  it('reports a malformed error frame as INTERNAL', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('error', 'nope');
    expect(await w.done).toBe(1);
    expect(w.lines).toEqual([{ error: { code: 'INTERNAL', message: 'Malformed error frame from daemon' } }]);
  });

  it('ends with the error and its exit code when a read fails', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.reads[0]!.reject(new IronbirdError('NO_TARGET', 'No target ios', { available: [] }));
    expect(await w.done).toBe(5);
    expect(w.lines).toEqual([{ error: { code: 'NO_TARGET', message: 'No target ios', details: { available: [] } } }]);
  });

  it('ends with 0 on abort and prints nothing for a read still in flight', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    w.controller.abort();
    d.reads[0]!.resolve({ rev: 1, path: '', value: {} });
    expect(await w.done).toBe(0);
    await tick();
    expect(w.lines).toEqual([]);
  });

  it('prints the error of a repeat read that fails after the daemon ends the stream, and exits with its code', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.frame('state', { rev: 2 });
    d.end();
    d.reads[0]!.resolve({ rev: 1, path: '', value: { n: 1 } });
    await tick();
    expect(d.reads).toHaveLength(2);
    d.reads[1]!.reject(new IronbirdError('NO_TARGET', 'Daemon unreachable at http://fake; run ironbird serve', { url: 'http://fake' }));
    expect(await w.done).toBe(5);
    expect(w.lines).toEqual([
      { rev: 1, patch: [{ op: 'add', path: '', value: { n: 1 } }] },
      { error: { code: 'NO_TARGET', message: 'Daemon unreachable at http://fake; run ironbird serve', details: { url: 'http://fake' } } },
    ]);
  });

  it('ends with 0 when interrupted while the cursor read is still pending', { timeout: 1_000 }, async () => {
    const d = fakeDaemon({ stallEvents: true });
    const w = watch(d);
    await tick();
    w.controller.abort();
    expect(await w.done).toBe(0);
    expect(d.calls.map((call) => call.op)).toEqual(['events']);
    expect(w.lines).toEqual([]);
  });

  it('cancels its requests in flight when interrupted', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    expect(d.signals.map((signal) => signal?.aborted)).toEqual([false, false]);
    w.controller.abort();
    expect(await w.done).toBe(0);
    expect(d.signals.map((signal) => signal?.aborted)).toEqual([true, true]);
  });

  it('ends with 0 without calling the daemon when already interrupted', async () => {
    const d = fakeDaemon();
    const lines: string[] = [];
    expect(await runWatch({ client: d.client, target: undefined, path: '', signal: AbortSignal.abort(), write: (line) => lines.push(line) })).toBe(0);
    expect(d.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('lets a read in flight print when the daemon ends the stream, then returns 0', async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.end();
    d.reads[0]!.resolve({ rev: 1, path: '', value: { n: 1 } });
    expect(await w.done).toBe(0);
    expect(w.lines).toEqual([{ rev: 1, patch: [{ op: 'add', path: '', value: { n: 1 } }] }]);
  });

  it('ends with 0 when interrupted during a read still in flight after the daemon ends the stream', { timeout: 1_000 }, async () => {
    const d = fakeDaemon();
    const w = watch(d);
    await tick();
    d.frame('state', { rev: 1 });
    d.end();
    await tick();
    w.controller.abort();
    expect(await w.done).toBe(0);
    expect(d.signals[1]?.aborted).toBe(true);
    d.reads[0]!.resolve({ rev: 1, path: '', value: { n: 1 } });
    await tick();
    expect(w.lines).toEqual([]);
  });

  it('rejects when the stream fails to open', async () => {
    const d = fakeDaemon({ streamError: new IronbirdError('UNAUTHORIZED', 'Token missing or wrong for this daemon') });
    await expect(watch(d).done).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
