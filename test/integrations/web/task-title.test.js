import { describe, it, expect, vi } from 'vitest';

import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';

/**
 * Tests for the `title` field added to task:create and task:update WS messages.
 * The Create Task modal now accepts a short Title above Task Description;
 * the title is what the kanban board shows. updateTask's allow-list gates
 * title the same way it gates text — only mutable on queued/snoozed tasks.
 */

function makeDeps({ task } = {}) {
  const createTaskSpy = vi.fn((text, mode, targetSession, designation, meta) => ({
    id: 't1', text, mode, targetSession, designation, title: meta?.title || null, status: 'queued',
  }));
  const updateTaskSpy = vi.fn((taskId, updates) => {
    const t = task || { id: taskId, text: 'orig', title: null, status: 'queued' };
    const next = { ...t };
    if (t.status === 'queued' || t.status === 'snoozed') {
      for (const k of ['text', 'title', 'mode', 'targetSession', 'designation', 'actionContext']) {
        if (k in updates) next[k] = (k === 'title' && updates[k] === '') ? null : updates[k];
      }
    }
    return next;
  });

  const taskQueue = {
    createTask: createTaskSpy,
    updateTask: updateTaskSpy,
    tasks: new Map(task ? [[task.id, task]] : []),
    _saveState: () => {},
  };

  const ws = { readyState: 1, send: vi.fn() };
  const broadcasts = [];

  const handle = createMessageHandler({
    config: { sessions: { claudePane: 1, namePrefix: '' } },
    taskQueue,
    pmManager: null,
    router: { getNode: () => null },
    broadcast: (msg) => broadcasts.push(msg),
    checkPermission: () => true,
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

  return { handle, ws, broadcasts, createTaskSpy, updateTaskSpy };
}

describe('task:create — title field', () => {
  it('forwards msg.title via createTask meta', async () => {
    const { handle, createTaskSpy } = makeDeps();

    await handle(
      { readyState: 1, send: vi.fn() },
      { type: 'task:create', text: 'Long prompt body', title: 'Short title', mode: 'auto' },
      { login: 'tester' }
    );

    expect(createTaskSpy).toHaveBeenCalledTimes(1);
    const meta = createTaskSpy.mock.calls[0][4];
    expect(meta.title).toBe('Short title');
  });

  it('passes null when msg.title is omitted', async () => {
    const { handle, createTaskSpy } = makeDeps();

    await handle(
      { readyState: 1, send: vi.fn() },
      { type: 'task:create', text: 'No title here', mode: 'auto' },
      { login: 'tester' }
    );

    expect(createTaskSpy.mock.calls[0][4].title).toBeNull();
  });

  it('passes null when msg.title is empty string', async () => {
    const { handle, createTaskSpy } = makeDeps();

    await handle(
      { readyState: 1, send: vi.fn() },
      { type: 'task:create', text: 'Empty title', title: '', mode: 'auto' },
      { login: 'tester' }
    );

    expect(createTaskSpy.mock.calls[0][4].title).toBeNull();
  });

  it('sends task:created response carrying the title', async () => {
    const { handle } = makeDeps();
    const replyWs = { readyState: 1, send: vi.fn() };

    await handle(
      replyWs,
      { type: 'task:create', text: 'Prompt', title: 'My title', mode: 'auto' },
      { login: 'tester' }
    );

    const sent = replyWs.send.mock.calls.map(c => JSON.parse(c[0]));
    const created = sent.find(m => m.type === 'task:created');
    expect(created).toBeDefined();
    expect(created.task.title).toBe('My title');
  });
});

describe('task:update — title field', () => {
  it('passes updates.title through to updateTask on a queued task', async () => {
    const queuedTask = { id: 't42', text: 'orig text', title: null, status: 'queued' };
    const { handle, updateTaskSpy } = makeDeps({ task: queuedTask });

    await handle(
      { readyState: 1, send: vi.fn() },
      { type: 'task:update', taskId: 't42', updates: { title: 'Renamed' } },
      { login: 'tester' }
    );

    expect(updateTaskSpy).toHaveBeenCalledWith('t42', expect.objectContaining({ title: 'Renamed' }));
  });

  it('broadcasts task:updated with the new title', async () => {
    const queuedTask = { id: 't42', text: 'orig', title: null, status: 'queued' };
    const { handle, broadcasts } = makeDeps({ task: queuedTask });

    await handle(
      { readyState: 1, send: vi.fn() },
      { type: 'task:update', taskId: 't42', updates: { title: 'New' } },
      { login: 'tester' }
    );

    const updated = broadcasts.find(b => b.type === 'task:updated');
    expect(updated).toBeDefined();
    expect(updated.task.title).toBe('New');
  });

  it('does not change title on a dispatched task (allow-list gate)', async () => {
    const dispatchedTask = { id: 't99', text: 'orig', title: 'Before', status: 'dispatched' };
    const { handle, broadcasts } = makeDeps({ task: dispatchedTask });

    await handle(
      { readyState: 1, send: vi.fn() },
      { type: 'task:update', taskId: 't99', updates: { title: 'Should be ignored' } },
      { login: 'tester' }
    );

    const updated = broadcasts.find(b => b.type === 'task:updated');
    expect(updated.task.title).toBe('Before');
  });
});
