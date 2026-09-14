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

// The incident this covers: a hive with "auto-complete on idle" switched OFF
// still watched a session call hive_complete_task, close its own task, and get
// handed the next queued one 36 seconds later. The idle switch never guarded
// completeTask — only per-task requireHumanClose did, and that was unset.
describe('requireHumanCloseAll', () => {
  let tq;

  function dispatched(overrides = {}) {
    const task = tq.createTask('Review PR #32794', 'auto', null, null, overrides);
    task.status = 'dispatched';
    task.assignedTo = 25;
    tq.activeTaskBySession.set(25, task.id);
    return task;
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManagerModule, 'createSession').mockRejectedValue(new Error('no tmux in test'));
    vi.spyOn(sessionManagerModule, 'startClaude').mockResolvedValue();

    const router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(createMockConfig(), createMockWatcher(), router);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('defaults to off, so an ungated task still completes as it always did', () => {
    expect(tq.requireHumanCloseAll).toBe(false);
    const task = dispatched();

    const result = tq.completeTask(task.id, 'done');

    expect(result).not.toBe('pending');
    expect(task.status).toBe('completed');
    expect(tq.activeTaskBySession.has(25)).toBe(false);
  });

  it('reproduces the S25 bug: auto-complete off does NOT stop an MCP completion', () => {
    tq.taskAutoComplete = false;
    const task = dispatched();

    const result = tq.completeTask(task.id, 'Completed via MCP');

    // The idle switch is idle-scoped by design — this is why the new gate exists.
    expect(result).not.toBe('pending');
    expect(task.status).toBe('completed');
  });

  it('holds an MCP completion pending and keeps the session attached', () => {
    tq.requireHumanCloseAll = true;
    const task = dispatched();

    const result = tq.completeTask(task.id, 'Completed via MCP');

    expect(result).toBe('pending');
    expect(task.status).toBe('dispatched');
    expect(task.pendingResult).toBe('Completed via MCP');
    expect(task.completedAt).toBeFalsy();
    // The whole point: the slot is NOT freed, so nothing gets dispatched here.
    expect(tq.activeTaskBySession.get(25)).toBe(task.id);
  });

  it('does not block a person clicking Done — force is the approval', () => {
    tq.requireHumanCloseAll = true;
    const task = dispatched();

    const result = tq.completeTask(task.id, 'Manually completed', null, 0, { force: true });

    expect(result).not.toBe('pending');
    expect(task.status).toBe('completed');
    expect(tq.activeTaskBySession.has(25)).toBe(false);
  });

  it('approveComplete closes a task the switch held', () => {
    tq.requireHumanCloseAll = true;
    const task = dispatched();
    expect(tq.completeTask(task.id, 'Completed via MCP')).toBe('pending');

    const approved = tq.approveComplete(task.id);

    expect(approved).toBeTruthy();
    expect(approved.status).toBe('completed');
    expect(approved.result).toBe('Completed via MCP');
    expect(tq.activeTaskBySession.has(25)).toBe(false);
  });

  it('gates a task even when its own requireHumanClose is false', () => {
    tq.requireHumanCloseAll = true;
    const task = dispatched({ requireHumanClose: false });
    expect(task.requireHumanClose).toBe(false);

    expect(tq.completeTask(task.id, 'Completed via MCP')).toBe('pending');
  });

  it('survives a save/load round trip', () => {
    tq.requireHumanCloseAll = true;

    // _saveState writes a .tmp alongside the state file, then renames it.
    let written = null;
    fs.writeFileSync.mockImplementation((file, body) => {
      if (String(file).endsWith('.hive-state.json.tmp')) written = body;
    });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    tq._saveState();
    expect(written).toBeTruthy();
    expect(JSON.parse(written).requireHumanCloseAll).toBe(true);

    fs.readFileSync.mockImplementation(() => written);
    const fresh = new TaskQueue(createMockConfig(), createMockWatcher(), new NodeRouter());
    expect(fresh.requireHumanCloseAll).toBe(true);
  });

  it('stays off when the state file predates the setting', () => {
    fs.readFileSync.mockImplementation(() => JSON.stringify({ tasks: [], feed: [] }));

    const fresh = new TaskQueue(createMockConfig(), createMockWatcher(), new NodeRouter());

    expect(fresh.requireHumanCloseAll).toBe(false);
  });
});
