import { describe, it, expect, vi, beforeEach } from 'vitest';

import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';
import { createMockNode, createMockConfig } from '../../helpers/mocks.js';

/**
 * Tests for namePrefix-aware MCP session resolution.
 *
 * Bug: when config.sessions.namePrefix is set (e.g. "VIV-"), the spawned
 * mcp-server process is launched with --session VIV-1 (the full tmux name).
 * It forwards that string to the hive WS server, which previously did
 *   activeTaskBySession.get('VIV-1')
 * against a map keyed by integer (1) — every lookup missed and tools like
 * hive_get_task / hive_complete_task / hive_post_update silently failed.
 *
 * Fix: each MCP handler resolves msg.session through fleet.sessionNum +
 * config.sessions.namePrefix before doing any session-keyed lookup.
 */

function makeDeps(overrides = {}) {
  const config = createMockConfig({
    sessions: { namePrefix: overrides.namePrefix ?? '' },
  });
  const node = createMockNode();
  const router = {
    getNode: () => node,
    findNodeForSession: () => 'local',
    nodeIds: () => ['local'],
    listAllSessions: vi.fn().mockResolvedValue([]),
  };
  const sent = [];
  const broadcasts = [];
  const ws = {
    send: vi.fn((data) => sent.push(JSON.parse(data))),
    readyState: 1,
  };

  const tasks = new Map();
  const activeTaskBySession = new Map();
  const lastCompletedAt = new Map();
  const sessionContext = new Map();
  const feedEntries = [];

  const taskQueue = {
    tasks,
    activeTaskBySession,
    lastCompletedAt,
    designations: new Map(),
    pushFeed: vi.fn((type, session, detail) => feedEntries.push({ type, session, detail })),
    getSessionContext: vi.fn((s) => sessionContext.get(Number(s)) || {}),
    setSessionContext: vi.fn((s, updates) => {
      const num = Number(s);
      const merged = { ...(sessionContext.get(num) || {}), ...updates };
      sessionContext.set(num, merged);
      return merged;
    }),
    getAllSessionContexts: vi.fn(() => ({})),
    completeTask: vi.fn((taskId, summary) => {
      const t = tasks.get(taskId);
      if (!t) return null;
      t.status = 'done';
      t.summary = summary;
      activeTaskBySession.delete(t.assignedTo);
      lastCompletedAt.set(t.assignedTo, Date.now());
      return t;
    }),
    _saveState: vi.fn(),
  };

  const pmManager = {
    knowledge: [],
    addKnowledge: vi.fn(function (entry) { this.knowledge.push(entry); }),
    queryKnowledge: vi.fn(() => []),
    getAll: vi.fn(() => []),
    addLearnings: vi.fn(() => 0),
  };

  return {
    config, node, router, ws, sent, broadcasts, taskQueue, pmManager,
    tasks, activeTaskBySession, lastCompletedAt, sessionContext, feedEntries,
    deps: {
      config,
      taskQueue,
      pmManager,
      router,
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
    },
  };
}

function seedActiveTask(ctx, sessionNum, overrides = {}) {
  const id = overrides.id || `t-${sessionNum}`;
  const task = {
    id,
    text: overrides.text || `task for ${sessionNum}`,
    status: 'dispatched',
    assignedTo: sessionNum,
    designation: overrides.designation || null,
    source: overrides.source || null,
    checklist: [],
    ...overrides,
  };
  ctx.tasks.set(id, task);
  ctx.activeTaskBySession.set(sessionNum, id);
  return task;
}

describe('MCP namePrefix session resolution', () => {
  describe('mcp:get_task', () => {
    it('resolves prefixed session string to integer key', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      seedActiveTask(ctx, 1, { text: 'fix the prefix' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, { type: 'mcp:get_task', _reqId: 1, session: 'VIV-1' }, {});

      expect(ctx.sent[0].task).toMatchObject({ id: 't-1', text: 'fix the prefix' });
    });

    it('still works for non-prefixed integer session (regression)', async () => {
      const ctx = makeDeps({ namePrefix: '' });
      seedActiveTask(ctx, 3, { text: 'no prefix' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, { type: 'mcp:get_task', _reqId: 1, session: 3 }, {});

      expect(ctx.sent[0].task).toMatchObject({ id: 't-3' });
    });

    it('still works for digit-string session (regression)', async () => {
      const ctx = makeDeps({ namePrefix: '' });
      seedActiveTask(ctx, 7, {});
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, { type: 'mcp:get_task', _reqId: 1, session: '7' }, {});

      expect(ctx.sent[0].task).toMatchObject({ id: 't-7' });
    });

    it('returns null task for PM-name session (no fleet integer)', async () => {
      const ctx = makeDeps({ namePrefix: '' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, { type: 'mcp:get_task', _reqId: 1, session: 'hive-pm-2' }, {});

      expect(ctx.sent[0].task).toBe(null);
    });
  });

  describe('mcp:complete_task', () => {
    it('completes the task for a prefixed session', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      seedActiveTask(ctx, 1, {});
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:complete_task', _reqId: 1, session: 'VIV-1', summary: 'done',
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: true });
      expect(ctx.tasks.get('t-1').status).toBe('done');
      expect(ctx.tasks.get('t-1').summary).toBe('done');
    });

    it('falls back to lastCompletedAt cooldown for prefixed session', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      // simulate watcher already auto-completed the task
      const task = {
        id: 't-1', text: 'x', status: 'done', assignedTo: 1, summary: null, checklist: [],
      };
      ctx.tasks.set('t-1', task);
      ctx.lastCompletedAt.set(1, Date.now() - 5000); // 5s ago
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:complete_task', _reqId: 1, session: 'VIV-1', summary: 'late',
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: true });
      expect(task.summary).toBe('late');
    });

    it('returns no-active-task error for prefixed session with no task', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:complete_task', _reqId: 1, session: 'VIV-9', summary: '',
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: false, error: expect.stringContaining('No active task') });
    });
  });

  describe('mcp:post_update', () => {
    it('feed entry for prefixed session is keyed by integer', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:post_update', _reqId: 1, session: 'VIV-2', message: 'progress',
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: true });
      expect(ctx.feedEntries[0]).toMatchObject({ type: 'mcp', session: 2 });
      // Display label should also be the integer, not the prefixed string
      expect(ctx.feedEntries[0].detail).toContain('[Session 2]');
      expect(ctx.feedEntries[0].detail).not.toContain('VIV-2');
    });

    it('keeps PM-name session as-is in feed when no fleet integer', async () => {
      const ctx = makeDeps({ namePrefix: '' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:post_update', _reqId: 1, session: 'hive-pm-3', message: 'pm note',
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: true });
      expect(ctx.feedEntries[0].detail).toContain('hive-pm-3');
    });
  });

  describe('mcp:share_knowledge', () => {
    it('records integer sourceSession for prefixed input', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:share_knowledge', _reqId: 1, session: 'VIV-4',
        insight: 'always strip the prefix', domain: 'mcp', insightType: 'gotcha',
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: true });
      expect(ctx.pmManager.knowledge[0]).toMatchObject({
        insight: 'always strip the prefix',
        sourceSession: 4,
      });
    });
  });

  describe('mcp:set_working_dir', () => {
    it('stores override under integer key for prefixed session', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:set_working_dir', _reqId: 1, session: 'VIV-5',
        dir: '/tmp/wt5',
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: true, dir: '/tmp/wt5' });
      // The broadcast must use the integer session so dashboards can match it
      expect(ctx.broadcasts[0]).toMatchObject({
        type: 'working_dir:updated', session: 5, dir: '/tmp/wt5',
      });
    });
  });

  describe('mcp:set_context', () => {
    it('writes context under integer key for prefixed session', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:set_context', _reqId: 1, session: 'VIV-6',
        updates: { pr: 'https://github.com/o/r/pull/1' },
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: true });
      expect(ctx.sessionContext.get(6)).toMatchObject({ pr: 'https://github.com/o/r/pull/1' });
      expect(ctx.broadcasts[0]).toMatchObject({ type: 'context:updated', session: 6 });
    });

    it('rejects PM-name session — would otherwise corrupt session 0', async () => {
      // setSessionContext(null) coerces to Number(null) === 0 inside tq-features,
      // so a PM session could overwrite session 0's context. Guard against it.
      const ctx = makeDeps({ namePrefix: '' });
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:set_context', _reqId: 1, session: 'hive-pm-3',
        updates: { pr: 'evil' },
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: false });
      expect(ctx.sessionContext.has(0)).toBe(false);
    });
  });

  describe('mcp:report_learnings', () => {
    it('resolves prefixed session to find the active PM task', async () => {
      const ctx = makeDeps({ namePrefix: 'VIV-' });
      seedActiveTask(ctx, 1, { source: 'pm:Test PM' });
      ctx.pmManager.getAll = vi.fn(() => [{ id: 'pm1', name: 'Test PM' }]);
      ctx.pmManager.addLearnings = vi.fn(() => 2);
      const handler = createMessageHandler(ctx.deps);

      await handler(ctx.ws, {
        type: 'mcp:report_learnings', _reqId: 1, session: 'VIV-1',
        learnings: ['a', 'b'],
      }, {});

      expect(ctx.sent[0]).toMatchObject({ ok: true, added: 2 });
      expect(ctx.pmManager.addLearnings).toHaveBeenCalledWith('pm1', ['a', 'b']);
    });
  });
});
