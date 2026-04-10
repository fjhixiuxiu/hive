// Regression coverage for the "context consolidation" Phase 1 behavior that
// shipped to main via PR #196 (feat/unified-session-context, Apr 1 2026).
//
// Phase 1 (implemented, tested here):
//   - Slack-originated tasks carry task.slackChannel / task.slackThreadTs
//   - On dispatch, those are auto-synced to sessionContext[N].slackThread
//     as "CHANNEL:TS" so thread routing via sessionContext works
//   - completeTask / failTask / cancelTask / requeueTask / snoozeTask all
//     clear sessionContext so stale PR/branch/Slack data doesn't leak
//   - findActiveTaskForThread can resolve a thread via either the old
//     task fields (queued+dispatched) OR via sessionContext (dispatched only)
//
// Phase 2 (planned, NOT implemented):
//   - Remove old task fields, replace with task._slackContext staging
//   - Snapshot into task._completionContext on complete/fail
//   - Single-path lookup in findActiveTaskForThread
//   - See ~/dev/agents/hive/context-consolidation-plan.md
//
// Tests in this file target ONLY Phase 1 (what's live). When Phase 2 is
// executed, this file should be updated to test the new field names.

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
  vi.spyOn(logModule, 'warn').mockImplementation(() => {});
  vi.spyOn(sessionManagerModule, 'createSession').mockRejectedValue(new Error('no tmux in test'));
  vi.spyOn(sessionManagerModule, 'startClaude').mockResolvedValue();

  const config = createMockConfig();
  const watcher = createMockWatcher();
  const router = new NodeRouter();
  router.addNode(createMockNode());
  const tq = new TaskQueue(config, watcher, router);
  return { tq, config, watcher, router };
}

// Helper: create a dispatched task directly on a session (bypasses the
// auto-dispatch machinery so we can control state exactly).
function createDispatchedTask(tq, sessionNum, { slackChannel, slackThreadTs } = {}) {
  const task = tq.createTask('Test task', 'auto', null, null);
  task.status = 'dispatched';
  task.assignedTo = sessionNum;
  task.dispatchedAt = Date.now();
  if (slackChannel) task.slackChannel = slackChannel;
  if (slackThreadTs) task.slackThreadTs = slackThreadTs;
  tq.activeTaskBySession.set(sessionNum, task.id);
  return task;
}

// ── Dispatch propagates slack fields → sessionContext ──

describe('Context Consolidation: dispatch propagation', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('_dispatchTask auto-sets sessionContext.slackThread from old fields', async () => {
    vi.useRealTimers();
    tq.autoSessions.add(6);
    fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);
    fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });

    // Simulate what bot.js does: create the task, then set slack fields
    // post-creation (mirrors the current Phase 1 bot code path).
    const task = tq.createTask('Fix bug', 'auto', null, null);
    task.slackChannel = 'C123';
    task.slackThreadTs = '1234.5678';

    await new Promise(r => setTimeout(r, 100));

    const ctx = tq.getSessionContext(6);
    expect(ctx.slackThread).toBe('C123:1234.5678');
  });

  it('_dispatchTask skips sessionContext when task has no slack fields', async () => {
    vi.useRealTimers();
    tq.autoSessions.add(6);
    fleetModule.getFleetStatus.mockResolvedValue([{ name: '6-DEV', num: 6, state: 'idle' }]);
    fleetModule.findSession.mockResolvedValue({ name: '6-DEV', nodeId: 'local' });

    tq.createTask('Fix bug', 'auto', null, null);

    await new Promise(r => setTimeout(r, 100));

    const ctx = tq.getSessionContext(6);
    expect(ctx.slackThread).toBeUndefined();
  });
});

// ── Thread routing via sessionContext ──

describe('Context Consolidation: thread routing', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dispatched task found via sessionContext.slackThread', () => {
    const task = createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { slackThread: 'C123:1234.5678' });

    // Mirrors bot.js findActiveTaskForThread sessionContext fallback path
    const threadKey = 'C123:1234.5678';
    const tasks = tq.getTasksList();
    const found = tasks.find(t => {
      if (t.status !== 'dispatched' || !t.assignedTo) return false;
      const ctx = tq.getSessionContext(t.assignedTo);
      return ctx.slackThread === threadKey;
    });

    expect(found).toBeDefined();
    expect(found.id).toBe(task.id);
  });

  it('dispatched task found via direct slackThreadTs field match', () => {
    // Mirrors bot.js findActiveTaskForThread direct-match path (the "old"
    // lookup that still works for tasks created by the Slack bot).
    const task = createDispatchedTask(tq, 6, {
      slackChannel: 'C123',
      slackThreadTs: '1234.5678',
    });

    const tasks = tq.getTasksList();
    const found = tasks.find(t =>
      (t.status === 'queued' || t.status === 'dispatched') &&
      t.slackThreadTs === '1234.5678'
    );

    expect(found).toBeDefined();
    expect(found.id).toBe(task.id);
  });

  it('completed task is NOT found by thread routing (context cleared on complete)', () => {
    const task = createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { slackThread: 'C123:1234.5678' });
    tq.completeTask(task.id, 'Done!');

    const threadKey = 'C123:1234.5678';
    const tasks = tq.getTasksList();
    const found = tasks.find(t => {
      if (t.status !== 'dispatched' || !t.assignedTo) return false;
      const ctx = tq.getSessionContext(t.assignedTo);
      return ctx.slackThread === threadKey;
    });

    expect(found).toBeUndefined();
  });

  it('thread routing returns undefined when no match', () => {
    createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { slackThread: 'C123:1234.5678' });

    const tasks = tq.getTasksList();
    const found = tasks.find(t => {
      if (t.status !== 'dispatched' || !t.assignedTo) return false;
      const ctx = tq.getSessionContext(t.assignedTo);
      return ctx.slackThread === 'CXXX:9999.9999';
    });

    expect(found).toBeUndefined();
  });
});

// ── Context lifecycle — clear on complete/fail/cancel/requeue/snooze ──

describe('Context Consolidation: context lifecycle', () => {
  let tq;

  beforeEach(() => {
    ({ tq } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('context set via setSessionContext persists while task is active', () => {
    createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { pr: 'https://github.com/pr/1', branch: 'feat/foo' });

    expect(tq.getSessionContext(6).pr).toBe('https://github.com/pr/1');
    expect(tq.getSessionContext(6).branch).toBe('feat/foo');
  });

  it('completeTask clears sessionContext', () => {
    const task = createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { pr: 'https://github.com/pr/1', slackThread: 'C123:1234.5678' });

    tq.completeTask(task.id, 'Done!');

    expect(tq.getSessionContext(6)).toEqual({});
  });

  it('failTask clears sessionContext', () => {
    const task = createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { slackThread: 'C123:1234.5678' });

    tq.failTask(task.id, 'Crashed');

    expect(tq.getSessionContext(6)).toEqual({});
  });

  it('session without a task can still have context (manual / PM-owned)', () => {
    tq.setSessionContext(6, { branch: 'feat/manual-work', jira: 'DEV-12345' });

    expect(tq.getSessionContext(6).branch).toBe('feat/manual-work');
    expect(tq.getSessionContext(6).jira).toBe('DEV-12345');
    expect(tq.activeTaskBySession.has(6)).toBe(false);
  });

  // Regression guard for commit 57b9d46 (fix: Clear session context on
  // cancel/requeue/snooze paths). Before that fix, these paths left stale
  // pr/branch/jira/slackThread context behind and misrouted follow-ups.

  it('cancelTask clears sessionContext (regression for 57b9d46)', () => {
    const task = createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { pr: 'https://github.com/pr/1', slackThread: 'C123:1234.5678' });

    tq.cancelTask(task.id);

    expect(tq.getSessionContext(6)).toEqual({});
  });

  it('requeueTask clears sessionContext (regression for 57b9d46)', () => {
    const task = createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { pr: 'https://github.com/pr/1' });

    tq.requeueTask(task.id);

    expect(tq.getSessionContext(6)).toEqual({});
  });

  it('snoozeTask clears sessionContext (regression for 57b9d46)', () => {
    const task = createDispatchedTask(tq, 6);
    tq.setSessionContext(6, { pr: 'https://github.com/pr/1', slackThread: 'C123:1234.5678' });

    tq.snoozeTask(task.id, Date.now() + 60000);

    expect(tq.getSessionContext(6)).toEqual({});
  });
});
