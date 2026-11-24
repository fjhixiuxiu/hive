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
  tq.createTask = vi.fn().mockImplementation((text, mode, targetSession, designation, meta) => {
    const task = {
      id: String(tq.tasks.size + 1),
      text,
      status: 'queued',
      source: (meta && meta.source) || null,
      actionContext: (meta && meta.actionContext) || null,
      sourcePR: (meta && meta.pr) || null,
    };
    tq.tasks.set(task.id, task);
    return task;
  });
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

describe('PM queue dedupe', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
    pm._save = vi.fn();
  });

  afterEach(() => pm.stopAll());

  function makeReReviewPM(debounceMinutes) {
    const created = pm.create({
      name: 'Human Reviews',
      source: { type: 'github-re-reviews', repo: 'org/repo', reviewer: 'nukulb' },
      taskFormat: '/review-pr https://github.com/org/repo/pull/{prNumber}',
      debounceMinutes,
    });
    created.enabled = true;
    vi.spyOn(pm, '_checkCompletions').mockImplementation(() => {});
    vi.spyOn(pm, '_reactOnPR').mockResolvedValue(undefined);
    return created;
  }

  // Each trigger comment is its own key, so seenKeys never suppresses a re-ping.
  function reReviewIssue(commentId) {
    return {
      key: `re-review-org/repo#42-${commentId}`,
      summary: 'Re-review PR #42: Fix the thing',
      issueType: 'pr',
      storyPoints: null,
      _dedupeKey: 'org/repo#42',
      _repo: 'org/repo',
      _prNumber: 42,
      _commentCreatedAt: new Date().toISOString(),
    };
  }

  describe('config', () => {
    it('defaults to 0 (off)', () => {
      expect(pm.create({ name: 'A' }).debounceMinutes).toBe(0);
      expect(pm.create({ name: 'B' }).dedupeAt).toEqual({});
    });

    it('sanitizes garbage and negatives to 0', () => {
      expect(pm.create({ name: 'C', debounceMinutes: -30 }).debounceMinutes).toBe(0);
      expect(pm.create({ name: 'D', debounceMinutes: 'abc' }).debounceMinutes).toBe(0);
      expect(pm.create({ name: 'E', debounceMinutes: '240' }).debounceMinutes).toBe(240);
      expect(pm.create({ name: 'F', debounceMinutes: 12.7 }).debounceMinutes).toBe(12);
    });

    it('survives a save/load round trip', () => {
      const created = makeReReviewPM(240);
      created.dedupeAt = { 'org/repo#42': 1700000000000 };
      const serialized = JSON.parse(JSON.stringify(pm.serialize()));

      const reloaded = new ProjectManager(createMockTaskQueue());
      reloaded._save = vi.fn();
      reloaded.loadState(serialized);
      const back = reloaded.get(created.id);
      expect(back.debounceMinutes).toBe(240);
      expect(back.dedupeAt).toEqual({ 'org/repo#42': 1700000000000 });
      reloaded.stopAll();
    });

    it('loads a PM saved before debounceMinutes and dedupeAt existed as off and empty', async () => {
      const created = makeReReviewPM(0);
      const serialized = JSON.parse(JSON.stringify(pm.serialize()));
      delete serialized[0].debounceMinutes;
      delete serialized[0].dedupeAt;

      const reloaded = new ProjectManager(createMockTaskQueue());
      reloaded._save = vi.fn();
      reloaded.loadState(serialized);
      const back = reloaded.get(created.id);
      expect(back.debounceMinutes).toBe(0);
      expect(back.dedupeAt).toEqual({});

      // And it polls: nothing reads a missing ledger as a crash or a window.
      vi.spyOn(reloaded, '_checkCompletions').mockImplementation(() => {});
      vi.spyOn(reloaded, '_reactOnPR').mockResolvedValue(undefined);
      vi.spyOn(reloaded, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      back.enabled = true;
      await reloaded._poll(created.id);
      expect(reloaded.taskQueue.createTask).toHaveBeenCalledTimes(1);
      expect(back.dedupeAt).toEqual({});
      reloaded.stopAll();
    });

    // Export is the create/load pair's third half: its output is replayed as a
    // pm:create on another fleet. The window is config and must travel; the
    // ledger is runtime state and must not.
    it('exports the debounce window but not the ledger', () => {
      taskQueue.designationDefs = new Map();
      const created = makeReReviewPM(240);
      created.dedupeAt = { 'org/repo#42': 1700000000000 };
      const exported = pm.exportPM(created.id, []);
      expect(exported).toContain('"debounceMinutes": 240');
      expect(exported).not.toContain('dedupeAt');
    });

    it('update() sanitizes and refuses to let a client clobber dedupeAt', () => {
      const created = makeReReviewPM(60);
      created.dedupeAt = { 'org/repo#42': 111 };
      pm.update(created.id, { debounceMinutes: '90', dedupeAt: {} });
      expect(pm.get(created.id).debounceMinutes).toBe(90);
      expect(pm.get(created.id).dedupeAt).toEqual({ 'org/repo#42': 111 });
    });

    it('reset() clears the debounce ledger', () => {
      const created = makeReReviewPM(60);
      created.dedupeAt = { 'org/repo#42': 111 };
      pm.reset(created.id);
      expect(pm.get(created.id).dedupeAt).toEqual({});
    });
  });

  // Jeff's rule: never two entries in the queue for the same PR. Once the task
  // has been taken off the queue (in progress or finished), a new one is fine.
  describe('queue uniqueness (unconditional, debounce off)', () => {
    it('never queues a second task while the first is still queued', async () => {
      const created = makeReReviewPM(0);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);

      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002')]);
      await pm._poll(created.id);
      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1003')]);
      await pm._poll(created.id);

      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
      const queued = [...taskQueue.tasks.values()].filter((t) => t.status === 'queued');
      expect(queued).toHaveLength(1);
    });

    // "Nothing disappears silently": a suppressed trigger is acknowledged on the
    // PR and counted once in the activity feed, not once per trigger.
    it('acknowledges a trigger it skips as already queued, with one feed line per poll', async () => {
      const created = makeReReviewPM(0);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      pm._reactOnPR.mockClear();
      taskQueue.pushFeed.mockClear();

      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002'), reReviewIssue('1003')]);
      await pm._poll(created.id);

      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
      expect(pm._reactOnPR).toHaveBeenCalledWith('org/repo', 42, 'eyes');
      const feed = taskQueue.pushFeed.mock.calls.map((c) => c[2]);
      expect(feed).toEqual(['PM "Human Reviews" skipped 2 triggers already queued']);
    });

    it('collapses several trigger comments arriving in one poll', async () => {
      const created = makeReReviewPM(0);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([
        reReviewIssue('1001'),
        reReviewIssue('1002'),
        reReviewIssue('1003'),
      ]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });

    it('collapses in-poll duplicates even when the first task dispatches instantly', async () => {
      const created = makeReReviewPM(0);
      // Auto-mode dispatch can take the task off the queue before the next
      // issue in the same batch is considered.
      const realCreate = taskQueue.createTask;
      taskQueue.createTask = vi.fn().mockImplementation((...args) => {
        const task = realCreate(...args);
        task.status = 'dispatched';
        return task;
      });
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([
        reReviewIssue('1001'),
        reReviewIssue('1002'),
      ]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });

    it('queues again once the first task has been picked up', async () => {
      const created = makeReReviewPM(0);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);

      for (const t of taskQueue.tasks.values()) t.status = 'dispatched';
      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(2);
    });

    it('queues again once the first task is finished', async () => {
      const created = makeReReviewPM(0);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);

      for (const t of taskQueue.tasks.values()) t.status = 'completed';
      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(2);
    });

    it('treats a snoozed task as still in the queue', async () => {
      const created = makeReReviewPM(0);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);

      for (const t of taskQueue.tasks.values()) t.status = 'snoozed';
      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });

    it('blocks on a task queued before dedupeKey existed (actionContext fallback)', async () => {
      const created = makeReReviewPM(0);
      taskQueue.tasks.set('legacy', {
        id: 'legacy',
        status: 'queued',
        text: '/review-pr https://github.com/org/repo/pull/42',
        source: 'pm:Human Reviews',
        actionContext: { type: 'github-pr', repo: 'org/repo', prNumber: 42 },
      });
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).not.toHaveBeenCalled();
    });

    it("does not let one PM swallow another PM's trigger for the same PR", async () => {
      const created = makeReReviewPM(0);
      taskQueue.tasks.set('other', {
        id: 'other',
        status: 'queued',
        text: 'verify org/repo#42',
        source: 'pm:PR Watch',
        dedupeKey: 'org/repo#42',
      });
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });

    it('applies to non-PR sources too, keyed on the issue key', async () => {
      const created = pm.create({
        name: 'Jira PM',
        source: { type: 'jira', jql: '' },
        debounceMinutes: 0,
      });
      created.enabled = true;
      vi.spyOn(pm, '_checkCompletions').mockImplementation(() => {});
      vi.spyOn(pm, '_fetchJira').mockResolvedValue([
        { key: 'DEV-1', summary: 'Bug', issueType: 'Bug' },
      ]);
      await pm._poll(created.id);
      // Same ticket resurfacing after a seenKeys reset must not double-queue.
      created.seenKeys = [];
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });

    it('stamps dedupeKey on the task it creates', async () => {
      const created = makeReReviewPM(0);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      expect([...taskQueue.tasks.values()][0].dedupeKey).toBe('org/repo#42');
    });
  });

  describe('polling', () => {
    it('queues the same PR once per window, not once per trigger comment', async () => {
      const created = makeReReviewPM(240);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);

      // A fresh ping 1h later — new comment id, same PR. The first task has
      // already been picked up, so only the debounce window can stop this one.
      for (const t of taskQueue.tasks.values()) t.status = 'dispatched';
      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002')]);
      created.dedupeAt['org/repo#42'] = Date.now() - 60 * 60000;
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });

    it('acknowledges a debounced re-ping on GitHub instead of dropping it silently', async () => {
      const created = makeReReviewPM(240);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      for (const t of taskQueue.tasks.values()) t.status = 'dispatched';
      pm._reactOnPR.mockClear();

      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
      expect(pm._reactOnPR).toHaveBeenCalledWith('org/repo', 42, 'eyes');
    });

    it('reports a debounced repeat in the activity feed with its window', async () => {
      const created = makeReReviewPM(240);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      for (const t of taskQueue.tasks.values()) t.status = 'dispatched';
      taskQueue.pushFeed.mockClear();

      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002')]);
      await pm._poll(created.id);
      const feed = taskQueue.pushFeed.mock.calls.map((c) => c[2]);
      expect(feed).toEqual(['PM "Human Reviews" debounced 1 repeat (240m window)']);
    });

    it('queues again once the window has elapsed', async () => {
      const created = makeReReviewPM(240);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);

      // The first task got picked up, so it is out of the queue.
      for (const t of taskQueue.tasks.values()) t.status = 'dispatched';
      created.dedupeAt['org/repo#42'] = Date.now() - 241 * 60000;
      pm._fetchReReviews.mockResolvedValue([reReviewIssue('1002')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(2);
    });

    it('debounces per item, not across the whole PM', async () => {
      const created = makeReReviewPM(240);
      const other = {
        ...reReviewIssue('2001'),
        key: 're-review-org/repo#99-2001',
        _dedupeKey: 'org/repo#99',
        _prNumber: 99,
      };
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001'), other]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(2);
    });

    it('suppresses duplicates that arrive within a single poll', async () => {
      const created = makeReReviewPM(240);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([
        reReviewIssue('1001'),
        reReviewIssue('1002'),
        reReviewIssue('1003'),
      ]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });

    it('debounceMinutes: 0 still records nothing in the ledger', async () => {
      const created = makeReReviewPM(0);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
      expect(created.dedupeAt).toEqual({});
    });

    it('falls back to issue.key when the source supplies no _dedupeKey', async () => {
      const created = pm.create({
        name: 'PR PM',
        source: { type: 'github-prs', repo: 'org/repo' },
        debounceMinutes: 60,
      });
      created.enabled = true;
      vi.spyOn(pm, '_checkCompletions').mockImplementation(() => {});
      vi.spyOn(pm, '_fetchGithubPrs').mockResolvedValue([
        { key: 'org/repo#7', summary: 'PR', issueType: 'pr' },
      ]);
      await pm._poll(created.id);
      expect(created.dedupeAt['org/repo#7']).toBeGreaterThan(0);
    });

    it('prunes ledger entries once they fall outside the window', async () => {
      const created = makeReReviewPM(60);
      created.dedupeAt = {
        'org/repo#1': Date.now() - 120 * 60000,
        'org/repo#2': Date.now() - 10 * 60000,
      };
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([]);
      await pm._poll(created.id);
      expect(Object.keys(created.dedupeAt)).toEqual(['org/repo#2']);
    });

    // The poll prunes only while a window is set, so turning debounce off would
    // otherwise strand whatever the ledger held until the next reset().
    it('clears the ledger when debounce is turned back off', () => {
      const created = makeReReviewPM(60);
      created.dedupeAt = { 'org/repo#1': Date.now(), 'org/repo#2': Date.now() };

      pm.update(created.id, { debounceMinutes: 0 });

      expect(created.debounceMinutes).toBe(0);
      expect(created.dedupeAt).toEqual({});
    });

    it('clears the ledger when debounce is set to a value that sanitizes to 0', () => {
      const created = makeReReviewPM(60);
      created.dedupeAt = { 'org/repo#1': Date.now() };

      pm.update(created.id, { debounceMinutes: 'not a number' });

      expect(created.debounceMinutes).toBe(0);
      expect(created.dedupeAt).toEqual({});
    });

    it('keeps the ledger when debounce is merely changed to another window', () => {
      const created = makeReReviewPM(60);
      const entries = { 'org/repo#1': Date.now() };
      created.dedupeAt = { ...entries };

      pm.update(created.id, { debounceMinutes: 30 });

      expect(created.debounceMinutes).toBe(30);
      expect(created.dedupeAt).toEqual(entries);
    });

    it('keeps the ledger when an unrelated field is updated', () => {
      const created = makeReReviewPM(60);
      const entries = { 'org/repo#1': Date.now() };
      created.dedupeAt = { ...entries };

      pm.update(created.id, { name: 'Renamed' });

      expect(created.dedupeAt).toEqual(entries);
    });

    it('still refuses a client-supplied dedupeAt', () => {
      const created = makeReReviewPM(60);
      pm.update(created.id, { dedupeAt: { injected: Date.now() } });
      expect(created.dedupeAt).toEqual({});
    });
  });

  // A task's sourcePR is a bare number with no repo beside it, so it can only
  // identify a PR inside a scope that already fixes the repo. `pm:<name>` is
  // such a scope, because a PM source is single-repo. These pin which matches
  // carry a repo and which rely on that scope — the distinction an unscoped
  // caller (pmName null) would need to respect.
  describe('what identifies a PR, and what only does so within a PM scope', () => {
    function legacyTask(id, prNumber, source) {
      // No dedupeKey and no actionContext — a task queued before either existed,
      // which is exactly when the sourcePR fallback is reached.
      const task = { id, text: 'Review the thing', status: 'queued', source, sourcePR: prNumber };
      taskQueue.tasks.set(id, task);
      return task;
    }

    it('matches a legacy task by number inside a PM scope', () => {
      legacyTask('1', 42, 'pm:Human Reviews');
      expect(pm._findTaskForPR('org/repo', 42, 'Human Reviews', new Set(['queued']))).toBeTruthy();
    });

    it("does not reach another PM's legacy task", () => {
      // The scope is what makes the bare number safe: a different PM means a
      // different source config, so its repo is not ours to assume.
      legacyTask('1', 42, 'pm:Some Other PM');
      expect(pm._findTaskForPR('org/repo', 42, 'Human Reviews', new Set(['queued']))).toBeNull();
    });

    it('identifies a PR by dedupeKey without needing a PM scope', () => {
      taskQueue.tasks.set('2', {
        id: '2',
        text: 'x',
        status: 'queued',
        source: 'pm:Any',
        dedupeKey: 'org/repo#42',
      });
      expect(pm._findTaskForPR('org/repo', 42, null, new Set(['queued']))).toBeTruthy();
    });

    it('identifies a PR by actionContext without needing a PM scope', () => {
      taskQueue.tasks.set('3', {
        id: '3',
        text: 'x',
        status: 'queued',
        source: 'pm:Any',
        actionContext: { type: 'github-pr', repo: 'org/repo', prNumber: 42 },
      });
      expect(pm._findTaskForPR('org/repo', 42, null, new Set(['queued']))).toBeTruthy();
    });

    it('rejects an actionContext from a different repo', () => {
      taskQueue.tasks.set('4', {
        id: '4',
        text: 'x',
        status: 'queued',
        source: 'pm:Any',
        actionContext: { type: 'github-pr', repo: 'org/other', prNumber: 42 },
      });
      expect(pm._findTaskForPR('org/repo', 42, null, new Set(['queued']))).toBeNull();
    });

    it('identifies a PR by the repo-bearing text fallback', () => {
      taskQueue.tasks.set('5', {
        id: '5',
        text: 'Please review org/repo#42 today',
        status: 'queued',
        source: 'pm:Any',
      });
      expect(pm._findTaskForPR('org/repo', 42, null, new Set(['queued']))).toBeTruthy();
    });

    // The match that carries no repo is withheld from unscoped lookups. Written
    // first as a warning that a future unscoped caller must not rely on it; that
    // caller then arrived (the PR-watch wake path, which asks "is ANY task live
    // for this PR?"), and a task for org/other#42 was answering for org/repo#42
    // — so the watch recorded a verdict it never saw and the parked PR was never
    // woken. Now the bare number only counts inside a scope that fixes the repo.
    it('withholds the bare-number match from an unscoped lookup', () => {
      legacyTask('1', 42, 'pm:Some Other PM');
      expect(pm._findTaskForPR('org/repo', 42, null, new Set(['queued']))).toBeNull();
      expect(
        pm._findTaskForPR('org/completely-different', 42, null, new Set(['queued'])),
      ).toBeNull();
    });

    it('keeps queue dedupe working for a PM whose tasks predate dedupeKey', () => {
      // The end-to-end guarantee, and why the fallback is kept at all.
      legacyTask('1', 42, 'pm:Human Reviews');
      expect(pm._hasQueuedDuplicate('Human Reviews', 'org/repo#42')).toBe(true);
    });
  });

  // The text fallback is a substring search, and `org/repo#4` is a substring of
  // `org/repo#42` and of `bigorg/repo#4`. On main that search only ran for the
  // re-review source; the queue-uniqueness guard now runs it for every repo#N
  // key, including github-issues, whose default text is "[org/repo#42] title"
  // and whose actionContext is not a github-pr one — so it reaches the fallback.
  describe('the text fallback matches a whole reference, not a prefix of one', () => {
    function textTask(id, text) {
      taskQueue.tasks.set(id, { id, text, status: 'queued', source: 'pm:Issues' });
    }

    it('does not let org/repo#42 answer for org/repo#4', () => {
      textTask('1', '[org/repo#42] Crash on save');
      expect(pm._findTaskForPR('org/repo', 4, 'Issues', new Set(['queued']))).toBeNull();
      expect(pm._findTaskForPR('org/repo', 4, null, new Set(['queued']))).toBeNull();
    });

    it('does not let another owner whose name ends with ours answer for us', () => {
      textTask('1', '[bigorg/repo#42] Crash on save');
      expect(pm._findTaskForPR('org/repo', 42, null, new Set(['queued']))).toBeNull();
    });

    it('still matches the reference when punctuation or text surrounds it', () => {
      textTask('1', '[org/repo#42] Crash on save');
      textTask('2', 'Please look at org/repo#7, then close it');
      textTask('3', 'org/repo#9');
      expect(pm._findTaskForPR('org/repo', 42, null, new Set(['queued']))).toBeTruthy();
      expect(pm._findTaskForPR('org/repo', 7, null, new Set(['queued']))).toBeTruthy();
      expect(pm._findTaskForPR('org/repo', 9, null, new Set(['queued']))).toBeTruthy();
    });

    // A re-review PM with no taskFormat writes "[<issue.key>] <summary>", and
    // that key is "re-review-org/repo#10-700" — the reference sits right after a
    // hyphen and right before one. This is the one text shape on which the old
    // guard genuinely worked, so the fallback must keep matching it.
    it('still matches the default re-review text, where hyphens touch both ends', () => {
      textTask('1', '[re-review-org/repo#10-700] Re-review PR #10: Fix the thing');
      expect(pm._findTaskForPR('org/repo', 10, 'Issues', new Set(['queued']))).toBeTruthy();
      expect(pm._findTaskForPR('org/repo', 1, 'Issues', new Set(['queued']))).toBeNull();
    });

    it('queues issue 4 while issue 42 from the same repo is still queued', async () => {
      const created = pm.create({
        name: 'Issues',
        source: { type: 'github-issues', repo: 'org/repo' },
      });
      created.enabled = true;
      vi.spyOn(pm, '_checkCompletions').mockImplementation(() => {});
      vi.spyOn(pm, '_fetchGithubIssues').mockResolvedValue([
        { key: 'org/repo#42', summary: 'Crash on save', issueType: 'issue' },
      ]);
      await pm._poll(created.id);

      pm._fetchGithubIssues.mockResolvedValue([
        { key: 'org/repo#4', summary: 'Typo in README', issueType: 'issue' },
      ]);
      await pm._poll(created.id);

      expect(taskQueue.createTask).toHaveBeenCalledTimes(2);
      expect(taskQueue.createTask.mock.calls[1][0]).toContain('org/repo#4]');
    });
  });

  // #351 lets the dashboard create a task under a PM and Track a PR or JIRA key.
  // Those tasks never pass through _poll, so they carry no dedupeKey — only what
  // parseTrack produces: sourceKey, actionContext, and sourcePR. These pin that
  // the PM's own poll recognises them, which #351's "dedupe already suppresses
  // the PM's own duplicate" relies on, and that a Track on another repo does not
  // borrow the PM's scope to match by bare number.
  describe('tasks hand-added from the dashboard (#351)', () => {
    let parseTrack;

    beforeEach(async () => {
      const links = await import('../../src/core/session-links.js');
      parseTrack = (links.default || links).parseTrack;
    });

    function handAdd(pmName, trackInput) {
      const track = parseTrack(trackInput, 'org/repo');
      const task = {
        id: `hand-${taskQueue.tasks.size + 1}`,
        text: 'take a look at this one',
        status: 'queued',
        source: `pm:${pmName}`,
        sourceKey: track.sourceKey || null,
        actionContext: track.actionContext || null,
        sourcePR: track.prNumber || null,
      };
      taskQueue.tasks.set(task.id, task);
      return task;
    }

    it("blocks the PM's own re-review of a PR it already holds by hand", async () => {
      const created = makeReReviewPM(0);
      handAdd('Human Reviews', 'org/repo#42');
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).not.toHaveBeenCalled();
    });

    it('does not block on a hand-added Track for the same number in another repo', async () => {
      const created = makeReReviewPM(0);
      const task = handAdd('Human Reviews', 'other/repo#42');
      // Same PM scope, same bare number — the sourcePR arm would say yes. The
      // github-pr actionContext is authoritative, so it is never consulted.
      expect(task.sourcePR).toBe(42);
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });

    it('blocks a JIRA PM from queueing a ticket already tracked by hand', async () => {
      const created = pm.create({ name: 'Dev Work', source: { type: 'jira', jql: '' } });
      created.enabled = true;
      vi.spyOn(pm, '_checkCompletions').mockImplementation(() => {});
      handAdd('Dev Work', 'DEV-7');
      vi.spyOn(pm, '_fetchJira').mockResolvedValue([
        { key: 'DEV-7', summary: 'Bug', issueType: 'Bug' },
      ]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).not.toHaveBeenCalled();
    });

    it('lets the PM queue it once the hand-added task has dispatched', async () => {
      const created = makeReReviewPM(0);
      handAdd('Human Reviews', 'https://github.com/org/repo/pull/42').status = 'dispatched';
      vi.spyOn(pm, '_fetchReReviews').mockResolvedValue([reReviewIssue('1001')]);
      await pm._poll(created.id);
      expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
    });
  });
});
