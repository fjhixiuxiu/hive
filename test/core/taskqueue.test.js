import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockWatcher, createMockNode } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const fleetModule = require('../../src/core/fleet');
const relayModule = require('../../src/core/relay');
const logModule = require('../../src/core/log');
const sessionManagerModule = require('../../src/core/session-manager');
const TaskQueue = require('../../src/core/taskqueue');
const NodeRouter = require('../../src/core/node-router');

describe('TaskQueue', () => {
  let tq, config, watcher, router;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    // Spy on dependencies so CJS require() picks up the mocks
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(relayModule, 'ask').mockResolvedValue({ success: true, response: 'done' });
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManagerModule, 'createSession').mockRejectedValue(new Error('no tmux in test'));
    vi.spyOn(sessionManagerModule, 'startClaude').mockResolvedValue();

    config = createMockConfig();
    watcher = createMockWatcher();
    router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(config, watcher, router);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('createTask', () => {
    it('returns task with id, text, status=queued', () => {
      const task = tq.createTask('Fix the bug', 'auto', null, null);
      expect(task.id).toBeDefined();
      expect(task.text).toBe('Fix the bug');
      expect(task.status).toBe('queued');
      expect(task.mode).toBe('auto');
    });

    it('sets designation filter', () => {
      const task = tq.createTask('Review PR', 'auto', null, 'reviewer');
      expect(task.designation).toBe('reviewer');
    });

    it('emits task:created event', () => {
      const spy = vi.fn();
      tq.on('task:created', spy);
      tq.createTask('Test', 'auto', null, null);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('stores meta fields', () => {
      const task = tq.createTask('Fix CI', 'manual', 6, null, {
        source: 'ci-fail', pr: '42', session: 6, createdBy: 'john',
      });
      expect(task.source).toBe('ci-fail');
      expect(task.sourcePR).toBe('42');
      expect(task.createdBy).toBe('john');
    });
  });

  describe('cancelTask', () => {
    it('marks task as cancelled', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      const result = tq.cancelTask(task.id);
      expect(result.status).toBe('cancelled');
    });

    it('returns null for non-existent task', () => {
      expect(tq.cancelTask('999')).toBeNull();
    });
  });

  describe('completeTask', () => {
    it('marks dispatched task as completed', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.dispatchedAt = Date.now();
      tq.activeTaskBySession.set(6, task.id);

      const result = tq.completeTask(task.id, 'Done!');
      expect(result.status).toBe('completed');
      expect(result.result).toBe('Done!');
      expect(tq.activeTaskBySession.has(6)).toBe(false);
    });

    it('clears dispatch lock', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      tq.dispatchLock.add(6);
      tq.activeTaskBySession.set(6, task.id);
      tq.completeTask(task.id);
      expect(tq.dispatchLock.has(6)).toBe(false);
    });

    it('returns null for non-dispatched task', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      expect(tq.completeTask(task.id)).toBeNull();
    });

    it('stores snapshot data', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.dispatchedAt = Date.now();
      tq.activeTaskBySession.set(6, task.id);
      tq.completeTask(task.id, null, 'ansi-snapshot', 120);
      expect(task.snapshot).toBe('ansi-snapshot');
      expect(task.snapshotCols).toBe(120);
    });
  });

  describe('failTask', () => {
    it('marks task as failed', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      tq.activeTaskBySession.set(6, task.id);
      const result = tq.failTask(task.id, 'Crashed');
      expect(result.status).toBe('failed');
      expect(result.result).toBe('Crashed');
    });
  });

  describe('taskAutoComplete', () => {
    it('defaults to true', () => {
      expect(tq.taskAutoComplete).toBe(true);
    });

    it('auto-completes auto task on idle when enabled', () => {
      tq.taskAutoComplete = true;
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.dispatchedAt = Date.now();
      tq.activeTaskBySession.set(6, task.id);

      tq._handleSessionIdle(6, null, null);
      expect(task.status).toBe('completed');
    });

    it('does NOT auto-complete auto task on idle when disabled', () => {
      tq.taskAutoComplete = false;
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.dispatchedAt = Date.now();
      tq.activeTaskBySession.set(6, task.id);

      tq._handleSessionIdle(6, null, null);
      expect(task.status).toBe('dispatched');
    });

    it('never auto-completes manual tasks regardless of setting', () => {
      tq.taskAutoComplete = true;
      const task = tq.createTask('Test', 'manual', 6, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.dispatchedAt = Date.now();
      tq.activeTaskBySession.set(6, task.id);

      tq._handleSessionIdle(6, null, null);
      expect(task.status).toBe('dispatched');
    });
  });

  describe('requeueTask', () => {
    it('moves dispatched task back to queued', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.dispatchedAt = Date.now();
      tq.activeTaskBySession.set(6, task.id);
      tq.dispatchLock.add(6);

      const result = tq.requeueTask(task.id);
      expect(result.status).toBe('queued');
      expect(result.assignedTo).toBeNull();
      expect(result.dispatchedAt).toBeNull();
      expect(result.targetSession).toBeNull();
    });

    it('clears activeTaskBySession and dispatchLock', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      tq.activeTaskBySession.set(6, task.id);
      tq.dispatchLock.add(6);

      tq.requeueTask(task.id);
      expect(tq.activeTaskBySession.has(6)).toBe(false);
      expect(tq.dispatchLock.has(6)).toBe(false);
    });

    it('emits task:requeued event', () => {
      const spy = vi.fn();
      tq.on('task:requeued', spy);
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      tq.activeTaskBySession.set(6, task.id);

      tq.requeueTask(task.id);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(task);
    });

    it('returns null for non-dispatched task', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      expect(tq.requeueTask(task.id)).toBeNull();
    });

    it('returns null for non-existent task', () => {
      expect(tq.requeueTask('999')).toBeNull();
    });

    it('adds feed entry', () => {
      const task = tq.createTask('Requeue me', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      tq.activeTaskBySession.set(6, task.id);
      const feedBefore = tq.feed.length;

      tq.requeueTask(task.id);
      expect(tq.feed.length).toBeGreaterThan(feedBefore);
      const lastEntry = tq.feed[tq.feed.length - 1];
      expect(lastEntry.detail).toContain('returned to queue');
    });
  });

  describe('renameTask', () => {
    it('updates task text on a queued task', () => {
      const task = tq.createTask('Original title', 'auto', null, null);
      const renamed = tq.renameTask(task.id, 'New title');
      expect(renamed).not.toBeNull();
      expect(renamed.text).toBe('New title');
      expect(tq.tasks.get(task.id).text).toBe('New title');
    });

    it('updates task text on a dispatched task', () => {
      const task = tq.createTask('Original title', 'manual', null, null);
      task.status = 'dispatched';
      task.assignedTo = 1;
      const renamed = tq.renameTask(task.id, 'Dispatched rename');
      expect(renamed).not.toBeNull();
      expect(renamed.text).toBe('Dispatched rename');
    });

    it('updates task text on a snoozed task', () => {
      const task = tq.createTask('Snooze me', 'auto', null, null);
      task.status = 'snoozed';
      const renamed = tq.renameTask(task.id, 'Snoozed rename');
      expect(renamed).not.toBeNull();
      expect(renamed.text).toBe('Snoozed rename');
    });

    it('returns null for non-existent task', () => {
      expect(tq.renameTask('999', 'anything')).toBeNull();
    });

    it('returns null for empty text', () => {
      const task = tq.createTask('Original', 'auto', null, null);
      expect(tq.renameTask(task.id, '')).toBeNull();
      expect(tq.renameTask(task.id, '   ')).toBeNull();
      expect(tq.tasks.get(task.id).text).toBe('Original');
    });

    it('returns null for non-string text', () => {
      const task = tq.createTask('Original', 'auto', null, null);
      expect(tq.renameTask(task.id, null)).toBeNull();
      expect(tq.renameTask(task.id, undefined)).toBeNull();
      expect(tq.tasks.get(task.id).text).toBe('Original');
    });

    it('trims whitespace from new title', () => {
      const task = tq.createTask('Original', 'auto', null, null);
      const renamed = tq.renameTask(task.id, '  Trimmed title  ');
      expect(renamed.text).toBe('Trimmed title');
    });

    it('emits task:updated event', () => {
      const task = tq.createTask('Original', 'auto', null, null);
      const handler = vi.fn();
      tq.on('task:updated', handler);
      tq.renameTask(task.id, 'Updated');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: 'Updated' }));
    });

    it('persists state after rename', () => {
      const task = tq.createTask('Original', 'auto', null, null);
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      writeSpy.mockClear();
      tq.renameTask(task.id, 'Persisted');
      expect(writeSpy).toHaveBeenCalled();
    });
  });

  describe('feed', () => {
    it('adds entries on task operations', () => {
      tq.createTask('Test task', 'auto', null, null);
      expect(tq.feed.length).toBeGreaterThan(0);
    });

    it('getFeed with pagination', () => {
      for (let i = 0; i < 5; i++) tq.pushFeed('test', null, `Entry ${i}`);
      const { entries } = tq.getFeed(null, 3);
      expect(entries).toHaveLength(3);
    });
  });

  describe('toggleAutoSession', () => {
    it('toggles auto-mode on and off', () => {
      tq.toggleAutoSession(6);
      expect(tq.autoSessions.has(6)).toBe(true);
      tq.toggleAutoSession(6);
      expect(tq.autoSessions.has(6)).toBe(false);
    });

    it('emits auto:changed event', () => {
      const spy = vi.fn();
      tq.on('auto:changed', spy);
      tq.toggleAutoSession(6);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('auto-dispatch', () => {
    it('dispatches queued task to idle auto-session', async () => {
      vi.useRealTimers(); // real timers for async dispatch
      tq.autoSessions.add(6);

      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);
      fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });

      tq.createTask('Fix bug', 'auto', null, null);

      // Wait for async dispatch chain to resolve
      await new Promise(r => setTimeout(r, 50));

      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Fix bug');
      expect(task.status).toBe('dispatched');
      expect(task.assignedTo).toBe(6);
    });

    it('does not dispatch to session without matching designation', async () => {
      tq.autoSessions.add(6);
      tq.designations.set(6, 'coder');
      tq.createTask('Review PR', 'auto', null, 'reviewer');
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);

      await tq._tryAutoDispatch();
      const tasks = Array.from(tq.tasks.values());
      const task = tasks.find(t => t.text === 'Review PR');
      expect(task.status).toBe('queued');
    });

    it('falls back to undesignated session for designated task', async () => {
      vi.useRealTimers();
      tq.autoSessions.add(6);
      // session 6 has no designation
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);
      fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });
      tq.createTask('Review PR', 'auto', null, 'reviewer');

      await new Promise(r => setTimeout(r, 50));
      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Review PR');
      expect(task.status).toBe('dispatched');
      expect(task.assignedTo).toBe(6);
    });

    it('prefers matching designation over undesignated fallback', async () => {
      vi.useRealTimers();
      tq.autoSessions.add(6);
      tq.autoSessions.add(7);
      tq.designations.set(7, 'reviewer');
      // session 6 = undesignated, session 7 = reviewer
      // Make session 6 idle longer so LRU would pick it first
      tq.lastDispatchedAt.set(6, 0);
      tq.lastDispatchedAt.set(7, 1000);
      fleetModule.getFleetStatus.mockResolvedValue([
        { name: '6-DEV', num: 6, state: 'idle' },
        { name: '7-REV', num: 7, state: 'idle' },
      ]);
      fleetModule.findSession.mockResolvedValue({ name: '7-REV', nodeId: 'local' });
      tq.createTask('Review PR', 'auto', null, 'reviewer');

      await new Promise(r => setTimeout(r, 50));
      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Review PR');
      expect(task.status).toBe('dispatched');
      expect(task.assignedTo).toBe(7);
    });

    it('does not dispatch undesignated task to designated session', async () => {
      tq.autoSessions.add(6);
      tq.designations.set(6, 'reviewer');
      tq.createTask('Fix bug', 'auto', null, null);
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);

      await tq._tryAutoDispatch();
      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Fix bug');
      expect(task.status).toBe('queued');
    });

    it('strict designationMatch skips undesignated fallback', async () => {
      tq.autoSessions.add(6);
      // session 6 is undesignated
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);

      // Set up a PM with strict matching
      tq._pmManager = {
        pms: new Map([['1', { name: 'StrictPM', designationMatch: 'strict' }]]),
      };
      tq.createTask('Review PR', 'auto', null, 'reviewer', { source: 'pm:StrictPM' });

      await tq._tryAutoDispatch();
      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Review PR');
      expect(task.status).toBe('queued'); // should NOT fall back to undesignated
    });

    it('strict designationMatch dispatches to matching session', async () => {
      vi.useRealTimers();
      tq.autoSessions.add(6);
      tq.designations.set(6, 'reviewer');
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);
      fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });

      tq._pmManager = {
        pms: new Map([['1', { name: 'StrictPM', designationMatch: 'strict' }]]),
      };
      tq.createTask('Review PR', 'auto', null, 'reviewer', { source: 'pm:StrictPM' });

      await new Promise(r => setTimeout(r, 50));
      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Review PR');
      expect(task.status).toBe('dispatched');
      expect(task.assignedTo).toBe(6);
    });

    it('flexible designationMatch (default) falls back to undesignated', async () => {
      vi.useRealTimers();
      tq.autoSessions.add(6);
      // session 6 is undesignated
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);
      fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });

      tq._pmManager = {
        pms: new Map([['1', { name: 'FlexPM', designationMatch: 'flexible' }]]),
      };
      tq.createTask('Review PR', 'auto', null, 'reviewer', { source: 'pm:FlexPM' });

      await new Promise(r => setTimeout(r, 50));
      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Review PR');
      expect(task.status).toBe('dispatched');
      expect(task.assignedTo).toBe(6);
    });

    it('does not dispatch to non-auto session', async () => {
      tq.createTask('Fix bug', 'auto', null, null);
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);

      await tq._tryAutoDispatch();
      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Fix bug');
      expect(task.status).toBe('queued');
    });

    it('respects dispatch lock', async () => {
      tq.autoSessions.add(6);
      tq.dispatchLock.add(6);
      tq.createTask('Fix bug', 'auto', null, null);
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);

      await tq._tryAutoDispatch();
      const task = Array.from(tq.tasks.values()).find(t => t.text === 'Fix bug');
      expect(task.status).toBe('queued');
    });

    it('dispatched prompt includes BOTH agent file and PM enrichment (instructions + MCP)', async () => {
      // Regression: a prior bug reassigned fullMessage to raw task.text when the
      // designation had agent files, silently dropping PM instructions and the
      // MCP block. The dispatched prompt must contain both pieces.
      //
      // This test drives _dispatchTask directly rather than via the auto-dispatch
      // loop so it's isolated from fleet/idle/cooldown concerns and fast.
      vi.useRealTimers();
      // Short-circuit the hardcoded 2500ms sleep between /clear and the real
      // prompt so the fire-and-forget sendTask chain resolves inside the test.
      const realSetTimeout = global.setTimeout;
      vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
        // Fire the callback on next tick regardless of requested ms
        return realSetTimeout(fn, 0);
      });

      // Agent file on disk — override the default ENOENT mock for this one path
      const AGENT_FILE_PATH = '/fake/agents/cherrypick.md';
      const AGENT_FILE_BODY = '# Cherry Pick Agent\n\nFollow the cherry pick playbook.';
      fs.readFileSync.mockImplementation((p) => {
        if (p === AGENT_FILE_PATH) return AGENT_FILE_BODY;
        throw new Error('ENOENT');
      });

      // Minimal PM manager stub — matches the shape taskqueue.js consumes
      // (enrichTaskText for dispatch, serialize for _saveState). Mirrors the
      // real _buildFullText behavior for the fields under test.
      tq._pmManager = {
        pms: new Map(),
        serialize: () => ({ pms: [], knowledgeBase: [] }),
        enrichTaskText(task) {
          let result = task.text;
          result += '\n\nInstructions: Review the diff and cherry pick matching commits.';
          result += '\n\n## Hive Integration\n\nUse hive_get_task to see your full assignment.';
          return result;
        },
      };

      // Wire a designation with the agent file and assign it to session 6
      tq.setDesignationDef('cherrypick', {
        agentFiles: [AGENT_FILE_PATH],
        description: 'Cherry picks',
        color: 'red',
      });
      tq.designations.set(6, 'cherrypick');

      // Session 6 is idle and resolvable to a real node
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-CP', num: 6, state: 'idle' }]);
      fleetModule.findSession.mockResolvedValue({ name: '6-CP', nodeId: 'local' });

      // Build a task directly (skip createTask's auto-dispatch side-effects)
      // and dispatch it synchronously via _dispatchTask.
      const task = {
        id: 'test-1',
        text: 'Cherry pick DEV-12345',
        mode: 'auto',
        designation: 'cherrypick',
        status: 'queued',
        source: 'pm:release',
        assignedTo: null,
        createdAt: Date.now(),
      };
      tq.tasks.set(task.id, task);
      await tq._dispatchTask(task, 6);
      // Flush microtasks for the fire-and-forget sendTask chain
      await new Promise(r => realSetTimeout(r, 10));

      // relay.tell is called twice per dispatch: once for /clear, once for the
      // real prompt. Find the non-/clear call and inspect its message.
      const tellCalls = relayModule.tell.mock.calls;
      const promptCall = tellCalls.find(args => args[3] !== '/clear');
      expect(promptCall, 'expected relay.tell to be called with the task prompt').toBeDefined();

      const sentMessage = promptCall[3];

      // Agent file content must survive
      expect(sentMessage).toContain('# Cherry Pick Agent');
      expect(sentMessage).toContain('Follow the cherry pick playbook.');
      // TASK section with raw task text must be present
      expect(sentMessage).toContain('TASK:');
      expect(sentMessage).toContain('Cherry pick DEV-12345');
      // PM enrichment must NOT be silently dropped
      expect(sentMessage).toContain('Instructions: Review the diff and cherry pick matching commits.');
      expect(sentMessage).toContain('## Hive Integration');
      expect(sentMessage).toContain('hive_get_task');
    });
  });

  describe('approvals', () => {
    it('creates approval', () => {
      const a = tq.createApproval(6, 'Proceed?');
      expect(a.session).toBe(6);
      expect(a.status).toBe('pending');
    });

    it('prevents duplicate pending for same session', () => {
      const a1 = tq.createApproval(6, 'Proceed?');
      const a2 = tq.createApproval(6, 'Again?');
      expect(a1.id).toBe(a2.id);
    });

    it('resolveApproval sends key via tmux', async () => {
      const node = createMockNode();
      router.addNode(node);
      fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });

      const a = tq.createApproval(6, 'Proceed?');
      await tq.resolveApproval(a.id, true);
      expect(a.status).toBe('approved');
    });

    it('getPendingApprovals returns only pending', () => {
      tq.createApproval(6, 'A');
      tq.createApproval(7, 'B');
      expect(tq.getPendingApprovals()).toHaveLength(2);
    });
  });

  describe('designations', () => {
    it('setDesignation sets and clears', () => {
      tq.setDesignation(6, 'reviewer');
      expect(tq.designations.get(6)).toBe('reviewer');
      tq.setDesignation(6, null);
      expect(tq.designations.has(6)).toBe(false);
    });

    it('emits designations:changed', () => {
      const spy = vi.fn();
      tq.on('designations:changed', spy);
      tq.setDesignation(6, 'coder');
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('designation definitions', () => {
    it('setDesignationDef stores color', () => {
      const def = tq.setDesignationDef('reviews', { agentFiles: [], description: 'PR reviews', color: 'purple' });
      expect(def.color).toBe('purple');
      expect(def.name).toBe('reviews');
      expect(def.description).toBe('PR reviews');
    });

    it('defaults color to orange when not provided', () => {
      const def = tq.setDesignationDef('coder', { agentFiles: [], description: '' });
      expect(def.color).toBe('orange');
    });

    it('getDesignationDefs returns all defs with color', () => {
      tq.setDesignationDef('reviews', { agentFiles: [], description: '', color: 'cyan' });
      tq.setDesignationDef('tests', { agentFiles: [], description: '', color: 'green' });
      const defs = tq.getDesignationDefs();
      expect(defs).toHaveLength(2);
      expect(defs[0].color).toBe('cyan');
      expect(defs[1].color).toBe('green');
    });

    it('emits designationDefs:changed', () => {
      const spy = vi.fn();
      tq.on('designationDefs:changed', spy);
      tq.setDesignationDef('reviews', { agentFiles: [], description: '', color: 'pink' });
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0][0].color).toBe('pink');
    });

    it('removeDesignationDef removes def and clears assignments', () => {
      tq.setDesignationDef('reviews', { agentFiles: [], description: '', color: 'red' });
      tq.setDesignation(6, 'reviews');
      tq.removeDesignationDef('reviews');
      expect(tq.getDesignationDefs()).toHaveLength(0);
      expect(tq.designations.has(6)).toBe(false);
    });
  });

  describe('rules', () => {
    it('idle-next-task triggers auto-dispatch', () => {
      tq.rules.find(r => r.id === 'idle-next-task').enabled = true;
      const spy = vi.spyOn(tq, '_tryAutoDispatch').mockResolvedValue();
      tq.evaluateRules('session:idle', { num: 6 });
      expect(spy).toHaveBeenCalled();
    });

    it('ci-fail-fix creates fix task', () => {
      tq.rules.find(r => r.id === 'ci-fail-fix').enabled = true;
      tq.autoSessions.add(6);
      const spy = vi.fn();
      tq.on('task:created', spy);
      tq.evaluateRules('ci:fail', { num: 6, pr: '42' });
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0].text).toContain('CI failed');
    });

    it('review-changes creates fix task', () => {
      tq.rules.find(r => r.id === 'review-changes').enabled = true;
      tq.autoSessions.add(6);
      const spy = vi.fn();
      tq.on('task:created', spy);
      tq.evaluateRules('review:changes_requested', { num: 6, pr: '42' });
      expect(spy).toHaveBeenCalled();
    });

    it('disabled rules do not trigger', () => {
      tq.rules.find(r => r.id === 'ci-fail-fix').enabled = false;
      const spy = vi.fn();
      tq.on('task:created', spy);
      tq.evaluateRules('ci:fail', { num: 6, pr: '42' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('toggleRule toggles enabled state', () => {
      const rule = tq.rules.find(r => r.id === 'ci-fail-fix');
      expect(rule.enabled).toBe(false);
      tq.toggleRule('ci-fail-fix');
      expect(rule.enabled).toBe(true);
    });
  });

  describe('vimMode', () => {
    it('setVimMode toggles vim mode', () => {
      tq.setVimMode(true);
      expect(tq.vimMode).toBe(true);
      tq.setVimMode(false);
      expect(tq.vimMode).toBe(false);
    });
  });

  describe('users', () => {
    it('ensureUser creates a new user', () => {
      const user = tq.ensureUser('john', 'John Doe', 'av.png');
      expect(user.login).toBe('john');
      expect(user.name).toBe('John Doe');
    });

    it('first user gets admin permissions', () => {
      expect(tq.users.size).toBe(0);
      const user = tq.ensureUser('someone', 'Someone', '');
      expect(user.permissions).toContain('admin');
    });

    it('HIVE_ADMIN_USER gets admin permissions', () => {
      process.env.HIVE_ADMIN_USER = 'boss';
      tq.ensureUser('first', 'First', ''); // take the first-user slot
      const user = tq.ensureUser('boss', 'Boss', '');
      expect(user.permissions).toContain('admin');
      delete process.env.HIVE_ADMIN_USER;
    });

    it('subsequent users get viewer permissions', () => {
      tq.ensureUser('admin', 'Admin', ''); // first user = admin
      const user = tq.ensureUser('viewer', 'Viewer', '');
      expect(user.permissions).toEqual(['view', 'comment']);
    });

    it('HIVE_ADMIN_USER match is case-insensitive', () => {
      process.env.HIVE_ADMIN_USER = 'MyAdmin';
      tq.ensureUser('first', 'First', '');
      const user = tq.ensureUser('myadmin', 'My Admin', '');
      expect(user.permissions).toContain('admin');
      delete process.env.HIVE_ADMIN_USER;
    });

    it('hasPermission checks permission list', () => {
      tq.ensureUser('admin', 'Admin', ''); // first user = admin
      expect(tq.hasPermission('admin', 'create-tasks')).toBe(true);
      expect(tq.hasPermission('nobody', 'view')).toBe(false);
    });
  });

  describe('comments', () => {
    it('addComment adds comment to task', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      const c = tq.addComment(task.id, 'john', 'John', 'Nice!');
      expect(c.text).toBe('Nice!');
      expect(task.comments).toHaveLength(1);
    });

    it('returns null for non-existent task', () => {
      expect(tq.addComment('999', 'j', 'J', 'x')).toBeNull();
    });
  });

  describe('watcher integration', () => {
    it('session:idle completes active auto task', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.dispatchedAt = Date.now();
      tq.activeTaskBySession.set(6, task.id);
      tq.dispatchLock.add(6);

      watcher.emit('session:idle', { session: {}, name: '6-DEV', num: 6, preview: 'done' });
      expect(task.status).toBe('completed');
    });

    it('session:idle does NOT complete manual task', () => {
      const task = tq.createTask('Test', 'manual', 6, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.mode = 'manual';
      tq.activeTaskBySession.set(6, task.id);

      watcher.emit('session:idle', { session: {}, name: '6-DEV', num: 6, preview: 'done' });
      expect(task.status).toBe('dispatched');
    });

    it('session:working updates lastActivityAt', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      task.lastActivityAt = 0;
      tq.activeTaskBySession.set(6, task.id);

      watcher.emit('session:working', { session: {}, name: '6-DEV', num: 6 });
      expect(task.lastActivityAt).toBeGreaterThan(0);
    });

    it('approval:requested creates approval', () => {
      watcher.emit('approval:requested', { session: {}, name: '6-DEV', num: 6, prompt: 'Allow?' });
      expect(tq.getPendingApprovals()).toHaveLength(1);
    });

    it('ci:changed with FAILURE evaluates ci:fail rules', () => {
      tq.rules.find(r => r.id === 'ci-fail-fix').enabled = true;
      tq.autoSessions.add(6);
      const spy = vi.fn();
      tq.on('task:created', spy);

      watcher.emit('ci:changed', {
        session: {}, name: '6-DEV', num: 6,
        from: 'SUCCESS', to: 'FAILURE', pr: '42',
      });
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('checklist', () => {
    it('setChecklistTemplate creates template', () => {
      const tpl = tq.setChecklistTemplate('review', ['Check tests', 'Check lint']);
      expect(tpl.items).toHaveLength(2);
    });

    it('addChecklistItem adds item', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      tq.addChecklistItem(task.id, 'Run tests');
      expect(task.checklist).toHaveLength(1);
      expect(task.checklist[0].checked).toBe(false);
    });

    it('toggleChecklistItem toggles state', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      tq.addChecklistItem(task.id, 'Run tests');
      tq.toggleChecklistItem(task.id, task.checklist[0].id);
      expect(task.checklist[0].checked).toBe(true);
    });
  });

  describe('getTasksList', () => {
    it('excludes cancelled tasks', () => {
      const t1 = tq.createTask('Keep', 'auto', null, null);
      const t2 = tq.createTask('Remove', 'auto', null, null);
      tq.cancelTask(t2.id);
      const list = tq.getTasksList();
      expect(list.find(t => t.id === t1.id)).toBeDefined();
      expect(list.find(t => t.id === t2.id)).toBeUndefined();
    });
  });

  describe('getQueuePosition', () => {
    it('returns position in queue', () => {
      const t1 = tq.createTask('First', 'auto', null, null);
      const t2 = tq.createTask('Second', 'auto', null, null);
      expect(tq.getQueuePosition(t1.id)).toBe(1);
      expect(tq.getQueuePosition(t2.id)).toBe(2);
    });

    it('returns null for non-queued task', () => {
      expect(tq.getQueuePosition('999')).toBeNull();
    });
  });

  describe('spawnSession', () => {
    it('throws if name is missing', async () => {
      await expect(tq.spawnSession({})).rejects.toThrow('Agent name is required');
    });

    it('throws when slot is occupied', async () => {
      fleetModule.getFleetStatus.mockResolvedValue([{ num: 5, state: 'idle' }]);
      await expect(tq.spawnSession({ num: 5, name: 'test' })).rejects.toThrow('Slot 5 is already occupied');
    });

    it('throws when slot is out of range', async () => {
      fleetModule.getFleetStatus.mockResolvedValue([]);
      await expect(tq.spawnSession({ num: 999, name: 'test' })).rejects.toThrow('Spawn slots must be');
    });

    it('throws when no slots available for auto-pick', async () => {
      // Fill all slots
      const allSessions = [];
      for (let i = tq.spawnSlotMin; i <= tq.spawnSlotMax; i++) {
        allSessions.push({ num: i, state: 'working' });
      }
      fleetModule.getFleetStatus.mockResolvedValue(allSessions);
      await expect(tq.spawnSession({ name: 'test' })).rejects.toThrow('No available slots');
    });
  });

  describe('cleanupSession', () => {
    it('fails active task and clears all tracking', () => {
      const task = tq.createTask('Test', 'auto', null, null);
      task.status = 'dispatched';
      task.assignedTo = 6;
      tq.activeTaskBySession.set(6, task.id);
      tq.dispatchLock.add(6);
      tq.autoSessions.add(6);

      tq.cleanupSession(6);
      expect(task.status).toBe('failed');
      expect(tq.activeTaskBySession.has(6)).toBe(false);
      expect(tq.dispatchLock.has(6)).toBe(false);
      expect(tq.autoSessions.has(6)).toBe(false);
    });
  });

  describe('respawnAll', () => {
    it('attempts to respawn dead sessions and captures failures', async () => {
      tq.spawnedAgents.set(5, { repoDir: '/tmp/nonexistent5', name: 'bot' });
      tq.spawnedAgents.set(6, { repoDir: '/tmp/nonexistent6', name: 'bot' });
      // No sessions running
      fleetModule.getFleetStatus.mockResolvedValue([]);

      const results = await tq.respawnAll();
      // In test env, tmuxinator isn't available so both should fail
      // The key thing: dead sessions are attempted, not skipped
      expect(results.skipped).toEqual([]);
      const attemptedNums = [...results.respawned, ...results.failed.map(f => f.num)].sort();
      expect(attemptedNums).toEqual([5, 6]);
    });

    it('skips sessions that are already running', async () => {
      tq.spawnedAgents.set(5, { repoDir: '/tmp/test5', name: 'bot' });
      tq.spawnedAgents.set(6, { repoDir: '/tmp/test6', name: 'bot' });
      // Both sessions already running
      fleetModule.getFleetStatus.mockResolvedValue([
        { num: 5, state: 'idle' },
        { num: 6, state: 'working' },
      ]);

      const results = await tq.respawnAll();
      expect(results.respawned).toEqual([]);
      expect(results.skipped).toEqual([5, 6]);
      expect(results.failed).toEqual([]);
    });

    it('returns empty results when no spawned agents', async () => {
      fleetModule.getFleetStatus.mockResolvedValue([]);
      const results = await tq.respawnAll();
      expect(results.respawned).toEqual([]);
      expect(results.skipped).toEqual([]);
      expect(results.failed).toEqual([]);
    });

    it('mixes skipped and attempted for partial fleet', async () => {
      tq.spawnedAgents.set(5, { repoDir: '/tmp/test5', name: 'alpha' });
      tq.spawnedAgents.set(6, { repoDir: '/tmp/test6', name: 'beta' });
      // Only slot 5 is running
      fleetModule.getFleetStatus.mockResolvedValue([{ num: 5, state: 'idle' }]);

      const results = await tq.respawnAll();
      expect(results.skipped).toEqual([5]);
      // Slot 6 was attempted (respawned or failed depending on env)
      const attempted = [...results.respawned, ...results.failed.map(f => f.num)];
      expect(attempted).toEqual([6]);
    });
  });

  describe('getSpawnedAgentsList', () => {
    it('returns spawned agents as array', () => {
      tq.spawnedAgents.set(5, { repoDir: '/tmp/test5', name: 'alpha' });
      tq.spawnedAgents.set(8, { repoDir: '/tmp/test8', name: 'beta' });
      const list = tq.getSpawnedAgentsList();
      expect(list).toEqual([
        { num: 5, repoDir: '/tmp/test5', name: 'alpha' },
        { num: 8, repoDir: '/tmp/test8', name: 'beta' },
      ]);
    });

    it('returns empty array when no agents', () => {
      expect(tq.getSpawnedAgentsList()).toEqual([]);
    });
  });
});
