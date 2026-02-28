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

describe('E2E: Task Dispatch Lifecycle', () => {
  let tq, watcher, router, node, config;

  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(relayModule, 'ask').mockResolvedValue({ success: true });
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});

    config = createMockConfig();
    watcher = createMockWatcher();
    node = createMockNode();
    router = new NodeRouter();
    router.addNode(node);
    tq = new TaskQueue(config, watcher, router);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('full flow: create → idle → dispatch → idle → completed', async () => {
    tq.autoSessions.add(6);

    // Set up fleet to show idle session
    fleetModule.getFleetStatus.mockResolvedValue([
      { name: '6-DEV', num: 6, state: 'idle' },
    ]);
    fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });

    // Create task — triggers auto-dispatch
    tq.createTask('Fix bug #123', 'auto', null, null);

    // Wait for async dispatch
    await new Promise(r => setTimeout(r, 50));

    const task = Array.from(tq.tasks.values()).find(t => t.text === 'Fix bug #123');
    expect(task.status).toBe('dispatched');
    expect(task.assignedTo).toBe(6);

    // Simulate session going idle → completes task
    watcher.emit('session:idle', {
      session: {}, name: '6-DEV', num: 6,
      preview: 'Bug fixed!', ansiSnapshot: 'ansi-data', paneCols: 120,
    });

    expect(task.status).toBe('completed');
    expect(task.snapshot).toBe('ansi-data');
  });

  it('task with designation only dispatches to matching session', async () => {
    tq.autoSessions.add(6);
    tq.autoSessions.add(7);
    tq.designations.set(6, 'coder');
    tq.designations.set(7, 'reviewer');

    fleetModule.getFleetStatus.mockResolvedValue([
      { name: '6-DEV', num: 6, state: 'idle' },
      { name: '7-DEV', num: 7, state: 'idle' },
    ]);
    fleetModule.findSession.mockResolvedValue({ name: '7-DEV', nodeId: 'local' });

    tq.createTask('Review PR #42', 'auto', null, 'reviewer');
    await new Promise(r => setTimeout(r, 50));

    const task = Array.from(tq.tasks.values()).find(t => t.text === 'Review PR #42');
    expect(task.assignedTo).toBe(7); // dispatched to reviewer, not coder
  });

  it('multiple tasks queue and dispatch in order', async () => {
    tq.autoSessions.add(6);

    // No idle sessions initially
    fleetModule.getFleetStatus.mockResolvedValue([
      { name: '6-DEV', num: 6, state: 'working' },
    ]);

    tq.createTask('Task A', 'auto', null, null);
    tq.createTask('Task B', 'auto', null, null);
    tq.createTask('Task C', 'auto', null, null);

    await new Promise(r => setTimeout(r, 50));

    // All should be queued
    const tasks = Array.from(tq.tasks.values());
    expect(tasks.every(t => t.status === 'queued')).toBe(true);

    // Session becomes idle
    fleetModule.getFleetStatus.mockResolvedValue([
      { name: '6-DEV', num: 6, state: 'idle' },
    ]);
    fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });

    await tq._tryAutoDispatch();
    await new Promise(r => setTimeout(r, 50));

    // First task should be dispatched, others still queued
    const taskA = tasks.find(t => t.text === 'Task A');
    expect(taskA.status).toBe('dispatched');
    expect(tasks.find(t => t.text === 'Task B').status).toBe('queued');
    expect(tasks.find(t => t.text === 'Task C').status).toBe('queued');
  });

  it('task cancellation mid-queue', async () => {
    tq.createTask('Task 1', 'auto', null, null);
    const task2 = tq.createTask('Task 2 - cancel me', 'auto', null, null);
    tq.createTask('Task 3', 'auto', null, null);

    tq.cancelTask(task2.id);

    expect(task2.status).toBe('cancelled');
    const queuedTasks = Array.from(tq.tasks.values()).filter(t => t.status === 'queued');
    expect(queuedTasks).toHaveLength(2); // Task 1 and 3
  });

  it('dispatch failure recovery — relay.tell fails does not crash', async () => {
    tq.autoSessions.add(6);

    fleetModule.getFleetStatus.mockResolvedValue([
      { name: '6-DEV', num: 6, state: 'idle' },
    ]);
    fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });
    relayModule.tell.mockResolvedValue({ success: false, error: 'tmux error' });

    tq.createTask('Will fail', 'auto', null, null);
    await new Promise(r => setTimeout(r, 100));

    const task = Array.from(tq.tasks.values()).find(t => t.text === 'Will fail');
    // Task should be dispatched (then failed when tell returns error)
    expect(['dispatched', 'failed']).toContain(task.status);
  });
});
