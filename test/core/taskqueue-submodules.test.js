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

function setup() {
  vi.useFakeTimers({ shouldAdvanceTime: false });
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

  const config = createMockConfig();
  const watcher = createMockWatcher();
  const router = new NodeRouter();
  router.addNode(createMockNode());
  const tq = new TaskQueue(config, watcher, router);
  return { tq, config, watcher, router };
}

// ── Users + Permissions ─────────────────────────────────

describe('TaskQueue: Users + Permissions', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.HIVE_ADMIN_USER;
  });

  it('ensureUser creates first user as admin', () => {
    const user = tq.ensureUser('alice', 'Alice', 'https://avatar');
    expect(user.login).toBe('alice');
    expect(user.name).toBe('Alice');
    expect(user.permissions).toContain('admin');
    expect(user.permissions).toContain('view');
  });

  it('ensureUser creates second user as viewer', () => {
    tq.ensureUser('alice', 'Alice', '');
    const user = tq.ensureUser('bob', 'Bob', '');
    expect(user.permissions).toEqual(['view', 'comment']);
    expect(user.permissions).not.toContain('admin');
  });

  it('ensureUser promotes HIVE_ADMIN_USER to admin', () => {
    process.env.HIVE_ADMIN_USER = 'bob';
    tq.ensureUser('alice', 'Alice', ''); // first user = admin
    const bob = tq.ensureUser('bob', 'Bob', '');
    expect(bob.permissions).toContain('admin');
  });

  it('ensureUser HIVE_ADMIN_USER match is case-insensitive', () => {
    process.env.HIVE_ADMIN_USER = 'Bob';
    tq.ensureUser('alice', 'Alice', '');
    const bob = tq.ensureUser('bob', 'Bob', '');
    expect(bob.permissions).toContain('admin');
  });

  it('ensureUser updates profile on re-login', () => {
    tq.ensureUser('alice', 'Alice', 'old-avatar');
    const updated = tq.ensureUser('alice', 'Alice New', 'new-avatar');
    expect(updated.name).toBe('Alice New');
    expect(updated.avatar).toBe('new-avatar');
  });

  it('ensureUser returns null for empty login', () => {
    expect(tq.ensureUser('', '', '')).toBeNull();
    expect(tq.ensureUser(null, '', '')).toBeNull();
  });

  it('ensureUser emits users:changed', () => {
    const spy = vi.fn();
    tq.on('users:changed', spy);
    tq.ensureUser('alice', 'Alice', '');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('hasPermission returns false for unknown user', () => {
    expect(tq.hasPermission('nobody', 'view')).toBe(false);
  });

  it('hasPermission returns false for null login', () => {
    expect(tq.hasPermission(null, 'view')).toBe(false);
    expect(tq.hasPermission('', 'view')).toBe(false);
  });

  it('hasPermission returns true for admin regardless of capability', () => {
    tq.ensureUser('alice', 'Alice', ''); // first user = admin
    expect(tq.hasPermission('alice', 'restart')).toBe(true);
    expect(tq.hasPermission('alice', 'anything-unknown')).toBe(true);
  });

  it('hasPermission checks specific permission for non-admin', () => {
    tq.ensureUser('admin', '', '');
    tq.ensureUser('viewer', 'Viewer', '');
    expect(tq.hasPermission('viewer', 'view')).toBe(true);
    expect(tq.hasPermission('viewer', 'comment')).toBe(true);
    expect(tq.hasPermission('viewer', 'restart')).toBe(false);
  });

  it('setUserPermissions updates and filters valid permissions', () => {
    tq.ensureUser('admin', '', '');
    tq.ensureUser('bob', 'Bob', '');
    const result = tq.setUserPermissions('bob', ['view', 'create-tasks', 'fake-perm']);
    expect(result.permissions).toEqual(['view', 'create-tasks']);
    expect(result.permissions).not.toContain('fake-perm');
  });

  it('setUserPermissions returns null for unknown user', () => {
    expect(tq.setUserPermissions('nobody', ['view'])).toBeNull();
  });

  it('addUser creates user with lowercase login', () => {
    const user = tq.addUser('Bob', ['view', 'send-messages']);
    expect(user.login).toBe('bob');
    expect(user.permissions).toEqual(['view', 'send-messages']);
  });

  it('addUser returns existing user if already present', () => {
    const first = tq.addUser('alice', ['view']);
    const second = tq.addUser('alice', ['admin']);
    expect(second).toBe(first);
  });

  it('addUser defaults to view+comment permissions', () => {
    const user = tq.addUser('charlie');
    expect(user.permissions).toEqual(['view', 'comment']);
  });

  it('removeUser deletes user', () => {
    tq.addUser('alice');
    expect(tq.removeUser('alice')).toBe(true);
    expect(tq.getUser('alice')).toBeNull();
  });

  it('removeUser returns false for unknown user', () => {
    expect(tq.removeUser('nobody')).toBe(false);
  });

  it('getUser returns user or null', () => {
    tq.addUser('alice');
    expect(tq.getUser('alice')).toBeTruthy();
    expect(tq.getUser('nobody')).toBeNull();
  });

  it('getUsersList returns all users', () => {
    tq.addUser('alice');
    tq.addUser('bob');
    expect(tq.getUsersList()).toHaveLength(2);
  });

  it('ALL_PERMISSIONS includes expected capabilities', () => {
    expect(TaskQueue.ALL_PERMISSIONS).toContain('view');
    expect(TaskQueue.ALL_PERMISSIONS).toContain('admin');
    expect(TaskQueue.ALL_PERMISSIONS).toContain('send-messages');
    expect(TaskQueue.ALL_PERMISSIONS).toContain('dispatch');
  });
});

// ── Session Context ─────────────────────────────────────

describe('TaskQueue: Session Context', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('getSessionContext returns empty object for unknown session', () => {
    expect(tq.getSessionContext(99)).toEqual({});
  });

  it('setSessionContext sets and returns merged context', () => {
    const result = tq.setSessionContext(5, { plan: '/path/to/plan.md', pr: '123' });
    expect(result).toEqual({ plan: '/path/to/plan.md', pr: '123' });
  });

  it('setSessionContext merges with existing context', () => {
    tq.setSessionContext(5, { plan: '/plan.md' });
    const result = tq.setSessionContext(5, { pr: '456' });
    expect(result).toEqual({ plan: '/plan.md', pr: '456' });
  });

  it('setSessionContext removes keys set to null', () => {
    tq.setSessionContext(5, { plan: '/plan.md', pr: '123' });
    const result = tq.setSessionContext(5, { pr: null });
    expect(result).toEqual({ plan: '/plan.md' });
    expect(result.pr).toBeUndefined();
  });

  it('setSessionContext deletes context when all keys removed', () => {
    tq.setSessionContext(5, { plan: '/plan.md' });
    tq.setSessionContext(5, { plan: null });
    expect(tq.getSessionContext(5)).toEqual({});
  });

  it('plan and planText are mutually exclusive — plan wins', () => {
    tq.setSessionContext(5, { planText: 'old text' });
    const result = tq.setSessionContext(5, { plan: '/new/plan.md' });
    expect(result.plan).toBe('/new/plan.md');
    expect(result.planText).toBeUndefined();
  });

  it('plan and planText are mutually exclusive — planText wins', () => {
    tq.setSessionContext(5, { plan: '/old/plan.md' });
    const result = tq.setSessionContext(5, { planText: 'new text' });
    expect(result.planText).toBe('new text');
    expect(result.plan).toBeUndefined();
  });

  it('emits context:changed event', () => {
    const spy = vi.fn();
    tq.on('context:changed', spy);
    tq.setSessionContext(5, { pr: '99' });
    expect(spy).toHaveBeenCalledOnce();
    const args = spy.mock.calls[0][0];
    expect(args.session).toBe(5);
    expect(args.context).toEqual({ pr: '99' });
  });

  it('clearSessionContext removes all context', () => {
    tq.setSessionContext(5, { plan: '/plan.md', pr: '123' });
    tq.clearSessionContext(5);
    expect(tq.getSessionContext(5)).toEqual({});
  });

  it('getAllSessionContexts returns all contexts', () => {
    tq.setSessionContext(1, { pr: '10' });
    tq.setSessionContext(2, { plan: '/x' });
    const all = tq.getAllSessionContexts();
    expect(all[1]).toEqual({ pr: '10' });
    expect(all[2]).toEqual({ plan: '/x' });
  });

  it('coerces session number to Number', () => {
    tq.setSessionContext('5', { pr: '10' });
    expect(tq.getSessionContext(5)).toEqual({ pr: '10' });
    expect(tq.getSessionContext('5')).toEqual({ pr: '10' });
  });
});

// ── Snooze ──────────────────────────────────────────────

describe('TaskQueue: Snooze', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('snoozeTask changes status to snoozed', () => {
    const task = tq.createTask('test task', 'auto');
    const result = tq.snoozeTask(task.id, 60000);
    expect(result.status).toBe('snoozed');
    expect(result.snoozedUntil).toBeDefined();
  });

  it('snoozeTask returns null for non-existent task', () => {
    expect(tq.snoozeTask('fake-id', 60000)).toBeNull();
  });

  it('snoozeTask emits task:snoozed', () => {
    const spy = vi.fn();
    tq.on('task:snoozed', spy);
    const task = tq.createTask('test', 'auto');
    tq.snoozeTask(task.id, 60000);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('snoozed task auto-wakes after duration', () => {
    const task = tq.createTask('test', 'auto');
    tq.snoozeTask(task.id, 30000);
    expect(task.status).toBe('snoozed');

    vi.advanceTimersByTime(30001);
    expect(task.status).toBe('queued');
    expect(task.snoozedUntil).toBeNull();
  });

  it('unsnoozeTask immediately wakes a snoozed task', () => {
    const task = tq.createTask('test', 'auto');
    tq.snoozeTask(task.id, 60000);
    const result = tq.unsnoozeTask(task.id);
    expect(result.status).toBe('queued');
    expect(result.snoozedUntil).toBeNull();
  });

  it('unsnoozeTask returns null for non-snoozed task', () => {
    const task = tq.createTask('test', 'auto');
    expect(tq.unsnoozeTask(task.id)).toBeNull(); // queued, not snoozed
  });

  it('unsnoozeTask emits task:unsnoozed', () => {
    const spy = vi.fn();
    tq.on('task:unsnoozed', spy);
    const task = tq.createTask('test', 'auto');
    tq.snoozeTask(task.id, 60000);
    tq.unsnoozeTask(task.id);
    expect(spy).toHaveBeenCalled();
  });

  it('cancelTask clears snooze timer', () => {
    const task = tq.createTask('test', 'auto');
    tq.snoozeTask(task.id, 60000);
    tq.cancelTask(task.id);
    expect(task.status).toBe('cancelled');

    // Advance past snooze duration — should NOT wake
    vi.advanceTimersByTime(70000);
    expect(task.status).toBe('cancelled');
  });

  it('_armSnoozeTimer wakes immediately if duration already passed', () => {
    const task = tq.createTask('test', 'auto');
    task.status = 'snoozed';
    task.snoozedUntil = Date.now() - 1000; // already past
    tq._armSnoozeTimer(task);
    expect(task.status).toBe('queued');
  });
});

// ── VIM Mode ────────────────────────────────────────────

describe('TaskQueue: VIM Mode', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('defaults to false', () => {
    expect(tq.vimMode).toBe(false);
  });

  it('setVimMode toggles on', () => {
    tq.setVimMode(true);
    expect(tq.vimMode).toBe(true);
  });

  it('setVimMode toggles off', () => {
    tq.setVimMode(true);
    tq.setVimMode(false);
    expect(tq.vimMode).toBe(false);
  });

  it('setVimMode coerces to boolean', () => {
    tq.setVimMode(1);
    expect(tq.vimMode).toBe(true);
    tq.setVimMode(0);
    expect(tq.vimMode).toBe(false);
  });

  it('emits vim:changed', () => {
    const spy = vi.fn();
    tq.on('vim:changed', spy);
    tq.setVimMode(true);
    expect(spy).toHaveBeenCalledWith(true);
  });
});

// ── Spawn Slot Range ────────────────────────────────────

describe('TaskQueue: Spawn Slot Range', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('defaults to 1-32', () => {
    expect(tq.spawnSlotMin).toBe(1);
    expect(tq.spawnSlotMax).toBe(32);
  });

  it('setSpawnSlotRange updates range', () => {
    tq.setSpawnSlotRange(10, 50);
    expect(tq.spawnSlotMin).toBe(10);
    expect(tq.spawnSlotMax).toBe(50);
  });

  it('swaps min/max if min > max', () => {
    tq.setSpawnSlotRange(50, 10);
    expect(tq.spawnSlotMin).toBe(10);
    expect(tq.spawnSlotMax).toBe(50);
  });

  it('clamps min to 1', () => {
    tq.setSpawnSlotRange(-5, 20);
    expect(tq.spawnSlotMin).toBe(1);
  });

  it('clamps max to 99', () => {
    tq.setSpawnSlotRange(1, 200);
    expect(tq.spawnSlotMax).toBe(99);
  });

  it('emits spawnSlotRange:changed', () => {
    const spy = vi.fn();
    tq.on('spawnSlotRange:changed', spy);
    tq.setSpawnSlotRange(5, 25);
    expect(spy).toHaveBeenCalledWith({ min: 5, max: 25 });
  });
});

// ── Task Comments (extended) ────────────────────────────

describe('TaskQueue: Comments (extended)', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deleteComment only allows author to delete', () => {
    const task = tq.createTask('test', 'auto');
    const comment = tq.addComment(task.id, 'alice', 'Alice', 'my comment');
    expect(tq.deleteComment(task.id, comment.id, 'bob')).toBe(false);
    expect(tq.deleteComment(task.id, comment.id, 'alice')).toBe(true);
  });

  it('deleteComment allows admin to delete anyone comment', () => {
    tq.ensureUser('admin-user', 'Admin', ''); // first user = admin
    const task = tq.createTask('test', 'auto');
    const comment = tq.addComment(task.id, 'someone', 'Someone', 'their comment');
    expect(tq.deleteComment(task.id, comment.id, 'admin-user')).toBe(true);
  });

  it('deleteComment returns false for non-existent comment', () => {
    const task = tq.createTask('test', 'auto');
    expect(tq.deleteComment(task.id, 'fake-comment', 'anyone')).toBe(false);
  });

  it('deleteComment returns false for non-existent task', () => {
    expect(tq.deleteComment('fake-task', 'fake-comment', 'anyone')).toBe(false);
  });

  it('deleteComment emits task:comment:deleted', () => {
    const spy = vi.fn();
    tq.on('task:comment:deleted', spy);
    const task = tq.createTask('test', 'auto');
    const comment = tq.addComment(task.id, 'alice', 'Alice', 'test');
    tq.deleteComment(task.id, comment.id, 'alice');
    expect(spy).toHaveBeenCalledWith({ taskId: task.id, commentId: comment.id });
  });
});

// ── Checklist ───────────────────────────────────────────

describe('TaskQueue: Checklist (extended)', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('removeChecklistItem removes item from task checklist', () => {
    const task = tq.createTask('test', 'auto');
    tq.addChecklistItem(task.id, 'Step 1');
    tq.addChecklistItem(task.id, 'Step 2');
    expect(task.checklist).toHaveLength(2);

    const itemId = task.checklist[0].id;
    tq.removeChecklistItem(task.id, itemId);
    expect(task.checklist).toHaveLength(1);
    expect(task.checklist[0].text).toBe('Step 2');
  });

  it('removeChecklistItem returns null for non-existent item', () => {
    const task = tq.createTask('test', 'auto');
    expect(tq.removeChecklistItem(task.id, 'fake')).toBeNull();
  });

  it('setTaskChecklist replaces entire checklist', () => {
    const task = tq.createTask('test', 'auto');
    tq.addChecklistItem(task.id, 'Old step');

    tq.setTaskChecklist(task.id, [
      { text: 'New A', checked: true },
      { text: 'New B', checked: false },
    ]);
    expect(task.checklist).toHaveLength(2);
    expect(task.checklist[0].text).toBe('New A');
    expect(task.checklist[0].checked).toBe(true);
    expect(task.checklist[1].text).toBe('New B');
    expect(task.checklist[1].id).toBeDefined();
  });

  it('setTaskChecklist returns null for non-existent task', () => {
    expect(tq.setTaskChecklist('fake', [])).toBeNull();
  });

  it('removeChecklistTemplate deletes template', () => {
    tq.setChecklistTemplate('tpl', ['a', 'b']);
    expect(tq.removeChecklistTemplate('tpl')).toBe(true);
    expect(tq.getChecklistTemplates()).toHaveLength(0);
  });

  it('removeChecklistTemplate returns false for non-existent', () => {
    expect(tq.removeChecklistTemplate('nope')).toBe(false);
  });
});

// ── Designation Definitions (extended) ──────────────────

describe('TaskQueue: Designation Definitions (extended)', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('removeDesignationDef clears session assignments using that designation', () => {
    tq.setDesignationDef('backend', { color: 'blue' });
    tq.setDesignation(1, 'backend');
    tq.setDesignation(2, 'frontend');
    tq.setDesignation(3, 'backend');

    tq.removeDesignationDef('backend');
    const desigs = tq.getDesignations();
    expect(desigs[1]).toBeUndefined();
    expect(desigs[2]).toBe('frontend');
    expect(desigs[3]).toBeUndefined();
  });

  it('removeDesignationDef returns false for non-existent', () => {
    expect(tq.removeDesignationDef('nope')).toBe(false);
  });

  it('removeDesignationDef emits both designationDefs:changed and designations:changed', () => {
    const defSpy = vi.fn();
    const desSpy = vi.fn();
    tq.on('designationDefs:changed', defSpy);
    tq.on('designations:changed', desSpy);

    tq.setDesignationDef('test', { color: 'red' });
    defSpy.mockClear();
    desSpy.mockClear();

    tq.removeDesignationDef('test');
    expect(defSpy).toHaveBeenCalledOnce();
    expect(desSpy).toHaveBeenCalledOnce();
  });
});

// ── Auto-mode ───────────────────────────────────────────

describe('TaskQueue: Auto-mode (extended)', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('setAutoSessions replaces all auto sessions', () => {
    tq.toggleAutoSession(1);
    tq.toggleAutoSession(2);
    tq.setAutoSessions([5, 10, 15]);
    expect(tq.getAutoSessions()).toEqual([5, 10, 15]);
  });

  it('setAutoSessions emits auto:changed', () => {
    const spy = vi.fn();
    tq.on('auto:changed', spy);
    tq.setAutoSessions([1, 2]);
    expect(spy).toHaveBeenCalledWith([1, 2]);
  });

  it('getAutoSessions returns sorted array', () => {
    tq.setAutoSessions([5, 2, 8]);
    expect(tq.getAutoSessions()).toEqual([2, 5, 8]);
  });
});

// ── Task Auto-Complete setting ──────────────────────────

describe('TaskQueue: taskAutoComplete', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('defaults to true', () => {
    expect(tq.taskAutoComplete).toBe(true);
  });
});
