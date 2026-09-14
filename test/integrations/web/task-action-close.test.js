import { describe, it, expect, vi, beforeEach } from 'vitest';

import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';

/**
 * Tests for the close-task semantic flip from commit b08e010.
 *
 * Before: completeTask honored requireHumanClose, so manual close paths
 * (Done button, action menu) left Human Review / PR Review PM tasks stuck
 * in 'pending'. The flow looked closed in the UI but the task lingered.
 *
 * After: both paths now pass { force: true } to completeTask — the user
 * clicking Done or an action menu IS the human approval. This test pins
 * the force flag so a future refactor can't quietly re-enable the hang.
 *
 * We cover task:complete (Done button) here — task:action shares the same
 * { force: true } call site on line 822 of ws-handlers.js, but routing
 * through executeTaskAction needs a full pmManager mock, which is out of
 * scope. The semantic invariant — completeTask receives { force: true }
 * for any user-initiated close — is captured by exercising task:complete.
 */

function makeDeps() {
  const sampleTask = {
    id: 't1',
    status: 'dispatched',
    assignedTo: 7,
    requireHumanClose: true, // would have blocked the old (non-force) path
    actionContext: { type: 'github-pr', repo: 'org/repo', prNumber: 42 },
  };

  const completeTaskSpy = vi.fn((_taskId, message) => ({
    ...sampleTask,
    status: 'completed',
    result: message,
  }));

  const taskQueue = {
    tasks: new Map([[sampleTask.id, sampleTask]]),
    activeTaskBySession: new Map(),
    completeTask: completeTaskSpy,
    _pmManager: null,
    _saveState: () => {},
  };

  const ws = { readyState: 1, send: vi.fn() };
  const broadcasts = [];

  // Stub fleet.findSession to a no-op so the post-complete snapshot capture
  // (async, fire-and-forget) doesn't try to hit a real node.
  const router = { getNode: () => ({ exec: async () => '', capturePane: async () => '' }) };

  const handle = createMessageHandler({
    config: { sessions: { claudePane: 1, namePrefix: '' } },
    taskQueue,
    pmManager: null,
    router,
    broadcast: (msg) => broadcasts.push(msg),
    checkPermission: () => true,
    resolveSession: async () => null,
    clearTermSub: () => {},
    clearConsoleSub: () => {},
    termSubs: new Map(),
    consoleSubs: new Map(),
    clearCardSub: () => {},
    clearAllCardSubs: () => {},
    cardTermSubs: new Map(),
    sendFleetStatus: async () => {},
    broadcastFleetStatus: async () => {},
    sendInitialState: async () => {},
    _previewCache: new Map(),
    commands: new Map(),
    clients: new Set(),
    wsUser: new WeakMap(),
    workers: new Map(),
    mcpClients: new Map(),
    voiceAgent: null,
  });

  return { handle, ws, broadcasts, completeTaskSpy };
}

describe('task:complete force:true semantic (Done button)', () => {
  it('calls completeTask with { force: true } when user clicks Done', async () => {
    const { handle, ws, completeTaskSpy } = makeDeps();

    await handle(
      ws,
      { type: 'task:complete', taskId: 't1', result: 'Manually done' },
      { login: 'tester' },
    );

    expect(completeTaskSpy).toHaveBeenCalledTimes(1);
    // Signature: completeTask(taskId, message, snapshot, snapshotCols, opts)
    const args = completeTaskSpy.mock.calls[0];
    expect(args[0]).toBe('t1');
    expect(args[1]).toBe('Manually done');
    expect(args[4]).toEqual({ force: true });
  });

  it('uses default message when result is omitted', async () => {
    const { handle, ws, completeTaskSpy } = makeDeps();

    await handle(ws, { type: 'task:complete', taskId: 't1' }, { login: 'tester' });

    expect(completeTaskSpy).toHaveBeenCalledTimes(1);
    expect(completeTaskSpy.mock.calls[0][1]).toBe('Manually completed');
    expect(completeTaskSpy.mock.calls[0][4]).toEqual({ force: true });
  });

  it('broadcasts task:completed immediately after the forced close', async () => {
    const { handle, ws, broadcasts } = makeDeps();

    await handle(ws, { type: 'task:complete', taskId: 't1' }, { login: 'tester' });

    const completedBroadcast = broadcasts.find((b) => b.type === 'task:completed');
    expect(completedBroadcast).toBeDefined();
    expect(completedBroadcast.task.id).toBe('t1');
    expect(completedBroadcast.task.status).toBe('completed');
  });

  it('does not broadcast task:completed when completeTask returns "pending"', async () => {
    const { handle, ws, broadcasts, completeTaskSpy } = makeDeps();
    completeTaskSpy.mockReturnValueOnce('pending');

    await handle(ws, { type: 'task:complete', taskId: 't1' }, { login: 'tester' });

    const completedBroadcast = broadcasts.find((b) => b.type === 'task:completed');
    expect(completedBroadcast).toBeUndefined();
    // completeTask was still called with { force: true } — the 'pending'
    // return path is the queue's signal that another resolution is in
    // flight, not the requireHumanClose veto we're guarding against.
    expect(completeTaskSpy).toHaveBeenCalledTimes(1);
    expect(completeTaskSpy.mock.calls[0][4]).toEqual({ force: true });
  });

  it('passes force:true even when the task has requireHumanClose set', async () => {
    // The requireHumanClose flag would have caused the old (non-force)
    // completeTask call to short-circuit and leave the task in 'pending'.
    // The force flag must bypass it; this test pins that behavior.
    const { handle, ws, completeTaskSpy } = makeDeps();
    // (sampleTask in makeDeps already has requireHumanClose: true)

    await handle(ws, { type: 'task:complete', taskId: 't1' }, { login: 'tester' });

    expect(completeTaskSpy).toHaveBeenCalledTimes(1);
    expect(completeTaskSpy.mock.calls[0][4]).toEqual({ force: true });
  });
});
