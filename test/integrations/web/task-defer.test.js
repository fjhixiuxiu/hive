import { describe, it, expect, vi } from 'vitest';

import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';

/**
 * The dashboard half of Defer: the ws entry point and the two Settings
 * toggles that decide whether the buttons render at all.
 *
 * Defer and Requeue do the same thing to the session and differ only in where
 * the task lands, so the handler must NOT quietly fall back to requeue when
 * deferTask is missing or refuses — a silent promotion is the exact bug this
 * feature exists to prevent.
 */
function makeDeps(overrides = {}) {
  const sampleTask = { id: 't1', status: 'dispatched', assignedTo: 7 };
  const deferTaskSpy = vi.fn(() => ({ ...sampleTask, status: 'queued', assignedTo: null, deferredAt: 123 }));
  const requeueTaskSpy = vi.fn();

  const taskQueue = {
    tasks: new Map([[sampleTask.id, sampleTask]]),
    activeTaskBySession: new Map(),
    deferTask: deferTaskSpy,
    requeueTask: requeueTaskSpy,
    showRequeueBtn: true,
    showDeferBtn: true,
    _pmManager: null,
    _saveState: vi.fn(),
    ...overrides,
  };

  const ws = { readyState: 1, send: vi.fn() };
  const broadcasts = [];
  const router = { getNode: () => ({ exec: async () => '', capturePane: async () => '' }) };

  const handle = createMessageHandler({
    config: { sessions: { claudePane: 1, namePrefix: '' } },
    taskQueue,
    pmManager: null,
    router,
    broadcast: (msg) => broadcasts.push(msg),
    checkPermission: overrides.checkPermission || (() => true),
    resolveSession: async () => null,
    clearTermSub: () => {}, clearConsoleSub: () => {},
    termSubs: new Map(), consoleSubs: new Map(),
    clearCardSub: () => {}, clearAllCardSubs: () => {},
    cardTermSubs: new Map(),
    sendFleetStatus: async () => {}, broadcastFleetStatus: async () => {},
    sendInitialState: async () => {}, _previewCache: new Map(),
    commands: new Map(), clients: new Set(), wsUser: new WeakMap(),
    workers: new Map(), mcpClients: new Map(),
    voiceAgent: null,
  });

  return { handle, ws, broadcasts, taskQueue, deferTaskSpy, requeueTaskSpy };
}

describe('task:defer', () => {
  it('defers the task and broadcasts it', async () => {
    const { handle, ws, broadcasts, deferTaskSpy, requeueTaskSpy } = makeDeps();

    await handle(ws, { type: 'task:defer', taskId: 't1' }, { login: 'tester' });

    expect(deferTaskSpy).toHaveBeenCalledWith('t1');
    // Never the in-place path — that would silently promote an old task.
    expect(requeueTaskSpy).not.toHaveBeenCalled();
    const msg = broadcasts.find(b => b.type === 'task:deferred');
    expect(msg).toBeTruthy();
    expect(msg.task).toMatchObject({ id: 't1', status: 'queued', deferredAt: 123 });
  });

  it('broadcasts nothing when the queue refuses (snoozed, completed, unknown)', async () => {
    const { handle, ws, broadcasts } = makeDeps({ deferTask: vi.fn(() => null) });

    await handle(ws, { type: 'task:defer', taskId: 'nope' }, { login: 'tester' });

    expect(broadcasts.find(b => b.type === 'task:deferred')).toBeUndefined();
  });

  it('requires the dispatch permission', async () => {
    const { handle, ws, deferTaskSpy } = makeDeps({ checkPermission: () => false });

    await handle(ws, { type: 'task:defer', taskId: 't1' }, { login: 'reader' });

    expect(deferTaskSpy).not.toHaveBeenCalled();
  });
});

describe('taskButtons:toggle', () => {
  it('flips only the named button and reports both back', async () => {
    const { handle, ws, broadcasts, taskQueue } = makeDeps();

    await handle(ws, { type: 'taskButtons:toggle', button: 'defer' }, { login: 'tester' });

    expect(taskQueue.showDeferBtn).toBe(false);
    expect(taskQueue.showRequeueBtn).toBe(true);
    const msg = broadcasts.filter(b => b.type === 'taskButtons:status').pop();
    expect(msg).toEqual({ type: 'taskButtons:status', requeue: true, defer: false });
  });

  it('can hide Requeue independently', async () => {
    const { handle, ws, taskQueue } = makeDeps();

    await handle(ws, { type: 'taskButtons:toggle', button: 'requeue' }, { login: 'tester' });

    expect(taskQueue.showRequeueBtn).toBe(false);
    expect(taskQueue.showDeferBtn).toBe(true);
  });

  it('persists the choice so a restart does not resurrect a hidden button', async () => {
    const { handle, ws, taskQueue } = makeDeps();

    await handle(ws, { type: 'taskButtons:toggle', button: 'defer' }, { login: 'tester' });

    expect(taskQueue._saveState).toHaveBeenCalled();
  });

  it('ignores an unknown button name', async () => {
    const { handle, ws, broadcasts, taskQueue } = makeDeps();

    await handle(ws, { type: 'taskButtons:toggle', button: 'bogus' }, { login: 'tester' });

    expect(taskQueue.showRequeueBtn).toBe(true);
    expect(taskQueue.showDeferBtn).toBe(true);
    expect(broadcasts.find(b => b.type === 'taskButtons:status')).toBeUndefined();
    expect(taskQueue._saveState).not.toHaveBeenCalled();
  });

  it('requires the dispatch permission', async () => {
    const { handle, ws, taskQueue } = makeDeps({ checkPermission: () => false });

    await handle(ws, { type: 'taskButtons:toggle', button: 'defer' }, { login: 'reader' });

    expect(taskQueue.showDeferBtn).toBe(true);
  });
});
