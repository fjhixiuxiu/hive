import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockWatcher, createMockNode } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const fleetModule = require('../../src/core/fleet');
const relayModule = require('../../src/core/relay');
const logModule = require('../../src/core/log');
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
      // Ensure no existing users
      expect(tq.users.size).toBe(0);
      const user = tq.ensureUser('admin', 'Admin', '');
      expect(user.permissions).toContain('admin');
    });

    it('subsequent users get viewer permissions', () => {
      tq.ensureUser('admin', 'Admin', '');
      const user = tq.ensureUser('viewer', 'Viewer', '');
      expect(user.permissions).toEqual(['view', 'comment']);
    });

    it('hasPermission checks permission list', () => {
      tq.ensureUser('admin', 'Admin', '');
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
