import { describe, it, expect, vi } from 'vitest';

import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';
import { createMockConfig } from '../../helpers/mocks.js';

/**
 * Tests for the mcp:set_assignee handler — the server side of the
 * hive_set_assignee MCP tool. A session sets the assignee of its own active
 * task to one of hive's registered users (by login or display name), or clears
 * it. Unknown users are rejected so an agent can't stamp a task with a name
 * nobody can act on.
 */

const USERS = [
  { login: 'nukulb', name: 'Nukul B' },
  { login: 'ericfang', name: 'Eric Fang' },
];

function makeDeps({ namePrefix = '', users = USERS, withActiveTask = true } = {}) {
  const config = createMockConfig({ sessions: { namePrefix } });
  const tasks = new Map();
  const activeTaskBySession = new Map();
  if (withActiveTask) {
    const task = { id: 't-1', text: 'review PR', status: 'dispatched', assignee: null };
    tasks.set('t-1', task);
    activeTaskBySession.set(1, 't-1');
  }

  const taskQueue = {
    tasks,
    activeTaskBySession,
    getUsersList: vi.fn(() => users),
    updateTask: vi.fn((taskId, updates) => {
      const t = tasks.get(taskId);
      if (!t) return null;
      if ('assignee' in updates) t.assignee = updates.assignee;
      return t;
    }),
  };

  const sent = [];
  const broadcasts = [];
  const ws = { send: vi.fn((d) => sent.push(JSON.parse(d))), readyState: 1 };

  const deps = {
    config,
    taskQueue,
    pmManager: {},
    router: { getNode: () => ({}), findNodeForSession: () => 'local', nodeIds: () => ['local'] },
    broadcast: vi.fn((m) => broadcasts.push(m)),
    checkPermission: vi.fn().mockReturnValue(true),
    resolveSession: vi.fn(),
    clearTermSub: vi.fn(),
    clearConsoleSub: vi.fn(),
    termSubs: new Map(),
    consoleSubs: new Map(),
    clearCardSub: vi.fn(),
    clearAllCardSubs: vi.fn(),
    cardTermSubs: new Map(),
    sendFleetStatus: vi.fn(),
    broadcastFleetStatus: vi.fn(),
    sendInitialState: vi.fn(),
    _previewCache: new Map(),
    commands: new Map(),
    clients: new Set(),
    wsUser: new Map(),
    workers: new Map(),
    mcpClients: new Map(),
  };

  return { deps, ws, sent, broadcasts, tasks, taskQueue };
}

describe('mcp:set_assignee', () => {
  it('assigns the active task to a user matched by login', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(
      ctx.ws,
      { type: 'mcp:set_assignee', _reqId: 1, session: 1, assignee: 'nukulb' },
      {},
    );

    expect(ctx.sent[0]).toMatchObject({ ok: true, assignee: 'nukulb', name: 'Nukul B' });
    expect(ctx.tasks.get('t-1').assignee).toBe('nukulb');
    expect(ctx.broadcasts.some((b) => b.type === 'task:updated')).toBe(true);
  });

  it('matches a user by display name (case-insensitive) and stores the login', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(
      ctx.ws,
      { type: 'mcp:set_assignee', _reqId: 1, session: 1, assignee: 'eric fang' },
      {},
    );

    expect(ctx.sent[0]).toMatchObject({ ok: true, assignee: 'ericfang' });
    expect(ctx.tasks.get('t-1').assignee).toBe('ericfang');
  });

  it('resolves a prefixed session string before looking up the active task', async () => {
    const ctx = makeDeps({ namePrefix: 'VIV-' });
    const handler = createMessageHandler(ctx.deps);

    await handler(
      ctx.ws,
      { type: 'mcp:set_assignee', _reqId: 1, session: 'VIV-1', assignee: 'nukulb' },
      {},
    );

    expect(ctx.sent[0]).toMatchObject({ ok: true, assignee: 'nukulb' });
  });

  it('unassigns on empty string', async () => {
    const ctx = makeDeps();
    ctx.tasks.get('t-1').assignee = 'nukulb';
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, { type: 'mcp:set_assignee', _reqId: 1, session: 1, assignee: '' }, {});

    expect(ctx.sent[0]).toMatchObject({ ok: true, assignee: null });
    expect(ctx.tasks.get('t-1').assignee).toBe(null);
  });

  it('rejects an unknown user and lists the valid ones', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(
      ctx.ws,
      { type: 'mcp:set_assignee', _reqId: 1, session: 1, assignee: 'ghost' },
      {},
    );

    expect(ctx.sent[0].ok).toBe(false);
    expect(ctx.sent[0].error).toContain('ghost');
    expect(ctx.sent[0].error).toContain('nukulb');
    expect(ctx.taskQueue.updateTask).not.toHaveBeenCalled();
  });

  it('errors when the session has no active task', async () => {
    const ctx = makeDeps({ withActiveTask: false });
    const handler = createMessageHandler(ctx.deps);

    await handler(
      ctx.ws,
      { type: 'mcp:set_assignee', _reqId: 1, session: 1, assignee: 'nukulb' },
      {},
    );

    expect(ctx.sent[0].ok).toBe(false);
    expect(ctx.sent[0].error).toMatch(/no active task/i);
  });

  it('rejects a non-string assignee', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, { type: 'mcp:set_assignee', _reqId: 1, session: 1, assignee: 42 }, {});

    expect(ctx.sent[0].ok).toBe(false);
    expect(ctx.sent[0].error).toMatch(/string/i);
  });
});
