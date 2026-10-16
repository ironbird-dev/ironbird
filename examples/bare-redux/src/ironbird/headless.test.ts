import { createEventRecorder, createManualClock, createTracker, type FakeInstance, type HeadlessApp } from '@ironbird/core';
import { describe, expect, it } from 'vitest';
import type { AppState } from '../store/todos';
import headless from './headless';

async function boot(env: Record<string, string> = {}) {
  const clock = createManualClock({ now: Date.parse('2026-01-01T00:00:00.000Z') });
  const recorder = createEventRecorder({ clock });
  const tracker = createTracker({ clock });
  const app = await headless.create({ clock, recorder, tracker, env });
  const settle = () => tracker.whenIdle({ mode: 'quiescent', timeoutMs: 1_000 });
  return { app, clock, settle };
}

const state = (app: HeadlessApp): AppState => app.target.getState() as AppState;

function syncFake(app: HeadlessApp): FakeInstance {
  const fake = app.fakes?.find((candidate) => candidate.name === 'sync');
  if (!fake) throw new Error('sync fake not wired');
  return fake;
}

function persistAndRestore(app: HeadlessApp): { persist: () => unknown; restore: (snapshot: unknown) => Promise<void> } {
  const { persist, restore } = app.target;
  if (!persist || !restore) throw new Error('the target lacks persist or restore');
  return { persist, restore };
}

describe('bare-redux headless entry', () => {
  it('describes the three commands, the sync fake, and both snapshot capabilities', async () => {
    const { app } = await boot();
    expect(app.target.commands.names()).toEqual(['todos.add', 'todos.toggle', 'todos.rename']);
    expect(app.fakes?.map((fake) => [fake.name, fake.controls.names()])).toEqual([['sync', ['setAcks', 'release']]]);
    expect(app.target.capabilities).toEqual(['persist', 'restore']);
  });

  it('adds a to-do with a trimmed title, waits on the 300 ms save, and ends saved', async () => {
    const { app, clock, settle } = await boot();
    await app.target.dispatch('todos.add', { title: '  Buy milk ' });
    let result = await settle();
    expect(result).toMatchObject({ idle: false, quiescent: true, nextTimerInMs: 300 });
    expect(result.pending.map((pending) => pending.label)).toEqual(['sync.save']);
    expect(state(app)).toEqual({
      todos: { items: [{ id: 't1', title: 'Buy milk', done: false, rev: 1, syncedRev: 0 }], nextId: 2 },
      sync: { inFlight: 1, lastError: null },
    });

    await clock.advance(300);
    result = await settle();
    expect(result.idle).toBe(true);
    expect(state(app)).toMatchObject({ todos: { items: [{ syncedRev: 1 }] }, sync: { inFlight: 0 } });
  });

  it('fails an edit to a missing to-do with DISPATCH_FAILED', async () => {
    const { app } = await boot();
    await expect(app.target.dispatch('todos.toggle', { id: 't9' })).rejects.toMatchObject({
      code: 'DISPATCH_FAILED',
      details: { name: 'todos.toggle', message: 'No to-do with id t9' },
    });
  });

  it('without PLANT_BUG, a quick second edit ends saved at revision 2', async () => {
    const { app, clock, settle } = await boot();
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    await app.target.dispatch('todos.toggle', { id: 't1' });
    await clock.advance(300);
    await settle();
    expect(state(app).sync.inFlight).toBe(0);
    expect(state(app).todos.items[0]).toMatchObject({ rev: 2, syncedRev: 2 });
  });

  it('with PLANT_BUG=1, the same edits end unsaved with nothing in flight', async () => {
    const { app, clock, settle } = await boot({ PLANT_BUG: '1' });
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    await app.target.dispatch('todos.toggle', { id: 't1' });
    await clock.advance(300);
    await settle();
    expect(state(app).sync.inFlight).toBe(0);
    expect(state(app).todos.items[0]).toMatchObject({ rev: 2, syncedRev: 1 });
  });

  it('persists the root state and restores it through the wrapped reducer', async () => {
    const { app, clock, settle } = await boot();
    const { persist, restore } = persistAndRestore(app);
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    await clock.advance(300);
    await settle();
    const saved = persist();
    expect(saved).toEqual({
      todos: { items: [{ id: 't1', title: 'Buy milk', done: false, rev: 1, syncedRev: 1 }], nextId: 2 },
      sync: { inFlight: 0, lastError: null },
    });

    await app.target.dispatch('todos.toggle', { id: 't1' });
    await restore(saved);
    expect(state(app)).toEqual(saved);
  });

  it('refuses a snapshot with an extra key or a wrong type and leaves the store as it was', async () => {
    const { app } = await boot();
    const { persist, restore } = persistAndRestore(app);
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    const before = state(app);
    const saved = persist() as AppState;
    await expect(restore({ ...saved, extra: true })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    await expect(restore({ ...saved, sync: { inFlight: -1, lastError: null } })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    await expect(restore({ ...saved, todos: { items: 'none', nextId: 2 } })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    expect(state(app)).toBe(before);
  });

  it('survives an acknowledgement for a to-do the restored state does not have', async () => {
    const { app, settle } = await boot();
    const { persist, restore } = persistAndRestore(app);
    const empty = persist();
    await syncFake(app).control('setAcks', { mode: 'manual' });
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    await restore(empty);
    await syncFake(app).control('release', { order: 'oldest' });
    await settle();
    expect(state(app)).toEqual({ todos: { items: [], nextId: 1 }, sync: { inFlight: 0, lastError: null } });
  });

  it('ignores an old acknowledgement that arrives for a new to-do reusing the id after a restore', async () => {
    const { app, settle } = await boot();
    const { persist, restore } = persistAndRestore(app);
    const empty = persist();
    await syncFake(app).control('setAcks', { mode: 'manual' });
    await app.target.dispatch('todos.add', { title: 'Old milk' });
    await restore(empty);
    await app.target.dispatch('todos.add', { title: 'New milk' });
    expect(state(app)).toMatchObject({ todos: { items: [{ id: 't1', title: 'New milk', syncedRev: 0 }] }, sync: { inFlight: 1 } });

    await syncFake(app).control('release', { order: 'oldest' });
    await settle();
    expect(state(app)).toMatchObject({ todos: { items: [{ id: 't1', title: 'New milk', syncedRev: 0 }] }, sync: { inFlight: 1 } });

    await syncFake(app).control('release', { order: 'oldest' });
    await settle();
    expect(state(app)).toMatchObject({ todos: { items: [{ syncedRev: 1 }] }, sync: { inFlight: 0 } });
  });

  it('clears the in-flight count a restored snapshot carries, since those saves are abandoned', async () => {
    const { app, settle } = await boot();
    const { persist, restore } = persistAndRestore(app);
    await syncFake(app).control('setAcks', { mode: 'manual' });
    await app.target.dispatch('todos.add', { title: 'Buy milk' });
    const midSave = persist() as AppState;
    expect(midSave.sync.inFlight).toBe(1);
    await restore(midSave);
    await settle();
    expect(state(app)).toEqual({ ...midSave, sync: { inFlight: 0, lastError: null } });
  });

  it('counts a save started while the restore is still being awaited', async () => {
    const { app, settle } = await boot();
    const { persist, restore } = persistAndRestore(app);
    await syncFake(app).control('setAcks', { mode: 'manual' });
    await app.target.dispatch('todos.add', { title: 'Old milk' });
    const midSave = persist();
    const restoring = restore(midSave);
    await app.target.dispatch('todos.add', { title: 'New milk' });
    await restoring;
    await settle();
    expect(state(app).sync.inFlight).toBe(1);

    await syncFake(app).control('release', { order: 'oldest' });
    await syncFake(app).control('release', { order: 'oldest' });
    await settle();
    expect(state(app).sync.inFlight).toBe(0);
    expect(state(app).todos.items.map((item) => item.syncedRev)).toEqual([0, 1]);
  });
});
