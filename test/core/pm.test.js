import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../../src/core/log.js', () => ({
  default: { info: vi.fn(), error: vi.fn() },
  info: vi.fn(),
  error: vi.fn(),
}));

const ProjectManager = (await import('../../src/core/pm.js')).default || (await import('../../src/core/pm.js'));

function createMockTaskQueue() {
  const tq = new EventEmitter();
  tq.tasks = new Map();
  tq.config = {};
  tq.router = {};
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

describe('ProjectManager', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
  });

  describe('create', () => {
    it('returns PM with defaults', () => {
      const result = pm.create({ name: 'Test PM' });
      expect(result.name).toBe('Test PM');
      expect(result.enabled).toBe(false);
      expect(result.seenKeys).toEqual([]);
      expect(result.autoThreshold).toBe(3);
    });

    it('emits pm:changed', () => {
      const spy = vi.fn();
      pm.on('pm:changed', spy);
      pm.create({ name: 'Test' });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('modifies fields', () => {
      const created = pm.create({ name: 'Original' });
      pm.update(created.id, { name: 'Updated', designation: 'reviewer' });
      expect(pm.get(created.id).name).toBe('Updated');
      expect(pm.get(created.id).designation).toBe('reviewer');
    });

    it('ignores protected fields', () => {
      const created = pm.create({ name: 'Test' });
      pm.update(created.id, { id: '999', seenKeys: ['fake'], tasksCreated: 100 });
      expect(pm.get(created.id).id).toBe(created.id);
      expect(pm.get(created.id).seenKeys).toEqual([]);
    });

    it('returns null for non-existent PM', () => {
      expect(pm.update('999', { name: 'X' })).toBeNull();
    });
  });

  describe('remove', () => {
    it('removes PM', () => {
      const created = pm.create({ name: 'Test' });
      pm.remove(created.id);
      expect(pm.get(created.id)).toBeNull();
    });
  });

  describe('toggle', () => {
    it('toggles enabled state', () => {
      const created = pm.create({ name: 'Test', source: { type: 'slack' } });
      expect(created.enabled).toBe(false);
      pm.toggle(created.id);
      expect(pm.get(created.id).enabled).toBe(true);
      pm.toggle(created.id);
      expect(pm.get(created.id).enabled).toBe(false);
    });
  });

  describe('getAll / get', () => {
    it('getAll returns all PMs', () => {
      pm.create({ name: 'A' });
      pm.create({ name: 'B' });
      expect(pm.getAll()).toHaveLength(2);
    });

    it('get returns null for nonexistent', () => {
      expect(pm.get('999')).toBeNull();
    });
  });

  describe('serialize / loadState', () => {
    it('serializes and restores PM data', () => {
      pm.create({ name: 'A' });
      const data = pm.serialize();
      expect(data).toHaveLength(1);

      const pm2 = new ProjectManager(taskQueue);
      pm2.loadState(data);
      expect(pm2.getAll()).toHaveLength(1);
    });

    it('handles null/empty loadState', () => {
      const pm2 = new ProjectManager(taskQueue);
      pm2.loadState(null);
      expect(pm2.getAll()).toHaveLength(0);
    });

    it('caps seenKeys at 5000 on serialize', () => {
      const created = pm.create({ name: 'Test' });
      created.seenKeys = Array.from({ length: 6000 }, (_, i) => `key-${i}`);
      const data = pm.serialize();
      expect(data[0].seenKeys).toHaveLength(5000);
    });
  });

  describe('_evaluateComplexity', () => {
    it('returns auto for low story points', () => {
      expect(pm._evaluateComplexity({ storyPoints: 2 }, 3)).toBe('auto');
    });

    it('returns manual for high story points', () => {
      expect(pm._evaluateComplexity({ storyPoints: 5 }, 3)).toBe('manual');
    });

    it('returns auto for bug/task types', () => {
      expect(pm._evaluateComplexity({ issueType: 'bug' }, 3)).toBe('auto');
      expect(pm._evaluateComplexity({ issueType: 'task' }, 3)).toBe('auto');
    });

    it('returns manual for story/epic types', () => {
      expect(pm._evaluateComplexity({ issueType: 'story' }, 3)).toBe('manual');
      expect(pm._evaluateComplexity({ issueType: 'epic' }, 3)).toBe('manual');
    });
  });

  describe('manual source', () => {
    it('creates task immediately when enabled', () => {
      const created = pm.create({
        name: 'Manual Task',
        source: { type: 'manual', text: 'Do the thing' },
      });
      pm.toggle(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledWith(
        'Do the thing', 'manual', null, null,
        expect.objectContaining({ source: 'pm:Manual Task' }),
      );
    });

    it('auto-disables after creating task', () => {
      const created = pm.create({
        name: 'Manual',
        source: { type: 'manual', text: 'Do it' },
      });
      pm.toggle(created.id);
      expect(pm.get(created.id).enabled).toBe(false);
    });
  });

  describe('stopAll', () => {
    it('stops all polling timers', () => {
      pm.create({ name: 'A', source: { type: 'slack' } });
      pm.stopAll();
      expect(pm.timers.size).toBe(0);
    });
  });
});
