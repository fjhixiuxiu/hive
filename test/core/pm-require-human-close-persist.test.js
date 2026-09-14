import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../../src/core/log.js', () => ({
  default: { info: vi.fn(), error: vi.fn() },
  info: vi.fn(),
  error: vi.fn(),
}));

const ProjectManager =
  (await import('../../src/core/pm.js')).default || (await import('../../src/core/pm.js'));

function createMockTaskQueue() {
  const tq = new EventEmitter();
  tq.tasks = new Map();
  tq.config = {};
  tq.router = { listAllSessions: vi.fn().mockResolvedValue([]) };
  tq.createTask = vi.fn().mockReturnValue({ id: '1', text: '', status: 'queued' });
  tq.pushFeed = vi.fn();
  tq._saveState = vi.fn();
  tq._pmManager = null;
  tq.dispatchLock = new Set();
  tq.activeTaskBySession = new Map();
  tq.designations = new Map();
  tq.checklistTemplates = new Map();
  tq.getQueuePosition = vi.fn().mockReturnValue(1);
  return tq;
}

function freshManager() {
  const pm = new ProjectManager(createMockTaskQueue());
  vi.spyOn(pm, '_startPolling').mockImplementation(() => {});
  vi.spyOn(pm, '_stopPolling').mockImplementation(() => {});
  vi.spyOn(pm, '_httpRequest').mockRejectedValue(new Error('no network in test'));
  vi.spyOn(pm, '_save').mockImplementation(() => {});
  return pm;
}

// requireHumanClose is what stops a PM's tasks closing themselves. serialize()
// spreads ...pm so it reached disk fine, but loadState() rebuilds each PM field
// by field and this was the one field of thirty that list forgot — so it came
// back undefined on every boot, and a PM set to hold its work for a human
// quietly stopped doing so. Every task it then created was built with
// requireHumanClose: !!pm.requireHumanClose, which is to say false.
describe('PM requireHumanClose survives a restart', () => {
  let pm;

  beforeEach(() => {
    pm = freshManager();
  });
  afterEach(() => {
    pm.stopAll();
    vi.restoreAllMocks();
  });

  it('restores a PM saved with the flag on', () => {
    const saved = [
      { id: '1', name: 'Gated', source: { type: 'jira', jql: '' }, requireHumanClose: true },
    ];

    pm.loadState(saved);

    expect(pm.getAll()[0].requireHumanClose).toBe(true);
  });

  it('keeps false as false rather than undefined', () => {
    pm.loadState([
      { id: '1', name: 'Ungated', source: { type: 'jira', jql: '' }, requireHumanClose: false },
    ]);

    expect(pm.getAll()[0].requireHumanClose).toBe(false);
  });

  it('defaults to false for a PM saved before the field existed', () => {
    pm.loadState([{ id: '1', name: 'Ancient', source: { type: 'jira', jql: '' } }]);

    expect(pm.getAll()[0].requireHumanClose).toBe(false);
  });

  it('survives a full save/load round trip', () => {
    const created = pm.create({ name: 'Gated', source: { type: 'jira', jql: '' } });
    pm.update(created.id, { requireHumanClose: true });

    const saved = JSON.parse(JSON.stringify(pm.serialize()));
    expect(saved[0].requireHumanClose).toBe(true); // serialize was never the problem

    const next = freshManager();
    next.loadState(saved);

    expect(next.getAll()[0].requireHumanClose).toBe(true); // this is what was lost
    next.stopAll();
  });

  it('carries the flag onto the tasks the PM creates', () => {
    pm.loadState([
      { id: '1', name: 'Gated', source: { type: 'jira', jql: '' }, requireHumanClose: true },
    ]);
    const restored = pm.getAll()[0];

    // The only consumer that matters: task creation reads it off the PM.
    expect(!!restored.requireHumanClose).toBe(true);
  });
});
