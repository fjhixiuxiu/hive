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

  describe('reset', () => {
    it('clears seenKeys, tasksCreated, lastPoll, lastError', () => {
      const created = pm.create({ name: 'Test PM' });
      // Simulate some state
      const pmObj = pm.get(created.id);
      pmObj.seenKeys = ['KEY-1', 'KEY-2', 'KEY-3'];
      pmObj.tasksCreated = 5;
      pmObj.lastPoll = Date.now();
      pmObj.lastError = 'some error';

      pm.reset(created.id);

      expect(pmObj.seenKeys).toEqual([]);
      expect(pmObj.tasksCreated).toBe(0);
      expect(pmObj.lastPoll).toBeNull();
      expect(pmObj.lastError).toBeNull();
    });

    it('clears reReviewPollTimes for the PM', () => {
      const created = pm.create({ name: 'Test PM' });
      pm._reReviewPollTimes = { [created.id]: Date.now(), other: 12345 };

      pm.reset(created.id);

      expect(pm._reReviewPollTimes[created.id]).toBeUndefined();
      expect(pm._reReviewPollTimes.other).toBe(12345);
    });

    it('emits pm:changed and saves', () => {
      const created = pm.create({ name: 'Test' });
      const spy = vi.fn();
      pm.on('pm:changed', spy);
      spy.mockClear(); // clear the create emission

      pm.reset(created.id);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(taskQueue._saveState).toHaveBeenCalled();
    });

    it('does nothing for non-existent PM', () => {
      const spy = vi.fn();
      pm.on('pm:changed', spy);

      pm.reset('999');

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('rescan', () => {
    it('clears reReviewPollTimes for the PM', () => {
      const created = pm.create({ name: 'Test', source: { type: 'slack' } });
      pm._reReviewPollTimes = { [created.id]: Date.now() };

      pm.rescan(created.id);

      expect(pm._reReviewPollTimes[created.id]).toBeUndefined();
    });

    it('does nothing for non-existent PM', () => {
      // Should not throw
      pm.rescan('999');
    });
  });

  describe('stopAll', () => {
    it('stops all polling timers', () => {
      pm.create({ name: 'A', source: { type: 'slack' } });
      pm.stopAll();
      expect(pm.timers.size).toBe(0);
    });

    it('clears both interval and cron timers', () => {
      // Manually set up mixed timer types
      const intervalHandle = setInterval(() => {}, 10000);
      const cronTask = { stop: vi.fn() };
      pm.timers.set('int-1', intervalHandle);
      pm.timers.set('cron-1', cronTask);
      pm.stopAll();
      expect(pm.timers.size).toBe(0);
      expect(cronTask.stop).toHaveBeenCalled();
      clearInterval(intervalHandle);
    });
  });

  // ── Regression tests: existing source types with schedule field ──

  describe('existing source types still work with schedule field', () => {
    it('command source without schedule still uses setInterval', () => {
      const created = pm.create({
        name: 'Cmd PM',
        source: { type: 'command', command: '/test' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      const timer = pm.timers.get(created.id);
      // setInterval returns a number or Timeout object, not something with .stop()
      expect(timer).toBeDefined();
      expect(typeof timer.stop).not.toBe('function');
    });

    it('command source with pollInterval fires on interval', async () => {
      const created = pm.create({
        name: 'Cmd PM',
        source: { type: 'command', command: '/test' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      // _createCommandTask is async — flush microtasks
      await vi.advanceTimersByTimeAsync(0);
      // The command creates a task if an idle session is found (none in mock)
      // Either way, the timer should be set
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('manual source with schedule uses cron timer', () => {
      const created = pm.create({
        name: 'Manual',
        source: { type: 'manual', text: 'Do it' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      // Manual + schedule uses cron, stays enabled
      expect(pm.timers.has(created.id)).toBe(true);
      expect(pm.get(created.id).enabled).toBe(true);
    });

    it('slack source ignores schedule field', () => {
      const created = pm.create({
        name: 'Slack',
        source: { type: 'slack' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      // Slack is config-only, no timer
      expect(pm.timers.has(created.id)).toBe(false);
    });

    it('toggle on/off cycle with interval PM creates and clears timer', () => {
      const created = pm.create({
        name: 'Cmd PM',
        source: { type: 'command', command: '/test' },
        pollInterval: 60000,
      });
      pm.toggle(created.id); // on
      expect(pm.timers.has(created.id)).toBe(true);
      pm.toggle(created.id); // off
      expect(pm.timers.has(created.id)).toBe(false);
    });
  });

  describe('_stopPolling backward compatibility', () => {
    it('handles setInterval handle with clearInterval', () => {
      const intervalHandle = setInterval(() => {}, 10000);
      pm.timers.set('test', intervalHandle);
      pm._stopPolling('test');
      expect(pm.timers.has('test')).toBe(false);
      clearInterval(intervalHandle); // cleanup just in case
    });

    it('handles cron task with .stop()', () => {
      const cronTask = { stop: vi.fn() };
      pm.timers.set('test', cronTask);
      pm._stopPolling('test');
      expect(cronTask.stop).toHaveBeenCalled();
      expect(pm.timers.has('test')).toBe(false);
    });
  });

  describe('loadState backward compatibility', () => {
    it('old state data without schedule field loads correctly', () => {
      const oldData = [{
        id: '1',
        name: 'Old PM',
        source: { type: 'jira', jql: 'project = DEV' },
        pollInterval: 300000,
        enabled: false,
        seenKeys: [],
        tasksCreated: 0,
      }];
      const pm2 = new ProjectManager(taskQueue);
      pm2.loadState(oldData);
      const loaded = pm2.get('1');
      expect(loaded.schedule).toBeNull();
      expect(loaded.pollInterval).toBe(300000);
      pm2.stopAll();
    });
  });

  // ── New feature: cron scheduling ──

  describe('schedule (cron)', () => {
    it('create stores schedule field', () => {
      const created = pm.create({ name: 'Cron PM', schedule: '0 9 * * 1-5' });
      expect(created.schedule).toBe('0 9 * * 1-5');
    });

    it('create defaults schedule to null when not provided', () => {
      const created = pm.create({ name: 'No Cron' });
      expect(created.schedule).toBeNull();
    });

    it('serialize and loadState round-trip the schedule field', () => {
      pm.create({ name: 'Cron PM', schedule: '*/10 * * * *', source: { type: 'slack' } });
      const data = pm.serialize();
      expect(data[0].schedule).toBe('*/10 * * * *');

      const pm2 = new ProjectManager(taskQueue);
      pm2.loadState(data);
      expect(pm2.getAll()[0].schedule).toBe('*/10 * * * *');
      pm2.stopAll();
    });

    it('_startPolling with schedule uses cron.schedule()', () => {
      const created = pm.create({
        name: 'Cron Cmd',
        source: { type: 'command', command: '/test' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      const timer = pm.timers.get(created.id);
      // cron.schedule returns an object with .stop()
      expect(timer).toBeDefined();
      expect(typeof timer.stop).toBe('function');
    });

    it('_startPolling with schedule still runs callback immediately', async () => {
      const created = pm.create({
        name: 'Cron Cmd',
        source: { type: 'command', command: '/test' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      // _createCommandTask is async — flush microtasks
      await vi.advanceTimersByTimeAsync(0);
      // No idle sessions in mock, so task gets queued
      expect(taskQueue.createTask).toHaveBeenCalled();
    });

    it('_stopPolling calls .stop() on cron ScheduledTask objects', () => {
      const created = pm.create({
        name: 'Cron Cmd',
        source: { type: 'command', command: '/test' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      const timer = pm.timers.get(created.id);
      const stopSpy = vi.spyOn(timer, 'stop');
      pm._stopPolling(created.id);
      expect(stopSpy).toHaveBeenCalled();
      expect(pm.timers.has(created.id)).toBe(false);
    });

    it('update changing schedule while enabled restarts with new cron', () => {
      const created = pm.create({
        name: 'Cron Cmd',
        source: { type: 'command', command: '/test' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      const oldTimer = pm.timers.get(created.id);
      const oldStop = vi.spyOn(oldTimer, 'stop');

      pm.update(created.id, { schedule: '0 9 * * *' });
      expect(oldStop).toHaveBeenCalled();
      const newTimer = pm.timers.get(created.id);
      expect(newTimer).toBeDefined();
      expect(typeof newTimer.stop).toBe('function');
    });

    it('update removing schedule switches back to setInterval', () => {
      const created = pm.create({
        name: 'Cron Cmd',
        source: { type: 'command', command: '/test' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      expect(typeof pm.timers.get(created.id).stop).toBe('function');

      pm.update(created.id, { schedule: null });
      const timer = pm.timers.get(created.id);
      expect(timer).toBeDefined();
      expect(typeof timer.stop).not.toBe('function');
    });

    it('toggle off stops cron task, toggle on restarts it', () => {
      const created = pm.create({
        name: 'Cron Cmd',
        source: { type: 'command', command: '/test' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id); // on
      expect(pm.timers.has(created.id)).toBe(true);
      const timer = pm.timers.get(created.id);
      const stopSpy = vi.spyOn(timer, 'stop');

      pm.toggle(created.id); // off
      expect(stopSpy).toHaveBeenCalled();
      expect(pm.timers.has(created.id)).toBe(false);

      pm.toggle(created.id); // on again
      expect(pm.timers.has(created.id)).toBe(true);
    });
  });

  // ── New feature: script source type ──

  describe('script source', () => {
    it('create with script source stores source.script and source.scriptAction', () => {
      const created = pm.create({
        name: 'Script PM',
        source: { type: 'script', script: 'echo hello', scriptAction: 'task-if-output' },
      });
      expect(created.source.script).toBe('echo hello');
      expect(created.source.scriptAction).toBe('task-if-output');
    });

    it('_runScript with scriptAction feed posts output to feed', async () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('hello');
      const created = pm.create({
        name: 'Feed Script',
        source: { type: 'script', script: 'echo hello', scriptAction: 'feed' },
      });
      pm.get(created.id).enabled = true;
      await pm._runScript(created.id);
      expect(taskQueue.pushFeed).toHaveBeenCalledWith(
        'task', null,
        expect.stringContaining('script output:'),
      );
      expect(taskQueue.createTask).not.toHaveBeenCalled();
    });

    it('_runScript with scriptAction task creates task with script output', async () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('hello');
      const created = pm.create({
        name: 'Task Script',
        source: { type: 'script', script: 'echo hello', scriptAction: 'task' },
      });
      pm.get(created.id).enabled = true;
      await pm._runScript(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledWith(
        expect.stringContaining('hello'),
        'auto', null, null,
        expect.objectContaining({ source: 'pm:Task Script' }),
      );
    });

    it('_runScript with scriptAction task-if-output skips task on empty output', async () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('');
      const created = pm.create({
        name: 'TIO Script',
        source: { type: 'script', script: 'true', scriptAction: 'task-if-output' },
      });
      pm.get(created.id).enabled = true;
      await pm._runScript(created.id);
      expect(taskQueue.createTask).not.toHaveBeenCalled();
    });

    it('_runScript with scriptAction task-if-output creates task on non-empty output', async () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('result');
      const created = pm.create({
        name: 'TIO Script',
        source: { type: 'script', script: 'echo result', scriptAction: 'task-if-output' },
      });
      pm.get(created.id).enabled = true;
      await pm._runScript(created.id);
      expect(taskQueue.createTask).toHaveBeenCalled();
    });

    it('_runScript sets lastError on script failure', async () => {
      vi.spyOn(pm, '_exec').mockRejectedValue(new Error('Command failed: exit 1'));
      const created = pm.create({
        name: 'Fail Script',
        source: { type: 'script', script: 'exit 1', scriptAction: 'feed' },
      });
      pm.get(created.id).enabled = true;
      await pm._runScript(created.id);
      expect(pm.get(created.id).lastError).toBeTruthy();
    });

    it('_runScript skips duplicate active tasks', async () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('hello');
      const created = pm.create({
        name: 'Dedup Script',
        source: { type: 'script', script: 'echo hello', scriptAction: 'task' },
      });
      pm.get(created.id).enabled = true;
      taskQueue.tasks.set('existing', {
        id: 'existing', text: 'hello', status: 'queued',
        meta: { source: 'pm:Dedup Script' },
      });
      await pm._runScript(created.id);
      expect(taskQueue.createTask).not.toHaveBeenCalled();
    });

    it('_runScript respects instructions', async () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('output');
      const created = pm.create({
        name: 'Instr Script',
        source: { type: 'script', script: 'echo output', scriptAction: 'task' },
        instructions: 'Review carefully',
      });
      pm.get(created.id).enabled = true;
      await pm._runScript(created.id);
      expect(taskQueue.createTask).toHaveBeenCalled();
      const callArgs = taskQueue.createTask.mock.calls[0];
      expect(callArgs[0]).toContain('output');
      expect(callArgs[0]).toContain('Instructions: Review carefully');
    });

    it('_runScript respects targetSession and designation', async () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('output');
      const created = pm.create({
        name: 'Target Script',
        source: { type: 'script', script: 'echo output', scriptAction: 'task' },
        targetSession: 3,
        designation: 'devops',
      });
      pm.get(created.id).enabled = true;
      await pm._runScript(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledWith(
        expect.any(String),
        'manual', // targetSession forces manual mode
        3,
        'devops',
        expect.anything(),
      );
    });

    it('_startPolling with script source + no schedule uses setInterval', () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('');
      const created = pm.create({
        name: 'Script Interval',
        source: { type: 'script', script: 'echo hi', scriptAction: 'feed' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      const timer = pm.timers.get(created.id);
      expect(timer).toBeDefined();
      expect(typeof timer.stop).not.toBe('function');
    });

    it('_startPolling with script source + schedule uses cron.schedule()', () => {
      vi.spyOn(pm, '_exec').mockResolvedValue('');
      const created = pm.create({
        name: 'Script Cron',
        source: { type: 'script', script: 'echo hi', scriptAction: 'feed' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      const timer = pm.timers.get(created.id);
      expect(timer).toBeDefined();
      expect(typeof timer.stop).toBe('function');
    });
  });

  // ── Completion conditions ──

  describe('completionConditions', () => {
    it('stores completionConditions on create', () => {
      const created = pm.create({
        name: 'CC PM',
        completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
      });
      expect(created.completionConditions).toEqual([{ type: 'github-pr-state', states: ['merged'] }]);
    });

    it('defaults completionConditions to empty array', () => {
      const created = pm.create({ name: 'No CC' });
      expect(created.completionConditions).toEqual([]);
    });

    it('serialization round-trip preserves completionConditions', () => {
      pm.create({
        name: 'CC Round Trip',
        completionConditions: [
          { type: 'github-pr-state', states: ['merged', 'closed'] },
          { type: 'jira-status', statuses: ['Done', 'Closed'] },
        ],
      });
      const data = pm.serialize();
      expect(data[0].completionConditions).toHaveLength(2);

      const pm2 = new ProjectManager(taskQueue);
      pm2.loadState(data);
      const loaded = pm2.getAll()[0];
      expect(loaded.completionConditions).toEqual([
        { type: 'github-pr-state', states: ['merged', 'closed'] },
        { type: 'jira-status', statuses: ['Done', 'Closed'] },
      ]);
      pm2.stopAll();
    });

    it('loadState handles missing completionConditions (backward compat)', () => {
      const pm2 = new ProjectManager(taskQueue);
      pm2.loadState([{
        id: '50',
        name: 'Old PM',
        source: { type: 'jira', jql: 'test' },
        enabled: false,
      }]);
      expect(pm2.get('50').completionConditions).toEqual([]);
      pm2.stopAll();
    });

    it('_checkCompletions skips PM without completionConditions', async () => {
      const created = pm.create({ name: 'No CC PM' });
      created.enabled = true;
      const spy = vi.spyOn(pm, '_evaluateCompletion');
      await pm._checkCompletions(created.id);
      expect(spy).not.toHaveBeenCalled();
    });

    it('_checkCompletions skips tasks without sourceKey', async () => {
      const created = pm.create({
        name: 'CC PM',
        completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
      });
      created.enabled = true;
      // Add a task without sourceKey
      taskQueue.tasks.set('t1', {
        id: 't1', status: 'queued', source: 'pm:CC PM', sourceKey: null,
      });
      const spy = vi.spyOn(pm, '_evaluateCompletion');
      await pm._checkCompletions(created.id);
      expect(spy).not.toHaveBeenCalled();
    });

    it('_checkCompletions skips completed tasks', async () => {
      const created = pm.create({
        name: 'CC PM',
        completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
      });
      created.enabled = true;
      taskQueue.tasks.set('t1', {
        id: 't1', status: 'completed', source: 'pm:CC PM', sourceKey: 'org/repo#1',
      });
      const spy = vi.spyOn(pm, '_evaluateCompletion');
      await pm._checkCompletions(created.id);
      expect(spy).not.toHaveBeenCalled();
    });

    it('_checkCompletions auto-completes GitHub PR task when merged', async () => {
      const created = pm.create({
        name: 'GH PM',
        completionConditions: [{ type: 'github-pr-state', states: ['merged', 'closed'] }],
      });
      created.enabled = true;
      taskQueue.tasks.set('t1', {
        id: 't1', status: 'queued', source: 'pm:GH PM', sourceKey: 'org/repo#42',
      });
      vi.spyOn(pm, '_httpRequest').mockResolvedValue({ merged: true, state: 'closed' });
      vi.spyOn(pm, '_githubHeaders').mockReturnValue({ Authorization: 'Bearer test' });

      await pm._checkCompletions(created.id);

      const task = taskQueue.tasks.get('t1');
      expect(task.status).toBe('completed');
      expect(task.result).toContain('PR #42 merged');
      expect(taskQueue.pushFeed).toHaveBeenCalledWith(
        'task', undefined,
        expect.stringContaining('auto-completed'),
      );
    });

    it('_checkCompletions auto-completes dispatched task via completeTask', async () => {
      const created = pm.create({
        name: 'GH PM2',
        completionConditions: [{ type: 'github-pr-state', states: ['closed'] }],
      });
      created.enabled = true;
      taskQueue.tasks.set('t2', {
        id: 't2', status: 'dispatched', source: 'pm:GH PM2', sourceKey: 'org/repo#10',
        assignedTo: 5,
      });
      taskQueue.completeTask = vi.fn().mockReturnValue({
        id: 't2', status: 'completed',
      });
      vi.spyOn(pm, '_httpRequest').mockResolvedValue({ merged: false, state: 'closed' });
      vi.spyOn(pm, '_githubHeaders').mockReturnValue({ Authorization: 'Bearer test' });

      await pm._checkCompletions(created.id);

      expect(taskQueue.completeTask).toHaveBeenCalledWith('t2', 'Auto-completed: PR #10 closed');
    });

    it('_checkCompletions auto-completes JIRA task when status matches', async () => {
      const created = pm.create({
        name: 'JIRA PM',
        completionConditions: [{ type: 'jira-status', statuses: ['Done', 'Closed'] }],
      });
      created.enabled = true;
      taskQueue.tasks.set('t3', {
        id: 't3', status: 'queued', source: 'pm:JIRA PM', sourceKey: 'DEV-123',
      });
      // Set env vars for JIRA
      const origBase = process.env.JIRA_BASE_URL;
      const origEmail = process.env.JIRA_EMAIL;
      const origToken = process.env.JIRA_API_TOKEN;
      process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
      process.env.JIRA_EMAIL = 'test@test.com';
      process.env.JIRA_API_TOKEN = 'token';
      vi.spyOn(pm, '_httpRequest').mockResolvedValue({
        fields: { status: { name: 'Done' } },
      });

      await pm._checkCompletions(created.id);

      const task = taskQueue.tasks.get('t3');
      expect(task.status).toBe('completed');
      expect(task.result).toContain('DEV-123 status: Done');

      process.env.JIRA_BASE_URL = origBase;
      process.env.JIRA_EMAIL = origEmail;
      process.env.JIRA_API_TOKEN = origToken;
    });

    it('_checkCompletions does not complete when condition not met', async () => {
      const created = pm.create({
        name: 'GH PM3',
        completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
      });
      created.enabled = true;
      taskQueue.tasks.set('t4', {
        id: 't4', status: 'queued', source: 'pm:GH PM3', sourceKey: 'org/repo#5',
      });
      vi.spyOn(pm, '_httpRequest').mockResolvedValue({ merged: false, state: 'open' });
      vi.spyOn(pm, '_githubHeaders').mockReturnValue({ Authorization: 'Bearer test' });

      await pm._checkCompletions(created.id);

      expect(taskQueue.tasks.get('t4').status).toBe('queued');
    });

    it('_checkCompletions handles API errors gracefully', async () => {
      const created = pm.create({
        name: 'Err PM',
        completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
      });
      created.enabled = true;
      taskQueue.tasks.set('t5', {
        id: 't5', status: 'queued', source: 'pm:Err PM', sourceKey: 'org/repo#99',
      });
      vi.spyOn(pm, '_httpRequest').mockRejectedValue(new Error('Network error'));
      vi.spyOn(pm, '_githubHeaders').mockReturnValue({ Authorization: 'Bearer test' });

      // Should not throw
      await pm._checkCompletions(created.id);
      expect(taskQueue.tasks.get('t5').status).toBe('queued');
    });

    it('_poll stores sourceKey on created tasks', async () => {
      const created = pm.create({
        name: 'SK PM',
        source: { type: 'github-prs', repo: 'org/repo' },
      });
      created.enabled = true;
      const mockTask = { id: 'st1', text: '', status: 'queued' };
      taskQueue.createTask = vi.fn().mockReturnValue(mockTask);
      vi.spyOn(pm, '_fetchGithubPrs').mockResolvedValue([
        { key: 'org/repo#7', summary: 'Test PR', issueType: 'pr', storyPoints: null },
      ]);
      vi.spyOn(pm, '_checkCompletions').mockImplementation(() => {});

      await pm._poll(created.id);

      expect(mockTask.sourceKey).toBe('org/repo#7');
    });
  });

  // ── Integration / edge cases ──

  describe('integration / edge cases', () => {
    it('PM with schedule + manual source — uses cron schedule', () => {
      const created = pm.create({
        name: 'Manual Cron',
        source: { type: 'manual', text: 'Do it' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      expect(pm.timers.has(created.id)).toBe(true);
      expect(pm.get(created.id).enabled).toBe(true);
    });

    it('PM with schedule + slack source — schedule is ignored', () => {
      const created = pm.create({
        name: 'Slack Cron',
        source: { type: 'slack' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      expect(pm.timers.has(created.id)).toBe(false);
    });

    it('rapid toggle on/off/on does not leak timers (cron)', () => {
      const created = pm.create({
        name: 'Rapid Cron',
        source: { type: 'command', command: '/test' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id); // on
      pm.toggle(created.id); // off
      pm.toggle(created.id); // on
      // Should have exactly one timer
      expect(pm.timers.size).toBe(1);
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('rapid toggle on/off/on does not leak timers (interval)', () => {
      const created = pm.create({
        name: 'Rapid Int',
        source: { type: 'command', command: '/test' },
        pollInterval: 60000,
      });
      pm.toggle(created.id); // on
      pm.toggle(created.id); // off
      pm.toggle(created.id); // on
      expect(pm.timers.size).toBe(1);
    });
  });

  // ── Cron validation ──

  describe('cron validation', () => {
    it('invalid cron expression falls back to setInterval', () => {
      const created = pm.create({
        name: 'Bad Cron',
        source: { type: 'command', command: '/test' },
        schedule: 'not a cron',
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      const timer = pm.timers.get(created.id);
      // Should have fallen back to interval (no .stop method)
      expect(timer).toBeDefined();
      expect(typeof timer.stop).not.toBe('function');
    });

    it('invalid cron expression sets lastError', () => {
      const created = pm.create({
        name: 'Bad Cron',
        source: { type: 'command', command: '/test' },
        schedule: 'invalid expr',
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(pm.get(created.id).lastError).toContain('Invalid cron expression');
    });

    it('valid cron expression does not set lastError', () => {
      const created = pm.create({
        name: 'Good Cron',
        source: { type: 'command', command: '/test' },
        schedule: '*/5 * * * *',
      });
      pm.toggle(created.id);
      expect(pm.get(created.id).lastError).toBeNull();
    });

    it('empty string schedule is treated as no schedule', () => {
      const created = pm.create({
        name: 'Empty Cron',
        source: { type: 'command', command: '/test' },
        schedule: '',
        pollInterval: 60000,
      });
      // Empty string is falsy, so schedule defaults to null via create
      expect(pm.get(created.id).schedule).toBeNull();
    });

    it('3-field expression falls back to interval', () => {
      const created = pm.create({
        name: 'Bad 3-field',
        source: { type: 'command', command: '/test' },
        schedule: '* * *',
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(typeof pm.timers.get(created.id).stop).not.toBe('function');
    });

    it('out-of-range minute falls back to interval', () => {
      const created = pm.create({
        name: 'Bad min',
        source: { type: 'command', command: '/test' },
        schedule: '60 * * * *',
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(typeof pm.timers.get(created.id).stop).not.toBe('function');
    });

    it('nonsense text falls back to interval', () => {
      const created = pm.create({
        name: 'Bad text',
        source: { type: 'command', command: '/test' },
        schedule: 'foo bar baz qux quux',
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(typeof pm.timers.get(created.id).stop).not.toBe('function');
    });

    it('valid weekday schedule is accepted', () => {
      const created = pm.create({
        name: 'Good weekday',
        source: { type: 'command', command: '/test' },
        schedule: '0 9 * * 1-5',
      });
      pm.toggle(created.id);
      expect(typeof pm.timers.get(created.id).stop).toBe('function');
    });

    it('valid monthly schedule is accepted', () => {
      const created = pm.create({
        name: 'Good monthly',
        source: { type: 'command', command: '/test' },
        schedule: '0 0 1 * *',
      });
      pm.toggle(created.id);
      expect(typeof pm.timers.get(created.id).stop).toBe('function');
    });
  });

  // ── _startPolling refactor regression: all source types ──

  describe('_startPolling refactor regression', () => {
    it('jira source without schedule sets interval timer and calls _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'JIRA PM',
        source: { type: 'jira', jql: 'project = TEST' },
        pollInterval: 300000,
      });
      pm.toggle(created.id);
      // Should call _poll immediately
      expect(pollSpy).toHaveBeenCalledWith(created.id);
      // Should set an interval timer
      const timer = pm.timers.get(created.id);
      expect(timer).toBeDefined();
      expect(typeof timer.stop).not.toBe('function');
    });

    it('jira source with schedule sets cron timer and calls _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'JIRA Cron',
        source: { type: 'jira', jql: 'project = TEST' },
        schedule: '0 9 * * 1-5',
      });
      pm.toggle(created.id);
      expect(pollSpy).toHaveBeenCalledWith(created.id);
      const timer = pm.timers.get(created.id);
      expect(typeof timer.stop).toBe('function');
    });

    it('github-issues source sets timer and calls _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'GH Issues',
        source: { type: 'github-issues', repo: 'org/repo' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(pollSpy).toHaveBeenCalledWith(created.id);
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('github-prs source sets timer and calls _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'GH PRs',
        source: { type: 'github-prs', repo: 'org/repo' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(pollSpy).toHaveBeenCalledWith(created.id);
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('github-re-reviews source sets timer and calls _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'GH ReReviews',
        source: { type: 'github-re-reviews', repo: 'org/repo', reviewer: 'user' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(pollSpy).toHaveBeenCalledWith(created.id);
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('jenkins source sets timer and calls _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'Jenkins',
        source: { type: 'jenkins', jobPath: 'my-job' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(pollSpy).toHaveBeenCalledWith(created.id);
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('zoho source sets timer and calls _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'Zoho',
        source: { type: 'zoho', department: '123' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(pollSpy).toHaveBeenCalledWith(created.id);
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('command source calls _createCommandTask not _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const cmdSpy = vi.spyOn(pm, '_createCommandTask').mockImplementation(() => {});
      const created = pm.create({
        name: 'Cmd',
        source: { type: 'command', command: '/test' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(cmdSpy).toHaveBeenCalledWith(created.id);
      expect(pollSpy).not.toHaveBeenCalled();
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('script source calls _runScript not _poll', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const scriptSpy = vi.spyOn(pm, '_runScript').mockImplementation(() => {});
      const created = pm.create({
        name: 'Script',
        source: { type: 'script', script: 'echo hi', scriptAction: 'feed' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(scriptSpy).toHaveBeenCalledWith(created.id);
      expect(pollSpy).not.toHaveBeenCalled();
      expect(pm.timers.has(created.id)).toBe(true);
    });

    it('interval callback fires again after pollInterval elapses', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'Interval Check',
        source: { type: 'jira', jql: 'test' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      expect(pollSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60000);
      expect(pollSpy).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60000);
      expect(pollSpy).toHaveBeenCalledTimes(3);
    });

    it('update while enabled restarts timer with new interval', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const created = pm.create({
        name: 'Restart Test',
        source: { type: 'jira', jql: 'test' },
        pollInterval: 60000,
      });
      pm.toggle(created.id);
      pollSpy.mockClear();

      // Update to faster interval — should restart
      pm.update(created.id, { pollInterval: 30000 });
      // Restart calls _poll immediately again
      expect(pollSpy).toHaveBeenCalledTimes(1);
      pollSpy.mockClear();

      // After 30s (new interval), should fire again
      vi.advanceTimersByTime(30000);
      expect(pollSpy).toHaveBeenCalledTimes(1);
    });

    it('disabled PM does not start polling on loadState', () => {
      const pollSpy = vi.spyOn(pm, '_poll').mockImplementation(() => {});
      const pm2 = new ProjectManager(taskQueue);
      pm2.loadState([{
        id: '99',
        name: 'Disabled',
        source: { type: 'jira', jql: 'test' },
        pollInterval: 60000,
        enabled: false,
      }]);
      expect(pollSpy).not.toHaveBeenCalled();
      expect(pm2.timers.size).toBe(0);
      pm2.stopAll();
    });

    it('enabled PM starts polling on loadState', () => {
      const pm2 = new ProjectManager(taskQueue);
      const pollSpy = vi.spyOn(pm2, '_poll').mockImplementation(() => {});
      pm2.loadState([{
        id: '99',
        name: 'Enabled',
        source: { type: 'jira', jql: 'test' },
        pollInterval: 60000,
        enabled: true,
      }]);
      expect(pollSpy).toHaveBeenCalledWith('99');
      expect(pm2.timers.has('99')).toBe(true);
      pm2.stopAll();
    });
  });
});
