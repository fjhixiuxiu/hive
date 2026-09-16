import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockWatcher, createMockNode } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const fleetModule = require('../../src/core/fleet');
const logModule = require('../../src/core/log');
const TaskQueue = require('../../src/core/taskqueue');
const ProjectManager = require('../../src/core/pm');
const NodeRouter = require('../../src/core/node-router');
const createMessageHandler = require('../../src/integrations/web/ws-handlers');

/**
 * E2E: a task hand-added from the dashboard joins a PM and behaves as its work.
 *
 * This is the whole point of the PM picker, and it cannot be proven against
 * hand-built task objects — the claim is that the *real* create path produces a
 * task the *real* PM code picks up. So: real TaskQueue, real ProjectManager,
 * real `task:create` handler, and the PM's own condition check run over it.
 */
describe('E2E: hand-added task joins a PM', () => {
  let tq, pmManager, handle, config, ws, sent;

  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(logModule, 'warn').mockImplementation(() => {});

    config = createMockConfig();
    config.github = { repo: 'nukulb/hive' };
    const router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(config, createMockWatcher(), router);
    pmManager = new ProjectManager(tq);
    tq._pmManager = pmManager;

    sent = [];
    ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
    handle = createMessageHandler({
      config,
      taskQueue: tq,
      pmManager,
      router,
      broadcast: () => {},
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
  });

  afterEach(() => {
    tq.stop?.();
    pmManager.stopAll();
    vi.restoreAllMocks();
  });

  function makeReviewPm() {
    const pm = pmManager.create({
      name: 'Human Reviews',
      designation: 'Code Review',
      designationMatch: 'strict',
      completionConditions: [{ type: 'github-pr-state', states: ['merged', 'closed'] }],
    });
    pm.enabled = true;
    return pm;
  }

  async function createFromDashboard(fields) {
    await handle(
      ws,
      { type: 'task:create', text: 'Review the picker', mode: 'auto', ...fields },
      { login: 'jeff' },
    );
    return [...tq.tasks.values()].at(-1);
  }

  it('routes as that PM — _getSourcePm resolves, so designationMatch applies', async () => {
    const pm = makeReviewPm();
    const task = await createFromDashboard({ pm: 'Human Reviews', designation: 'Code Review' });

    // Without the picker this returned null and routing fell back to the
    // global autoCreateForManualTasks boolean.
    expect(tq._getSourcePm(task)).toBe(pm);
    expect(tq._getSourcePm(task).designationMatch).toBe('strict');
  });

  it('auto-completes when the tracked PR merges', async () => {
    makeReviewPm();
    const task = await createFromDashboard({ pm: 'Human Reviews', track: '#349' });
    expect(task.sourceKey).toBe('nukulb/hive#349');

    vi.spyOn(pmManager, '_githubHeaders').mockReturnValue({ Authorization: 'Bearer t' });
    vi.spyOn(pmManager, '_httpRequest').mockResolvedValue({ merged: true, state: 'closed' });

    await pmManager._checkCompletions([...pmManager.pms.keys()][0]);

    expect(tq.tasks.get(task.id).status).toBe('completed');
    expect(tq.tasks.get(task.id).result).toContain('PR #349 merged');
  });

  it('is invisible to the completion check when Track is blank', async () => {
    // The per-task opt-in: joined to the PM for routing, untouched by its PR
    // machinery. _checkCompletions filters on sourceKey, so it never even
    // asks GitHub about this task.
    makeReviewPm();
    const task = await createFromDashboard({ pm: 'Human Reviews' });
    expect(task.sourceKey).toBeNull();

    const http = vi
      .spyOn(pmManager, '_httpRequest')
      .mockResolvedValue({ merged: true, state: 'closed' });
    vi.spyOn(pmManager, '_githubHeaders').mockReturnValue({ Authorization: 'Bearer t' });

    await pmManager._checkCompletions([...pmManager.pms.keys()][0]);

    expect(http).not.toHaveBeenCalled();
    expect(tq.tasks.get(task.id).status).toBe('queued');
  });

  it('is invisible to another PM with the same tracked PR', async () => {
    makeReviewPm();
    const other = pmManager.create({
      name: 'PR Watch',
      completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
    });
    other.enabled = true;
    const task = await createFromDashboard({ pm: 'Human Reviews', track: '#349' });

    vi.spyOn(pmManager, '_githubHeaders').mockReturnValue({ Authorization: 'Bearer t' });
    const http = vi
      .spyOn(pmManager, '_httpRequest')
      .mockResolvedValue({ merged: true, state: 'closed' });

    await pmManager._checkCompletions(other.id);

    expect(http).not.toHaveBeenCalled();
    expect(tq.tasks.get(task.id).status).toBe('queued');
  });

  it('leaves the PM free to create the same task itself — no seen key is written', async () => {
    // A seen key would permanently stop the poll loop queueing this PR, long
    // after the hand-added task was closed. Dedupe is the right suppressor: it
    // expires on its own.
    const pm = makeReviewPm();
    await createFromDashboard({ pm: 'Human Reviews', track: '#349' });
    expect(pm.seenKeys).toEqual([]);
  });

  it('refuses a JIRA key on a PR-watching PM, because the condition would silently skip it', async () => {
    // The behaviour being prevented, demonstrated rather than asserted: force a
    // mismatched task past the dialog and watch _checkCompletions do nothing.
    // _parsePRFromKey('DEV-1') is null, so github-pr-state `continue`s — no
    // HTTP call, no error, no completion, forever.
    const pm = makeReviewPm();
    const task = await createFromDashboard({ pm: 'Human Reviews', track: '#349' });
    task.sourceKey = 'DEV-1'; // what the guard now stops anyone from creating

    vi.spyOn(pmManager, '_githubHeaders').mockReturnValue({ Authorization: 'Bearer t' });
    const http = vi
      .spyOn(pmManager, '_httpRequest')
      .mockResolvedValue({ merged: true, state: 'closed' });
    await pmManager._checkCompletions(pm.id);

    expect(http).not.toHaveBeenCalled();
    expect(tq.tasks.get(task.id).status).toBe('queued');

    // And the dialog path now refuses to produce that task in the first place.
    const before = tq.tasks.size;
    await handle(
      ws,
      {
        type: 'task:create',
        text: 'mismatched',
        mode: 'auto',
        pm: 'Human Reviews',
        track: 'DEV-1',
      },
      { login: 'jeff' },
    );
    expect(tq.tasks.size).toBe(before);
    expect(sent.at(-1)).toMatchObject({ type: 'error' });
    expect(sent.at(-1).message).toContain('pull requests');
  });

  it('a task with no PM still gets source: null, exactly as before', async () => {
    makeReviewPm();
    const task = await createFromDashboard({});
    expect(task.source).toBeNull();
    expect(task.sourceKey).toBeNull();
    expect(tq._getSourcePm(task)).toBeNull();
  });

  it('survives a save/restore round trip with its PM identity intact', async () => {
    // sourceKey is written inside createTask now rather than assigned after
    // it, so the record persisted at creation is already complete.
    makeReviewPm();
    const task = await createFromDashboard({ pm: 'Human Reviews', track: 'nukulb/hive#349' });
    const written = JSON.parse(fs.writeFileSync.mock.calls.at(-1)[1]);
    const persisted = written.tasks.find((t) => t.id === task.id);
    expect(persisted).toMatchObject({
      source: 'pm:Human Reviews',
      sourceKey: 'nukulb/hive#349',
      actionContext: { type: 'github-pr', repo: 'nukulb/hive', prNumber: 349 },
    });
  });
});
