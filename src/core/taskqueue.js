const log = require('./log');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const relay = require('./relay');
const fleet = require('./fleet');
const tmux = require('./tmux');
const sessionManager = require('./session-manager');
const { cloneOrReuse } = require('./git-utils');
const tqUsers = require('./tq-users');
const tqFeatures = require('./tq-features');
const sessionLinks = require('./session-links');
const { SessionState, TaskStatus, ApprovalStatus, transitionTask } = require('./vocab');

const STATE_FILE = path.join(__dirname, '..', '..', '.hive-state.json');

let nextTaskId = 1;
let nextApprovalId = 1;

class TaskQueue extends EventEmitter {
  constructor(config, watcher, router) {
    super();
    this.config = config;
    this.watcher = watcher;
    this.router = router;

    // State
    this.tasks = new Map(); // id -> Task
    this.autoSessions = new Set(); // session numbers opted into auto-mode
    // Slots the user explicitly switched OFF auto. Auto/Manual is otherwise
    // just presence in autoSessions, so "Manual" is an absence — and an absence
    // is indistinguishable from "never configured". When a manual session died,
    // the auto-create block claimed its freed slot and added it straight back.
    this.manualSessions = new Set();
    this.designations = new Map(); // session num -> designation string
    this.feed = []; // ring buffer, max 200
    this.approvals = new Map(); // id -> Approval
    this.users = new Map(); // login -> { login, name, avatar, permissions, firstSeen }
    this.dispatchLock = new Set(); // session numbers currently being dispatched to
    this._warnedNoHiveMcp = new Set(); // sessions already warned about a missing hive MCP entry
    this._autoDispatching = false; // re-entrancy guard for _tryAutoDispatch
    this.activeTaskBySession = new Map(); // session num -> task id
    this.lastDispatchedAt = new Map(); // session num -> timestamp of last task dispatch
    this.lastCompletedAt = new Map(); // session num -> timestamp of last task completion (cooldown)
    this.spawnedAgents = new Map(); // slot num -> { repoDir, name }
    this.spawnSlotMin = 1;
    this.spawnSlotMax = 32;
    this.vimMode = false;
    this.taskAutoComplete = true; // when false, tasks require manual completion
    // Which of the two return-to-queue buttons the dashboard renders. Both
    // do the same thing to the session and differ only in where the task
    // lands, so a fleet that only ever wants one of them can hide the other.
    this.showRequeueBtn = true;
    this.showDeferBtn = true;
    // The switch above only guards _handleSessionIdle. A session calling
    // hive_complete_task walks straight past it, because that is a deliberate
    // act rather than a timeout — which is why a fleet with auto-complete off
    // still watched tasks close themselves and rotate. This is the gate for
    // wanting neither: it applies requireHumanClose to every completion,
    // whatever its source, so nothing closes without a person saying so.
    this.requireHumanCloseAll = false;
    this.autoCreateForManualTasks = false; // when true, _tryAutoDispatch spawns a session for any queued auto-mode task that has no source PM
    this.repoSessionCaps = new Map(); // repoBaseName -> max session count
    this._snoozeTimers = new Map(); // taskId → setTimeout handle
    this.checklistTemplates = new Map(); // name → { name, items: [string] }
    this.sessionContext = new Map(); // session num -> { plan: '/path', pr: 'url', jira: 'KEY', ... }
    this.slackDedup = new Map(); // Slack event.ts -> markedAt (ms). Persisted dedup of
    // processed @mentions so Slack retries don't create duplicate
    // tasks across bot restarts. TTL/GC owned by the bot.

    // Backup configuration
    this.backupConfig = {
      localDir: '/Users/dev/dev/hive-backup-data',
      icloudDir: '/Users/dev/Library/Mobile Documents/com~apple~CloudDocs/hive-backups',
      retentionDays: 14,
      icloudRetentionDays: 30,
      cronSchedule: '7 * * * *',
    };

    // Configurable work states for the board
    // autoOnStatus: when a task's system status changes to one of these, auto-set workState
    this.workStates = [
      { id: 'backlog', label: 'Backlog', color: '#6272a4', autoOnStatus: ['queued'] },
      { id: 'planning', label: 'Planning', color: '#bd93f9', autoOnStatus: ['dispatched'] },
      { id: 'in-progress', label: 'In Progress', color: '#ffb86c', autoOnStatus: [] },
      { id: 'review', label: 'Review', color: '#8be9fd', autoOnStatus: [] },
      { id: 'testing', label: 'Testing', color: '#f1fa8c', autoOnStatus: [] },
      { id: 'done', label: 'Done', color: '#50fa7b', autoOnStatus: ['completed', 'cancelled'] },
    ];

    // Designation definitions + agent file scanning
    this.designationDefs = new Map(); // name → { name, agentFiles: [], description: '' }
    this.agentRoots = []; // array of scan paths (e.g. '~/dev/agents/')
    this.agentFilesList = []; // cached scan results: [{ path, name, relativePath, root }]

    // Auto-pilot rules
    this.rules = [
      {
        id: 'ci-fail-fix',
        name: 'Auto-fix CI failures',
        enabled: false,
        trigger: 'ci:fail',
        action: 'dispatch-fix',
      },
      {
        id: 'review-changes',
        name: 'Auto-address review changes',
        enabled: false,
        trigger: 'review:changes_requested',
        action: 'dispatch-fix',
      },
      {
        id: 'idle-next-task',
        name: 'Auto-pick next task on idle',
        enabled: true,
        trigger: 'session:idle',
        action: 'auto-dispatch',
      },
    ];

    // Load persisted state
    this._loadState();

    // Wire watcher events
    this._wireWatcher();

    // Reconcile stale dispatched tasks on startup.
    // If hive was stopped while a task was dispatched, the session may have finished
    // and gone idle while hive wasn't running. On restart, these tasks stay "dispatched"
    // forever because no session:idle event fires (no state *transition* occurs).
    // We DON'T auto-complete here — sessions may be idle due to crashes/API outages,
    // not because the task is done. Instead, just log and let the watcher's normal
    // session:idle events handle completion going forward.
    setTimeout(async () => {
      try {
        const sessions = await fleet.getFleetStatus(this.config, this.router);
        let staleCount = 0;
        for (const [num, taskId] of this.activeTaskBySession) {
          const s = sessions.find((s) => s.num === num);
          const task = this.tasks.get(taskId);
          if (
            s &&
            s.state === SessionState.IDLE &&
            (!task || task.status !== TaskStatus.DISPATCHED)
          ) {
            staleCount++;
            log.info(
              `[reconcile] S:${num} is idle with stale task mapping (task=${taskId}, status=${task?.status}), clearing lock`,
            );
            log.info(`[taskmap] S:${num} ✕ task ${taskId} (reconcile — stale)`);
            this.dispatchLock.delete(num);
            this.activeTaskBySession.delete(num);
          } else if (s && task?.status === TaskStatus.DISPATCHED) {
            // Session has an in-progress dispatched task — keep lock held regardless of apparent state
            log.info(
              `[reconcile] S:${num} has dispatched task "${(task.text || '').slice(0, 60)}" — keeping lock`,
            );
          }
        }
        if (staleCount > 0) {
          log.info(
            `[reconcile] Cleared locks on ${staleCount} idle session(s) with dispatched tasks`,
          );
        }
      } catch (err) {
        log.error('Startup reconcile error:', err.message);
      }
    }, 12000);

    // Seed watcher activity from restored tasks so timestamps show immediately
    for (const [sessionNum, taskId] of this.activeTaskBySession) {
      const task = this.tasks.get(taskId);
      if (task) {
        const ts = task.lastActivityAt || task.dispatchedAt || task.createdAt;
        if (ts && this.watcher) this.watcher.sessionActivity.set(sessionNum, ts);
      }
    }

    // Delayed dispatch after startup -- give sessions time to boot (60s)
    // then check once. Ongoing dispatch is event-driven (session:idle, designation change, etc.)
    setTimeout(() => {
      this._tryAutoDispatch().catch((err) => log.error('Auto-dispatch error:', err.message));
    }, 60000);

    // Periodic backlog check — catches tasks stuck when sessions boot after startup
    // or when idle events are missed. Runs every 30s.
    this._backlogInterval = setInterval(() => {
      const hasQueued = Array.from(this.tasks.values()).some((t) => t.status === TaskStatus.QUEUED);
      if (hasQueued) {
        this._tryAutoDispatch().catch((err) => log.error('Backlog check error:', err.message));
      }
    }, 30000);
  }

  /**
   * Drop a session's entry from the state cache after its task ends.
   *
   * This used to write the literal 'idle' instead of removing the file, to stop
   * a stale cached 'working' from looking like a busy session (f525370). The
   * cure had the same disease: nothing in hive ever deletes these files, and the
   * only other writer is the optional idle-watcher.sh daemon from the setup
   * guide. On a fleet where that daemon is not running — but the directory
   * exists, because it ran earlier — the written 'idle' was never corrected by
   * anything. fleet.getSession() prefers the cache over live detection, so the
   * session reported idle permanently, however busy it actually was.
   *
   * Removing the entry asks fleet to look at the pane instead of trusting a
   * value hive made up. That is the same answer when the session really is idle,
   * and the truth when it is not.
   *
   * Best-effort: a missing file or directory is the normal case on installs that
   * never ran the daemon, and a failure here must not fail task completion.
   *
   * Known gap, unchanged by this: for a session on a remote node the state file
   * lives on that host, while this (like the write before it) touches the local
   * filesystem. Remote entries are written and expired by the daemon there.
   */
  _invalidateStateCache(sessionNum) {
    try {
      fs.unlinkSync(path.join(this.config.cache.stateDir, String(sessionNum)));
    } catch {
      // ENOENT is the common, healthy case — no cache file to invalidate.
    }
  }

  // -- Task lifecycle -----------------------------------------------

  createTask(text, mode, targetSession, designation, meta) {
    const task = {
      id: String(nextTaskId++),
      text,
      title: (meta && meta.title) || null,
      mode, // 'auto' or 'manual'
      targetSession: targetSession || null,
      designation: designation || null,
      status: TaskStatus.QUEUED,
      assignedTo: null,
      createdAt: Date.now(),
      dispatchedAt: null,
      completedAt: null,
      result: null,
      source: (meta && meta.source) || null, // e.g. 'ci-fail', 'review-changes'
      // The identity a PM's continue/completion conditions key on. The poll
      // loop assigns this after the call (pm.js) because it already holds the
      // issue; a caller outside a poll loop passes it in here instead.
      sourceKey: (meta && meta.sourceKey) || null,
      // [Phase 1 — context-consolidation] sourcePR kept for back-compat.
      // Phase 2 will remove this field; PR is already tracked live via fleet
      // (s.pr) and in sessionContext.pr. Plan marks this LOW RISK but requires
      // auditing consumers (see plan risk #6 "task.sourcePR in tests").
      // See: ~/dev/agents/hive/context-consolidation-plan.md (Step 6)
      sourcePR: (meta && meta.pr) || null, // PR number that triggered this
      sourceSession: (meta && meta.session) || null, // session that triggered this
      createdBy: (meta && meta.createdBy) || null, // GitHub login of creator
      actionContext: (meta && meta.actionContext) || null, // contextual actions metadata
      workState: (meta && meta.workState) || null,
      workStateManual: false,
      assignee: (meta && meta.assignee) || null,
      requireHumanClose: meta?.requireHumanClose !== undefined ? !!meta.requireHumanClose : false,
      pendingResult: null, // set when MCP tries to complete a requireHumanClose task
      pendingCompleteAt: null,
    };
    this.tasks.set(task.id, task);
    // A new task lands at the back, which is what set() already does. Anything
    // else has to be asked for, so the default is unchanged.
    if (meta && meta.queuePosition != null) {
      this.moveTaskToQueuePosition(task.id, meta.queuePosition, { silent: true });
    }
    this.emit('task:created', task);
    const byWho = task.createdBy ? ` by ${task.createdBy}` : '';
    this.pushFeed('task', null, `Task created${byWho}: "${text}" (${mode})`);
    // Persist BEFORE dispatching. Nothing else in this path is guaranteed to
    // write: _tryAutoDispatch only saves when it actually dispatches, so a task
    // queued behind a busy fleet would live in memory alone until some
    // unrelated state change happened to flush it — and a restart in that
    // window loses it outright.
    this._saveState();

    if (mode === 'manual' && targetSession) {
      this._dispatchTask(task, targetSession).catch((err) =>
        log.error('Dispatch error:', err.message),
      );
    } else if (mode === 'auto') {
      // Try to dispatch immediately to an idle auto-session
      this._tryAutoDispatch().catch((err) => log.error('Auto-dispatch error:', err.message));
    }

    return task;
  }

  /**
   * Attach a tracking task to an already-working session.
   * No dispatch, no /clear, no relay — just bookkeeping.
   */
  attachTask(text, sessionNum, meta) {
    const task = {
      id: String(nextTaskId++),
      text,
      mode: 'manual',
      targetSession: sessionNum,
      designation: null,
      status: TaskStatus.DISPATCHED,
      assignedTo: sessionNum,
      createdAt: Date.now(),
      dispatchedAt: Date.now(),
      lastActivityAt: Date.now(),
      completedAt: null,
      result: null,
      source: (meta && meta.source) || 'attached',
      // [Phase 1 — context-consolidation] see createTask() for notes. Same
      // removal target in Phase 2. ~/dev/agents/hive/context-consolidation-plan.md
      sourcePR: (meta && meta.pr) || null,
      sourceSession: sessionNum,
      actionContext: (meta && meta.actionContext) || null,
      workState: (meta && meta.workState) || null,
      workStateManual: false,
      assignee: (meta && meta.assignee) || null,
    };
    this.tasks.set(task.id, task);
    log.info(`[taskmap] S:${sessionNum} ← task ${task.id} (createTaskOnSession)`);
    this.activeTaskBySession.set(sessionNum, task.id);
    this.dispatchLock.add(sessionNum);
    this.emit('task:created', task);
    this.emit('task:dispatched', task);
    this.pushFeed('task', sessionNum, `Task attached to session ${sessionNum}: "${text}"`);
    this._saveState();
    return task;
  }

  updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    // workState and assignee can be changed on any task regardless of status
    if ('workState' in updates) {
      task.workState = updates.workState;
      task.workStateManual = true;
    }
    if ('assignee' in updates) {
      task.assignee = updates.assignee;
    }
    if ('requireHumanClose' in updates) {
      task.requireHumanClose = !!updates.requireHumanClose;
    }

    // Other fields only on queued/snoozed tasks
    if (task.status === TaskStatus.QUEUED || task.status === TaskStatus.SNOOZED) {
      const normalized =
        'title' in updates && updates.title === '' ? { ...updates, title: null } : updates;
      const allowed = ['text', 'title', 'mode', 'targetSession', 'designation', 'actionContext'];
      for (const key of allowed) {
        if (key in normalized) task[key] = normalized[key];
      }
    }

    this.emit('task:updated', task);
    this._saveState();
    return task;
  }

  /**
   * Rename a task — edits ONLY the displayed title. The prompt body
   * (`task.text`) is never touched. If the task previously had no
   * title, this sets one for the first time. Works on any status.
   * Returns the updated task or null if not found.
   */
  renameTask(taskId, newName) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (!newName || typeof newName !== 'string') return null;
    const trimmed = newName.trim();
    if (!trimmed) return null;
    task.title = trimmed;
    this.emit('task:updated', task);
    this._saveState();
    return task;
  }

  /**
   * Manually dispatch a queued task to a specific session.
   */
  async dispatchTaskTo(taskId, sessionNum) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.QUEUED) return null;
    task.mode = 'manual';
    task.targetSession = sessionNum;
    await this._dispatchTask(task, sessionNum);
    return task;
  }

  requeueTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.DISPATCHED) return null;
    if (task.assignedTo) {
      log.info(`[taskmap] S:${task.assignedTo} ✕ task ${task.id} (requeue)`);
      this.activeTaskBySession.delete(task.assignedTo);
      this.dispatchLock.delete(task.assignedTo);
      this.clearSessionContext(task.assignedTo);
    }
    const prevSession = task.assignedTo;
    transitionTask(task, TaskStatus.QUEUED);
    task.workStateManual = false;
    task.assignedTo = null;
    task.dispatchedAt = null;
    task.targetSession = null;
    this.emit('task:requeued', task);
    this.pushFeed('task', prevSession, `Task returned to queue: "${task.text}"`);
    this._saveState();
    return task;
  }

  /**
   * Return a task to the queue at the BACK of the line.
   *
   * requeueTask puts a task back "where it was", and where it was is its
   * position in this.tasks — a Map, so insertion order, which is exactly the
   * order _tryAutoDispatch walks. That makes requeueing an OLD task a
   * promotion: it sits ahead of everything queued since. Defer is the other
   * half of that decision — same release, but re-inserted last.
   *
   * Takes a dispatched task (releases the session, as requeue does) or one that
   * is already queued (pure de-prioritisation, nothing to release). Snoozed
   * tasks are left alone: they are already out of the dispatch set, and their
   * timer would return them to the queue anyway.
   */
  deferTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== TaskStatus.DISPATCHED && task.status !== TaskStatus.QUEUED))
      return null;
    const prevSession = task.assignedTo;
    if (task.assignedTo) {
      log.info(`[taskmap] S:${task.assignedTo} ✕ task ${task.id} (defer)`);
      this.activeTaskBySession.delete(task.assignedTo);
      this.dispatchLock.delete(task.assignedTo);
      this.clearSessionContext(task.assignedTo);
    }
    // Defer takes an already-queued task as pure de-prioritisation, so this can
    // be queued → queued. That is not permitted by the table — it is not in it —
    // it is permitted because transitionTask short-circuits when prev === next.
    // Only the Map position changes.
    transitionTask(task, TaskStatus.QUEUED);
    task.workStateManual = false;
    task.assignedTo = null;
    task.dispatchedAt = null;
    task.targetSession = null;
    // Stamped so the card can say WHY this one is sitting at the back, and so
    // the queue view can group deferred work last instead of by createdAt.
    task.deferredAt = Date.now();
    // Re-insert last. delete+set is the only way to move a key in a Map, and
    // the Map IS the queue order — see _tryAutoDispatch.
    this.tasks.delete(task.id);
    this.tasks.set(task.id, task);
    this.emit('task:deferred', task);
    this.pushFeed(
      'task',
      prevSession ?? null,
      `Task deferred to the back of the queue: "${task.text}"`,
    );
    this._saveState();
    return task;
  }

  /**
   * Move a task to a 1-based position among the QUEUED tasks.
   *
   * Position is global and means "nth to be considered", not "nth to run".
   * _tryAutoDispatch walks the queue in order but only hands a task to a
   * session whose designation matches, so a task at position 1 still waits for
   * a session that can host it. One flat number, matching the one walk the
   * dispatcher actually does.
   *
   * Rebuilds this.tasks because a Map has no insert-at-index — the same reason
   * moving to the back is a delete+set. Everything else keeps its relative
   * order, dispatched and completed tasks included: they are interleaved in
   * the Map and reordering them would be a change nobody asked for. Refills
   * the existing Map rather than replacing it, so held references stay valid.
   *
   * @param {string} taskId
   * @param {number} position - 1 = front. Clamped to the queue's bounds.
   * @param {object} [opts] - { silent: true } to skip the event, for callers
   *   that are about to emit their own (createTask emits task:created).
   */
  moveTaskToQueuePosition(taskId, position, opts) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.QUEUED) return null;

    const target = Math.max(1, Math.floor(Number(position) || 1));
    const entries = Array.from(this.tasks.entries()).filter(([id]) => id !== taskId);

    // Walk to the slot the target-th queued task occupies. Counting queued
    // entries as we go is what keeps position meaningful while non-queued
    // tasks sit between them.
    let seen = 0;
    let insertAt = entries.length;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i][1].status !== TaskStatus.QUEUED) continue;
      seen++;
      if (seen === target) {
        insertAt = i;
        break;
      }
    }
    entries.splice(insertAt, 0, [taskId, task]);

    this.tasks.clear();
    for (const [id, t] of entries) this.tasks.set(id, t);

    this._saveState();
    if (!(opts && opts.silent)) {
      this.emit('task:moved', task);
      this.pushFeed(
        'task',
        null,
        `Task moved to queue position ${this.getQueuePosition(taskId)}: "${task.text}"`,
      );
    }
    return task;
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED)
      return null;

    // Clear snooze timer if task was snoozed
    if (this._snoozeTimers.has(taskId)) {
      clearTimeout(this._snoozeTimers.get(taskId));
      this._snoozeTimers.delete(taskId);
    }

    if (task.status === TaskStatus.DISPATCHED && task.assignedTo) {
      log.info(`[taskmap] S:${task.assignedTo} ✕ task ${task.id} (cancel)`);
      this.activeTaskBySession.delete(task.assignedTo);
      this.clearSessionContext(task.assignedTo);
    }
    transitionTask(task, TaskStatus.CANCELLED);
    task.workStateManual = false;
    this.emit('task:cancelled', task);
    this.pushFeed('task', task.assignedTo, `Task cancelled: "${task.text}"`);
    return task;
  }

  snoozeTask(taskId, durationMs) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    // If dispatched, requeue first (requeue already clears session context)
    if (task.status === TaskStatus.DISPATCHED) {
      this.requeueTask(taskId);
    }
    if (task.status !== TaskStatus.QUEUED) return null;
    transitionTask(task, TaskStatus.SNOOZED);
    task.workStateManual = false;
    task.snoozedUntil = Date.now() + durationMs;
    this._armSnoozeTimer(task);
    this.emit('task:snoozed', task);
    this.pushFeed('task', null, `Task snoozed: "${task.text}"`);
    this._saveState();
    return task;
  }

  unsnoozeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.SNOOZED) return null;
    if (this._snoozeTimers.has(taskId)) {
      clearTimeout(this._snoozeTimers.get(taskId));
      this._snoozeTimers.delete(taskId);
    }
    transitionTask(task, TaskStatus.QUEUED);
    task.workStateManual = false;
    task.snoozedUntil = null;
    this.emit('task:unsnoozed', task);
    this.pushFeed('task', null, `Task unsnoozed: "${task.text}"`);
    this._saveState();
    this._tryAutoDispatch().catch((err) => log.error('Auto-dispatch error:', err.message));
    return task;
  }

  _armSnoozeTimer(task) {
    const remaining = task.snoozedUntil - Date.now();
    if (remaining <= 0) {
      this._wakeTask(task.id);
    } else {
      const timer = setTimeout(() => this._wakeTask(task.id), remaining);
      this._snoozeTimers.set(task.id, timer);
    }
  }

  _wakeTask(taskId) {
    this._snoozeTimers.delete(taskId);
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.SNOOZED) return;
    transitionTask(task, TaskStatus.QUEUED);
    task.workStateManual = false;
    task.snoozedUntil = null;
    this.emit('task:unsnoozed', task);
    this.pushFeed('task', null, `Snoozed task woke up: "${task.text}"`);
    this._saveState();
    this._tryAutoDispatch().catch((err) => log.error('Auto-dispatch error:', err.message));
  }

  /**
   * Resume a completed/failed task — put it back to dispatched (in-progress)
   * on the same session it originally ran on, as a manual task so it won't
   * auto-complete when the session goes idle.
   */
  resumeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED) return null;
    if (!task.assignedTo) return null;

    // Check if session already has an active task
    const existingTaskId = this.activeTaskBySession.get(task.assignedTo);
    if (existingTaskId && existingTaskId !== taskId) return null;

    transitionTask(task, TaskStatus.DISPATCHED);
    task.workStateManual = false;
    task.mode = 'manual';
    task.completedAt = null;
    task.lastActivityAt = Date.now();

    log.info(`[taskmap] S:${task.assignedTo} ← task ${task.id} (resume)`);
    this.activeTaskBySession.set(task.assignedTo, task.id);
    // Don't set dispatchLock — manual tasks don't hold the lock

    this.emit('task:dispatched', task);
    this.pushFeed(
      'task',
      task.assignedTo,
      `Task resumed on session ${task.assignedTo}: "${task.text}"`,
    );
    this._saveState();
    return task;
  }

  /**
   * Complete a task.
   * @param {string} taskId
   * @param {string} result - summary text
   * @param {string} [snapshot] - terminal snapshot
   * @param {number} [snapshotCols]
   * @param {object} [opts] - { force: true } to bypass requireHumanClose and
   *   the hive-wide requireHumanCloseAll switch. This is what a person clicking
   *   Done or Park passes: their click IS the approval.
   * @returns {object|null|'pending'} task, null if not found, or 'pending' if awaiting human approval
   */
  completeTask(taskId, result, snapshot, snapshotCols, opts) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.DISPATCHED) return null;

    // Gate: requireHumanClose blocks MCP-initiated completions. The hive-wide
    // switch is the same gate with a wider net — it turns every task into a
    // requireHumanClose task without needing each PM to be configured for it.
    if ((task.requireHumanClose || this.requireHumanCloseAll) && !(opts && opts.force)) {
      task.pendingResult = result || 'Completed via MCP';
      task.pendingCompleteAt = Date.now();
      this.emit('task:pending-complete', task);
      this.pushFeed(
        'task',
        task.assignedTo,
        `Task pending approval: "${task.text.substring(0, 60)}..."`,
      );
      this._saveState();
      return 'pending';
    }

    transitionTask(task, TaskStatus.COMPLETED);
    task.workStateManual = false;
    task.completedAt = Date.now();
    task.result = result || null;
    task.pendingResult = null;
    task.pendingCompleteAt = null;
    task.snapshot = snapshot || null;
    task.snapshotCols = snapshotCols || 0;

    const sessionNum = task.assignedTo;
    if (sessionNum) {
      log.info(
        `[taskmap] S:${sessionNum} ✕ task ${task.id} (complete, "${(task.text || '').slice(0, 60)}")`,
      );
      this.activeTaskBySession.delete(sessionNum);
      this.dispatchLock.delete(sessionNum);
      this.lastCompletedAt.set(sessionNum, Date.now());
      this._invalidateStateCache(sessionNum);

      // [Phase 2 — context-consolidation] TODO: snapshot sessionContext.slackThread
      // into task._completionContext HERE, before clearSessionContext wipes it.
      // Phase 1 sidesteps this by keeping task.slackChannel/slackThreadTs alive on
      // the task object itself (bot.js reply-back reads them directly). Once
      // Phase 2 removes those fields, this snapshot becomes CRITICAL for Slack
      // reply-back to work after completion. See plan risk #1 "Slack reply-back
      // on task completion (CRITICAL)".
      // Ref: ~/dev/agents/hive/context-consolidation-plan.md
      // Clear session context so stale PR/branch/plan data doesn't leak into next task
      this.clearSessionContext(sessionNum);
    }

    const duration = task.dispatchedAt
      ? Math.round((task.completedAt - task.dispatchedAt) / 60000)
      : 0;
    this.emit('task:completed', task);
    this.pushFeed('task', task.assignedTo, `Task completed: "${task.text}" (${duration}m)`);
    this._saveState();
    // Dispatch next queued task now that a session is free
    this._tryAutoDispatch().catch((err) => log.error('Auto-dispatch error:', err.message));
    return task;
  }

  approveComplete(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.pendingResult) return null;
    return this.completeTask(taskId, task.pendingResult, null, 0, { force: true });
  }

  rejectComplete(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.pendingResult) return null;
    task.pendingResult = null;
    task.pendingCompleteAt = null;
    this.pushFeed(
      'task',
      task.assignedTo,
      `Task completion rejected — task continues on S:${task.assignedTo}`,
    );
    this._saveState();
    this.emit('task:reject-complete', task);
    return task;
  }

  failTask(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.DISPATCHED) return null;

    transitionTask(task, TaskStatus.FAILED);
    task.workStateManual = false;
    task.completedAt = Date.now();
    task.result = error;

    if (task.assignedTo) {
      log.info(`[taskmap] S:${task.assignedTo} ✕ task ${task.id} (fail: ${error})`);
      this.activeTaskBySession.delete(task.assignedTo);
      this.dispatchLock.delete(task.assignedTo);
      this.lastCompletedAt.set(task.assignedTo, Date.now());
      this._invalidateStateCache(task.assignedTo);
      // [Phase 2 — context-consolidation] TODO: same snapshot pattern as
      // completeTask — capture sessionContext.slackThread into task._completionContext
      // before clearing. See completeTask for details and plan ref.
      this.clearSessionContext(task.assignedTo);
    }

    this.emit('task:failed', task);
    this.pushFeed('task', task.assignedTo, `Task failed: "${task.text}" -- ${error}`);
    return task;
  }

  async _dispatchTask(task, sessionNum) {
    if (this.dispatchLock.has(sessionNum)) return false;
    this.dispatchLock.add(sessionNum); // lock immediately before any await

    const found = await fleet.findSession(this.config, this.router, sessionNum);
    if (!found) {
      this.dispatchLock.delete(sessionNum);
      this.failTask(task.id, `Session ${sessionNum} not found`);
      return false;
    }

    const { name: sessionName, nodeId } = found;
    const node = this.router.getNode(nodeId);

    // Double-check no other task is active on this session
    const existingActive = this.activeTaskBySession.get(sessionNum);
    if (existingActive && existingActive !== task.id) {
      this.dispatchLock.delete(sessionNum);
      return false; // silently skip -- don't fail the task, just don't dispatch yet
    }

    transitionTask(task, TaskStatus.DISPATCHED);
    task.workStateManual = false;
    task.assignedTo = sessionNum;
    task.dispatchedAt = Date.now();
    task.lastActivityAt = Date.now();
    // The task got its turn — drop the deferred stamp so the card stops
    // claiming it is waiting at the back of a queue it has already left.
    task.deferredAt = null;
    // Update watcher activity timestamp on dispatch
    if (this.watcher) this.watcher.sessionActivity.set(sessionNum, Date.now());
    const prevTaskId = this.activeTaskBySession.get(sessionNum);
    if (prevTaskId && prevTaskId !== task.id) {
      log.warn(`[taskmap] S:${sessionNum} OVERWRITE task ${prevTaskId} → ${task.id} (dispatch)`);
    }
    log.info(
      `[taskmap] S:${sessionNum} ← task ${task.id} (dispatch, "${(task.text || '').slice(0, 60)}")`,
    );
    this.activeTaskBySession.set(sessionNum, task.id);
    this.lastDispatchedAt.set(sessionNum, Date.now());

    // Auto-set slack thread in session context if task has one.
    //
    // [Phase 1 — context-consolidation] Bridges old task.slackChannel/slackThreadTs
    // → new sessionContext.slackThread so thread routing via sessionContext works.
    // Old fields are still the primary write path (bot.js sets them on task
    // creation); this dispatch-time sync is the new path being bootstrapped.
    //
    // Phase 2 will:
    //   1. Read task._slackContext (staging field set by createTask meta)
    //   2. setSessionContext with the same shape
    //   3. delete task._slackContext (it's been propagated, no longer needed)
    //
    // See: ~/dev/agents/hive/context-consolidation-plan.md (Step 2: _dispatchTask)
    if (task.slackChannel && task.slackThreadTs) {
      this.setSessionContext(sessionNum, {
        slackThread: `${task.slackChannel}:${task.slackThreadTs}`,
      });
    }

    this.emit('task:dispatched', task);
    this.pushFeed('task', sessionNum, `Task dispatched to session ${sessionNum}: "${task.text}"`);
    log.info(
      `[dispatch] Task ${task.id} dispatched to S:${sessionNum}: "${task.text.slice(0, 80)}"`,
    );
    this._saveState();

    // Fire-and-forget, after the dispatch is committed: this is a warning, not
    // a gate. A session with no hive entry still runs the task perfectly well —
    // it just cannot report it.
    this._warnIfHiveMcpMissing(node, sessionNum).catch(() => {});

    // Fire-and-forget: send the task text to Claude
    // Clear context first so the agent starts fresh.
    //
    // relay.ask rather than relay.tell + fixed sleep: ask polls
    // tmux.detectState() and only returns after the session is confirmed
    // idle. A blind 2500ms sleep raced when /clear took longer under load,
    // leaving the next paste to land mid-clear → interleaved input and
    // Claude Code crashes. Observed on S:34 on 2026-04-15.
    // See: ~/dev/agents/hive/clear-paste-race-plan.md
    const sendTask = async () => {
      const cleared = await relay.ask(this.config, node, sessionName, '/clear', {
        vimMode: this.vimMode,
      });
      // The relay refused to type into the pane at all (a startup dialog, or a
      // shell where Claude should be). Every step below sends keys too, so stop
      // here and let the refusal fail the task with its reason. Any other /clear
      // outcome carries on exactly as before.
      if (cleared && cleared.refused) return cleared;

      // Defense-in-depth: relay.ask returns success when the session is idle,
      // but if the Enter after `/clear` was lost (vim-mode paste race), the
      // session was already idle and stays idle — so success is reported even
      // though /clear never fired. The next paste then lands on top of the
      // unsubmitted /clear and the agent runs the task on stale context.
      // Look for `/clear` still visible in the input box and flush it.
      try {
        const paneTarget = tmux.paneTarget(sessionName, this.config.sessions.claudePane);
        const tail = await node.capturePane(paneTarget, { lines: 8 });
        // A bare Enter into anything but Claude runs whatever sits on its
        // command line — a shell's, or a REPL's.
        if (
          tail &&
          /\/clear\s*$/m.test(tail) &&
          !(await relay.nonClaudeProgram(node, paneTarget))
        ) {
          log.warn(`[dispatch] /clear unsubmitted on S:${sessionNum}, sending safety Enter`);
          await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch {}

      // Build message with agent file preamble if designation has agent files
      let fullMessage = this._pmManager ? this._pmManager.enrichTaskText(task) : task.text;
      const desigName = task.designation || this.designations.get(sessionNum);
      const desigDef = desigName ? this.designationDefs.get(desigName) : null;
      if (desigDef && desigDef.agentFiles && desigDef.agentFiles.length > 0) {
        const parts = [];
        for (const f of desigDef.agentFiles) {
          try {
            parts.push(fs.readFileSync(f, 'utf8'));
          } catch {}
        }
        if (parts.length > 0) {
          // Preserve the enriched text (PM instructions, Slack contact, MCP block)
          // built above — don't fall back to raw task.text, or we silently drop it.
          fullMessage = parts.join('\n\n---\n\n') + '\n\n---\n\nTASK:\n' + fullMessage;
        }
      }
      return relay.tell(this.config, node, sessionName, fullMessage, { vimMode: this.vimMode });
    };

    sendTask()
      .then((result) => {
        log.info(
          `[dispatch] Task ${task.id} send ${result.success ? 'OK' : 'FAILED'} to S:${sessionNum}${result.error ? ': ' + result.error : ''}`,
        );
        if (!result.success) {
          this.failTask(task.id, result.error || 'Tell failed');
        }
        // Don't unlock dispatchLock here -- wait for session to go idle
      })
      .catch((err) => {
        this.failTask(task.id, err.message);
      });

    return true;
  }

  /**
   * Say so in the feed when a task is dispatched to a session whose repo has no
   * hive entry in .mcp.json.
   *
   * Today that session fails silently in the most expensive way available: it
   * reads the task out of the pane, does the work, and then has no
   * hive_complete_task to close it with. The task sits dispatched, the slot
   * stays locked, and nothing anywhere says why.
   *
   * Cost: one read of one small file per dispatch — not per poll — and only the
   * first time for a given session, until the entry turns up. node.readFile so
   * a remote session's repo is read on its own host rather than looked for on
   * this one.
   *
   * @param {object} node - the node that owns the session
   * @param {number} sessionNum
   */
  async _warnIfHiveMcpMissing(node, sessionNum) {
    const repoDir = this.getRepoDir(sessionNum);
    const mcpPath = path.join(repoDir, '.mcp.json');
    const text = await node.readFile(mcpPath);
    if (sessionManager.hiveArgsFrom(text)) {
      // Deployed since we last looked — say so again if it goes away again.
      this._warnedNoHiveMcp.delete(sessionNum);
      return;
    }
    if (this._warnedNoHiveMcp.has(sessionNum)) return;
    this._warnedNoHiveMcp.add(sessionNum);
    const detail =
      `Session ${sessionNum} cannot call hive_get_task or hive_complete_task — ` +
      `no hive MCP entry in ${mcpPath}. Deploy MCP from Settings.`;
    log.warn(`[dispatch] ${detail}`);
    this.pushFeed('state', sessionNum, detail);
  }

  /**
   * Clean up all TaskQueue state for a killed session.
   * Fails active task, removes dispatch lock and spawned agent tracking.
   *
   * Only ever reached from a person closing a session — the Kill button and
   * Shut Down All. The watcher never calls it, so a session that dies on its
   * own (tmux crash, OOM, reboot) does not come through here.
   *
   * That is exactly the line the Manual mark is drawn on. Manual sticks to the
   * SLOT so it outlives a session dying unexpectedly, which is what stops
   * auto-create seizing a slot someone is hand-driving. But closing a session
   * is a person releasing the slot on purpose, and holding the mark past that
   * is a one-way ratchet: every Manual session ever closed permanently costs a
   * slot, invisibly, because a slot with no session renders no chip to undo it.
   *
   * The same reasoning applies to everything else keyed by session number. A
   * slot is reused — auto-create spawns straight back into it — so anything
   * left behind is inherited by a session that has nothing to do with the work
   * it describes.
   */
  cleanupSession(num) {
    const taskId = this.activeTaskBySession.get(num);
    if (taskId) {
      log.info(`[taskmap] S:${num} ✕ task ${taskId} (cleanupSession — session killed)`);
      this.failTask(taskId, 'Session killed');
    }
    this.activeTaskBySession.delete(num);
    this.dispatchLock.delete(num);
    // The slot is free: whatever lands in it next is a different repo as far as
    // this warning is concerned, and deserves to be told the same thing.
    this._warnedNoHiveMcp.delete(num);
    this.spawnedAgents.delete(num);
    this.autoSessions.delete(num);
    this.manualSessions.delete(num);
    this.lastDispatchedAt.delete(num);
    // The dispatch cooldown. Left behind, it is charged to whoever lands in
    // this slot next — a brand new session made to sit out its first 15s.
    this.lastCompletedAt.delete(num);
    // Same defect as the auto-create path: a raw Map write that no client hears
    // about. It reads as the milder of the two — the chip belongs to a session
    // that just vanished — right up until a new session lands in the freed
    // slot, which is exactly what auto-create does next. Then the stale
    // designation is rendered against somebody else's session.
    const hadDesignation = this.designations.delete(num);
    // Plan, PR, JIRA, branch. Completing a task already clears these; killing
    // the session was the one exit that did not, so the next session in the
    // slot woke up holding a dead session's PR. Park reads exactly these
    // fields to decide what to watch, so a stale one gets the wrong PR parked
    // under someone else's handoff notes.
    this.clearSessionContext(num);
    // A pending approval outlives the session that asked for it, and
    // createApproval dedupes on session + pending — so the stale one is handed
    // back instead of a new approval being raised, and the dashboard shows the
    // dead session's prompt to the live session standing in its place.
    for (const approval of this.approvals.values()) {
      if (approval.session === num && approval.status === 'pending') {
        approval.status = 'denied';
        approval.resolvedAt = Date.now();
        this.emit('approval:resolved', approval);
      }
    }
    this._saveState();
    if (hadDesignation) this.emit('designations:changed', this.getDesignations());
  }

  _handleSessionIdle(num, preview, paneCols) {
    // Complete active task for this session
    const taskId = this.activeTaskBySession.get(num);
    log.info(`[idle] S:${num} idle — ${taskId ? 'checking task ' + taskId : 'no active task'}`);
    if (taskId) {
      const task = this.tasks.get(taskId);
      // Global kill switch: if taskAutoComplete is off, never auto-close anything.
      // This applies to all task modes AND sources — an attached task is sacred.
      if (!this.taskAutoComplete) {
        log.info(`[idle] S:${num} idle — auto-complete disabled, leaving task ${taskId} attached`);
        return;
      }
      if (!task || task.mode !== 'manual') {
        this.completeTask(taskId, null, preview || null, paneCols);
      } else if (task.source && task.source.startsWith('slack:')) {
        // Slack-originated manual tasks complete on idle like auto tasks
        this.completeTask(taskId, null, preview || null, paneCols);
      } else {
        // Manual task — don't clear locks or dispatch next
        return;
      }
    }
    this.dispatchLock.delete(num);

    // Retry any queued manual tasks targeting this session
    const pendingManual = Array.from(this.tasks.values()).find(
      (t) => t.status === TaskStatus.QUEUED && t.mode === 'manual' && t.targetSession === num,
    );
    if (pendingManual) {
      this._dispatchTask(pendingManual, num).catch((err) =>
        log.error('Manual retry dispatch error:', err.message),
      );
    }
  }

  async _tryAutoDispatch() {
    if (this._autoDispatching) return;
    this._autoDispatching = true;
    try {
      const sessions = await fleet.getFleetStatus(this.config, this.router);

      // First: retry queued manual tasks with a targetSession
      // For targeted tasks, dispatch if the session has no active task — don't require
      // fleet state === SessionState.IDLE since the state file can be stale
      const manualTargeted = Array.from(this.tasks.values()).filter(
        (t) => t.status === TaskStatus.QUEUED && t.mode === 'manual' && t.targetSession,
      );
      for (const task of manualTargeted) {
        const session = sessions.find((s) => s.num === task.targetSession);
        if (
          session &&
          !this.dispatchLock.has(session.num) &&
          !this.activeTaskBySession.has(session.num)
        ) {
          await this._dispatchTask(task, task.targetSession);
        }
      }

      // Then: tasks eligible for auto-dispatch. Always: auto-mode queued. When
      // autoCreateForManualTasks is on: also manual-mode queued tasks that have
      // no targetSession — those are "untriaged" queue entries (often from a
      // PM in manual triage mode). Manual tasks WITH a targetSession stay out
      // of this list — they're handled by the targeted retry above.
      const queuedTasks = Array.from(this.tasks.values()).filter((t) => {
        if (t.status !== TaskStatus.QUEUED) return false;
        if (t.mode === 'auto') return true;
        if (t.mode === 'manual' && !t.targetSession && this.autoCreateForManualTasks) return true;
        return false;
      });
      if (!queuedTasks.length) return;

      const COOLDOWN_MS = 15000; // 15s cooldown after completion before re-dispatch
      const now = Date.now();
      const idleAuto = sessions.filter(
        (s) =>
          this.autoSessions.has(s.num) &&
          !this.dispatchLock.has(s.num) &&
          !this.activeTaskBySession.has(s.num) &&
          now - (this.lastCompletedAt.get(s.num) || 0) > COOLDOWN_MS,
      );
      // NOTE: do NOT early-return when idleAuto is empty. The auto-create block below
      // must still run — spawning a session is exactly what's needed when nothing is
      // free. The dispatch loop simply no-ops when there are no candidate sessions.

      // Sort by least recently used — sessions idle longest get tasks first
      idleAuto.sort(
        (a, b) => (this.lastDispatchedAt.get(a.num) || 0) - (this.lastDispatchedAt.get(b.num) || 0),
      );

      // Dispatch one task per idle session.
      // Designated tasks prefer sessions with matching designation.
      // In "flexible" mode (default), they fall back to undesignated sessions.
      // In "strict" mode, they only dispatch to sessions with matching designation.
      // Cross-designation is always forbidden (e.g. a 'cherrypick' task won't
      // go to an 'ios'-designated session).
      // Undesignated tasks still only go to undesignated sessions.
      const dispatched = new Set(); // track sessions claimed this round
      for (const task of queuedTasks) {
        if (task.status !== TaskStatus.QUEUED) continue;
        const candidates = idleAuto.filter((s) => !dispatched.has(s.num));
        const pm = this._getSourcePm(task);
        const matchMode = (pm && pm.designationMatch) || 'flexible';
        let best = null;
        if (task.designation) {
          best = candidates.find((s) => this.designations.get(s.num) === task.designation);
          if (!best && matchMode === 'flexible') {
            best = candidates.find((s) => !this.designations.get(s.num));
          }
        } else {
          best = candidates.find((s) => !this.designations.get(s.num));
        }
        if (best) {
          dispatched.add(best.num);
          await this._dispatchTask(task, best.num);
        }
      }

      // Auto-create session for queued tasks. Source-PM intent wins; the
      // global toggle is only a fallback for tasks that have no source PM.
      //
      //  - PM with autoCreate=true → spawn (the original #285 path).
      //  - PM with autoCreate=false → NEVER spawn, regardless of global toggle.
      //    Those PMs are manual-review queues by design (e.g. "Human Reviews")
      //    and the global toggle must not silently override the PM owner's
      //    intent — that's how an EVV-targeted toggle ended up spinning up
      //    five "Code Review" sessions for the Human Reviews backlog.
      //  - No source PM (dashboard-typed, etc.) + no targetSession + global
      //    toggle on → spawn. This is the catch-all path the toggle exists for.
      const autoCreateTasks = queuedTasks.filter((t) => {
        if (t.status !== TaskStatus.QUEUED) return false;
        const pm = this._getSourcePm(t);
        if (pm) return !!pm.autoCreate;
        if (this.autoCreateForManualTasks && !t.targetSession) return true;
        return false;
      });

      // Diagnostic: surface the spawn decision. A queued autoCreate task with no free
      // auto-session is the case that should spawn — log the inputs so a stuck backlog
      // is visible (this used to bail silently at the idleAuto early-return above).
      if (autoCreateTasks.length) {
        log.info(
          `[auto-dispatch] ${autoCreateTasks.length} autoCreate task(s) queued; ${idleAuto.length} free auto-session(s), ${sessions.length} in fleet`,
        );
      }

      // Group by designation + matchMode (both affect which sessions count)
      // Key: "desig|matchMode" (e.g. "webplatform|flexible" or "|flexible" for undesignated)
      const byDesigMode = new Map();
      for (const t of autoCreateTasks) {
        const d = t.designation || null;
        const pm = this._getSourcePm(t);
        const mode = (pm && pm.designationMatch) || 'flexible';
        const key = `${d === null ? '' : d}|${mode}`;
        if (!byDesigMode.has(key)) byDesigMode.set(key, { desig: d, matchMode: mode, tasks: [] });
        byDesigMode.get(key).tasks.push(t);
      }

      // Track slots claimed *within this _tryAutoDispatch invocation*. Fleet
      // state is queried fresh in getAvailableSlots(), but a session created
      // milliseconds ago isn't yet visible to fleet — so a second iteration
      // would re-pick the same slot, the second createSession would no-op
      // (tmux tolerates duplicate -d -s), and `designations.set(num, desig)`
      // would run twice with the LAST writer winning. That's the bug that
      // tagged the EVV/dashboard spawns with "Code Review" — the Code Review
      // iteration came second and clobbered the undesignated one's slot.
      const claimedThisRound = new Set();
      for (const [, { desig, matchMode, tasks }] of byDesigMode) {
        // Check if there's already an idle or booting session for this designation.
        // In flexible mode, undesignated sessions count as potential hosts.
        // In strict mode, only sessions with matching designation count.
        const matching = sessions.filter((s) => {
          const sd = this.designations.get(s.num);
          if (!desig) return !sd;
          if (sd === desig) return true;
          return matchMode === 'flexible' && !sd;
        });
        const hasIdle = matching.some(
          (s) =>
            s.state === SessionState.IDLE &&
            this.autoSessions.has(s.num) &&
            !this.dispatchLock.has(s.num) &&
            !this.activeTaskBySession.has(s.num),
        );
        const hasBooting = matching.some(
          (s) =>
            s.state !== SessionState.IDLE &&
            this.autoSessions.has(s.num) &&
            !this.activeTaskBySession.has(s.num),
        );
        if (hasIdle || hasBooting) continue;

        // A designation cap is a ceiling on what hive spawns for itself, not on
        // how many sessions of a kind may exist. Sessions added by hand count
        // toward it — the lane really is that full — but nothing here blocks
        // anyone from adding them, and no other path reads the cap.
        //
        // It lives on the designation's own definition rather than in a map
        // keyed by name: renameDesignationDef carries the def object across and
        // removeDesignationDef deletes it, so the cap follows a rename and dies
        // with the designation. A second name-keyed store is the one neither
        // function would have updated.
        //
        // Undesignated work is uncapped: "no designation" is not a lane.
        if (desig) {
          const def = this.designationDefs.get(desig);
          const desigCap = def && def.sessionCap;
          if (Number.isInteger(desigCap)) {
            const live = this._countDesignationSessions(sessions, desig);
            if (live >= desigCap) {
              log.info(
                `[auto-dispatch] Designation "${desig}" at session cap (${live}/${desigCap}) — not spawning for ${tasks.length} queued task(s)`,
              );
              continue;
            }
          }
        }

        try {
          const slots = await this.getAvailableSlots();
          if (slots.length === 0) {
            log.info(
              `[auto-dispatch] queued ${desig || 'undesignated'} task but no free slots (${this.spawnSlotMin}-${this.spawnSlotMax} all occupied) — cannot spawn`,
            );
            continue;
          }
          // Never claim a slot the user set to Manual. Its session dying is
          // exactly when the slot looks free, so without this the setting is
          // silently undone at the worst possible moment.
          const usable = slots.filter((s) => !this.manualSessions.has(s));
          if (usable.length === 0) {
            log.info(
              `[auto-dispatch] free slots (${slots.slice(0, 5).join(', ')}) are all set to Manual — not spawning`,
            );
            continue;
          }
          // ...nor one an earlier task in this same round already claimed.
          // getAvailableSlots() reads the fleet, which does not yet show a
          // session we decided to create moments ago, so without this every
          // task in the round targets the same slot.
          const num = usable.find((s) => !claimedThisRound.has(s));
          if (num == null) {
            log.info(
              `[auto-dispatch] every usable slot (${usable.slice(0, 5).join(', ')}) was already claimed this round — cannot spawn`,
            );
            continue;
          }
          const repoDir = this.config.sessions.repoDir(num);
          const repoName = TaskQueue.repoBaseName(repoDir);
          const cap = this.repoSessionCaps.get(repoName);
          if (cap !== undefined && this._countRepoSessions(sessions, repoName) >= cap) {
            log.info(
              `[auto-dispatch] Repo "${repoName}" at session cap (${cap}) — skipping auto-create`,
            );
            continue;
          }
          claimedThisRound.add(num);
          const size = this.config.tmux?.defaultSize || { cols: 200, rows: 50 };
          const prefix = this.config.sessions?.namePrefix || '';
          const sessionName = `${prefix}${num}`;
          const desigLabel = desig || 'undesignated';
          log.info(`[auto-dispatch] No idle ${desigLabel} session — creating session ${num}`);
          // Same read-before-create as spawnSession: createSession mkdir -p's
          // repoDir, so after it every directory exists and nothing can tell a
          // brand-new one from one the operator has had all along.
          const repoExisted = fs.existsSync(repoDir);
          const spawn = await sessionManager.createSession(
            sessionName,
            repoDir,
            this.config.tmux?.defaultLayout || {
              panes: 2,
              tmuxLayout: 'main-vertical',
              claudePaneWidth: '60%',
            },
            size,
          );
          // Before startClaude below: Claude reads .mcp.json once, at startup.
          if (!repoExisted) this._seedMcpConfig(repoDir, num, sessions);
          // Same guard as spawnSession: getAvailableSlots reads a cached fleet,
          // so a slot can be taken between the read and here. Typing `claude`
          // into a pane that already runs one stacks a second REPL on it.
          if (spawn && spawn.skipped) {
            log.info(
              `[auto-dispatch] session ${sessionName} already exists — not starting a second Claude in it`,
            );
          } else {
            await sessionManager.startClaude(
              sessionName,
              this.config.sessions.claudePane,
              'claude',
            );
          }
          this.autoSessions.add(num);
          // setDesignation, not designations.set. The raw Map write stores the
          // designation correctly and tells nobody: a client only ever learns a
          // designation from a 'designations:changed' emit, and this path had
          // none. So a session auto-created INTO a lane rendered as
          // undesignated until the next reconnect, and the obvious operator fix
          // — setting the designation by hand, to the value it already held —
          // worked only because going through this accessor is what emits.
          //
          // Safe to call from inside the dispatch loop: setDesignation ends in
          // _tryAutoDispatch, which returns immediately on the _autoDispatching
          // re-entrancy guard we are currently holding.
          //
          // Persisting: setDesignation already saves, and the autoSessions.add
          // above has happened by then, so a designated auto-create is fully
          // written by that one call. An UNDESIGNATED one never reaches
          // setDesignation, so this else is the only thing that writes its
          // autoSessions entry. Collapsing to an unconditional single save — or
          // dropping this line as a redundant write — would lose that, and hive
          // would forget after a restart that it had auto-created the session.
          if (desig) this.setDesignation(num, desig);
          else this._saveState();
          this.pushFeed('state', num, `Auto-created session ${num} for ${desigLabel} task`);
        } catch (err) {
          log.error(`[auto-dispatch] Failed to auto-create session: ${err.message}`);
        }
      }
    } finally {
      this._autoDispatching = false;
    }
  }

  // Look up the PM that created a task (via task.source = 'pm:<name>')
  _getSourcePm(task) {
    if (!task.source || !task.source.startsWith('pm:') || !this._pmManager) return null;
    const pmName = task.source.slice(3);
    for (const pm of this._pmManager.pms.values()) {
      if (pm.name === pmName) return pm;
    }
    return null;
  }

  // Extract repo base name from a repoDir path (e.g. '/Users/x/Coding/webplatform5' -> 'webplatform')
  static repoBaseName(repoDir) {
    if (!repoDir) return 'unknown';
    const last = repoDir.replace(/\/+$/, '').split('/').pop() || '';
    return last.replace(/\d+$/, '') || last;
  }

  // Count live sessions for a given repo base name
  _countRepoSessions(sessions, repoName) {
    return sessions.filter((s) => {
      const dir = this.getRepoDir(s.num) || this.config.sessions.repoDir(s.num);
      return TaskQueue.repoBaseName(dir) === repoName;
    }).length;
  }

  // Count live sessions carrying a designation. Manual sessions count: the cap
  // describes how many sessions of this kind should exist, and it is only ever
  // enforced against hive's own spawning.
  _countDesignationSessions(sessions, desig) {
    return sessions.filter((s) => this.designations.get(s.num) === desig).length;
  }

  // Get/set repo session caps
  getRepoCaps() {
    const obj = {};
    for (const [k, v] of this.repoSessionCaps) obj[k] = v;
    return obj;
  }

  setRepoCaps(capsObj) {
    this.repoSessionCaps.clear();
    for (const [k, v] of Object.entries(capsObj)) {
      const n = parseInt(v);
      if (k && !isNaN(n) && n >= 0) this.repoSessionCaps.set(k, n);
    }
    this._saveState();
    this.emit('repoCaps:changed', this.getRepoCaps());
  }

  // -- Auto-mode ----------------------------------------------------

  toggleAutoSession(num) {
    if (this.autoSessions.has(num)) {
      this.autoSessions.delete(num);
      // Record the choice, so it survives the session dying.
      this.manualSessions.add(num);
    } else {
      this.autoSessions.add(num);
      this.manualSessions.delete(num);
    }
    this._saveState();
    this.emit('auto:changed', this.getAutoSessions());
    // Re-evaluate dispatch with new auto-session set
    this._tryAutoDispatch().catch((err) => log.error('Auto-dispatch error:', err.message));
    return this.autoSessions.has(num);
  }

  setAutoSessions(nums) {
    this.autoSessions.clear();
    for (const n of nums) {
      this.autoSessions.add(n);
      // Turning a slot on clears the manual mark; slots absent from the list
      // are left alone — bulk-setting the auto list is not a statement about
      // every other slot in the fleet.
      this.manualSessions.delete(n);
    }
    this._saveState();
    this.emit('auto:changed', this.getAutoSessions());
  }

  getAutoSessions() {
    return Array.from(this.autoSessions).sort((a, b) => a - b);
  }

  /**
   * Slots the user has opted out of auto-create.
   *
   * The dashboard needs this separately from the auto list because Manual is
   * an absence there: it draws a chip per LIVE session, so a marked slot whose
   * session is gone renders nothing at all — invisible, unclickable, and still
   * blocking auto-create. Sending the marks lets it draw those slots too.
   */
  getManualSessions() {
    return Array.from(this.manualSessions).sort((a, b) => a - b);
  }

  // -- VIM mode -----------------------------------------------------

  setVimMode(enabled) {
    this.vimMode = !!enabled;
    this._saveState();
    this.emit('vim:changed', this.vimMode);
  }

  setSpawnSlotRange(min, max) {
    min = parseInt(min) || 1;
    max = parseInt(max) || 32;
    if (min < 1) min = 1;
    if (max > 99) max = 99;
    if (min > max) [min, max] = [max, min];
    this.spawnSlotMin = min;
    this.spawnSlotMax = max;
    this._saveState();
    this.emit('spawnSlotRange:changed', { min: this.spawnSlotMin, max: this.spawnSlotMax });
  }

  // -- Spawn -------------------------------------------------------

  async getAvailableSlots() {
    const sessions = await fleet.getFleetStatus(this.config, this.router);
    const occupied = new Set(sessions.map((s) => s.num));
    const slots = [];
    for (let i = this.spawnSlotMin; i <= this.spawnSlotMax; i++) {
      if (!occupied.has(i)) slots.push(i);
    }
    return slots;
  }

  getSpawnedAgent(num) {
    return this.spawnedAgents.get(num) || null;
  }

  getRepoDir(num) {
    const spawned = this.spawnedAgents.get(num);
    if (spawned) return spawned.repoDir;
    return this.config.sessions.repoDir(num);
  }

  /**
   * Write the hive MCP config into a repo directory hive has just created for a
   * session it is starting.
   *
   * Without it the session comes up with no hive MCP server at all — observed
   * live: a session spawned into a fresh repos/a1 listed 7 MCP servers and no
   * hive, and the directory had no .mcp.json whatsoever. It ran its task and
   * then had no hive_get_task to read it or hive_complete_task to close it.
   *
   * Only ever called with a directory this spawn created. seedMcpConfig refuses
   * to touch a .mcp.json that already exists, so a repo the operator deployed
   * to, ran mcp:remove on, or that carried its own file in the clone, is left
   * exactly as it is.
   *
   * The URL, token and session are the ones mcp:deploy writes; --tools is
   * inherited from whichever fleet repo already has a restriction, so a spawned
   * session is handed the same tool set as the fleet it joins rather than the
   * full one. Best-effort: a session that starts without a config is still a
   * working session, so a failure is logged and never fails the spawn.
   *
   * @param {string} repoDir - the newly created repo directory
   * @param {number} num - session slot
   * @param {Array<{num: number}>} [fleetSessions] - live fleet, for --tools
   */
  _seedMcpConfig(repoDir, num, fleetSessions) {
    try {
      const hiveUrl = `ws://127.0.0.1:${process.env.WEB_PORT || 3000}`;
      const token = process.env.WEB_TOKEN || '';
      const tools = this._deployedMcpTools(fleetSessions);
      const wrote = sessionManager.seedMcpConfig(repoDir, hiveUrl, token, num, tools);
      if (wrote) {
        log.info(
          `[mcp] S:${num} seeded hive MCP config → ${path.join(repoDir, '.mcp.json')}` +
            (tools ? ` (tools: ${tools.join(', ')})` : ''),
        );
      } else {
        log.info(`[mcp] S:${num} ${repoDir} already has a .mcp.json — leaving it alone`);
      }
    } catch (err) {
      log.warn(`[mcp] S:${num} could not write MCP config: ${err.message}`);
    }
  }

  /**
   * The --tools restriction the fleet was deployed with, read from the first
   * live session whose repo carries one. Undefined means no restriction, which
   * is what mcp:deploy writes when every tool is ticked.
   *
   * Runs once per spawn, over the fleet list the caller already has.
   */
  _deployedMcpTools(fleetSessions) {
    for (const s of fleetSessions || []) {
      try {
        const tools = sessionManager.readMcpTools(this.getRepoDir(s.num));
        if (tools) return tools;
      } catch {
        // A repo we cannot read tells us nothing; try the next one.
      }
    }
    return undefined;
  }

  async spawnSession({ num, baseDir, name, gitUrl } = {}) {
    if (!name) throw new Error('Agent name is required');
    log.info(
      `[spawn] starting: name=${name}, num=${num ?? 'auto'}, baseDir=${baseDir || 'default'}, gitUrl=${gitUrl || 'none'}`,
    );

    // Resolve base directory
    baseDir = (baseDir || process.env.HIVE_REPO_DIR || '~/ai-dev').replace(/^~/, os.homedir());
    log.info(`[spawn] resolved baseDir=${baseDir}`);

    // Pick slot
    if (num === undefined || num === null) {
      const slots = await this.getAvailableSlots();
      if (!slots.length)
        throw new Error(
          `No available slots (${this.spawnSlotMin}-${this.spawnSlotMax} all occupied)`,
        );
      num = slots[0];
      log.info(`[spawn] auto-picked slot ${num}`);
    }
    if (num < this.spawnSlotMin || num > this.spawnSlotMax)
      throw new Error(`Spawn slots must be ${this.spawnSlotMin}-${this.spawnSlotMax}`);

    const sessions = await fleet.getFleetStatus(this.config, this.router);
    if (sessions.find((s) => s.num === num)) {
      throw new Error(`Slot ${num} is already occupied`);
    }

    // Build repo path: baseDir/name+num (e.g. ~/ai-dev/ios17)
    const repoDir = path.join(baseDir, `${name}${num}`);
    log.info(`[spawn] repoDir=${repoDir}`);

    // Read BEFORE the clone: afterwards every repoDir exists, and this is the
    // only moment that tells "a directory hive is about to create" apart from
    // "a directory the operator already has". Only the first may be seeded with
    // an MCP config — see _seedMcpConfig.
    const repoExisted = fs.existsSync(repoDir);

    // Clone or create directory
    await cloneOrReuse(gitUrl, repoDir);

    // Before startClaude: Claude reads .mcp.json once, at startup, so a config
    // written after it launches reaches nothing until the next restart.
    if (!repoExisted) this._seedMcpConfig(repoDir, num, sessions);

    // Start tmux session via session-manager (no tmuxinator dependency)
    const size = this.config.tmux?.defaultSize || { cols: 200, rows: 50 };
    const prefix = this.config.sessions?.namePrefix || '';
    const sessionName = `${prefix}${num}`;
    log.info(`[spawn] creating session ${sessionName} at ${repoDir}`);
    try {
      const result = await sessionManager.createSession(
        sessionName,
        repoDir,
        this.config.tmux?.defaultLayout || {
          panes: 2,
          tmuxLayout: 'main-vertical',
          claudePaneWidth: '60%',
        },
        size,
      );
      // createSession returns { created:false, skipped:true } when the slot is
      // already live. Starting Claude anyway types `claude` into a pane that is
      // already running one — a second REPL stacked on the first, which is how a
      // spawn onto an occupied slot corrupted a working session.
      if (result && result.skipped) {
        log.info(
          `[spawn] session ${sessionName} already exists — not starting a second Claude in it`,
        );
      } else {
        await sessionManager.startClaude(sessionName, this.config.sessions.claudePane, 'claude');
        log.info(`[spawn] session ${sessionName} created`);
      }
    } catch (err) {
      log.error(`[spawn] session creation failed: ${err.message}`);
      throw new Error(`Failed to start session ${num}: ${err.message}`);
    }

    // Register spawned agent
    this.spawnedAgents.set(num, { repoDir, name });
    // Spawning an agent by hand is a person taking the slot, so the slot is
    // Manual — but it was Manual by absence, which is the flavour nothing
    // remembers. The toggle is the only writer of manualSessions, so a slot
    // that was never auto in the first place carries no mark, and auto-create
    // seizes it the moment the session dies and frees the slot up. Worse, it
    // does not merely borrow it: auto-create ends with autoSessions.add(num),
    // so the slot comes back Auto and starts taking dispatches.
    this.manualSessions.add(num);
    this.autoSessions.delete(num);
    this._saveState();

    // Wait for init then rename
    await new Promise((r) => setTimeout(r, 2000));
    const renameScript = process.env.HIVE_RENAME_SCRIPT;
    if (renameScript) {
      try {
        execSync(`bash "${renameScript}"`, { timeout: 10000, stdio: 'pipe' });
      } catch {
        // Rename is best-effort
      }
    }

    this.pushFeed('state', num, `Agent "${name}" spawned in slot ${num}`);
    return { num, repoDir };
  }

  // -- Respawn ------------------------------------------------------

  getSpawnedAgentsList() {
    const list = [];
    for (const [num, info] of this.spawnedAgents) {
      list.push({ num, ...info });
    }
    return list;
  }

  async respawnAll() {
    const results = { respawned: [], skipped: [], failed: [] };
    if (this.spawnedAgents.size === 0) return results;

    const sessions = await fleet.getFleetStatus(this.config, this.router);
    const liveSessions = new Set(sessions.map((s) => s.num));

    const size = this.config.tmux?.defaultSize || { cols: 200, rows: 50 };
    const prefix = this.config.sessions?.namePrefix || '';

    for (const [num, info] of this.spawnedAgents) {
      if (liveSessions.has(num)) {
        results.skipped.push(num);
        continue;
      }
      const sessionName = `${prefix}${num}`;
      try {
        const respawn = await sessionManager.createSession(
          sessionName,
          info.repoDir,
          this.config.tmux?.defaultLayout || {
            panes: 2,
            tmuxLayout: 'main-vertical',
            claudePaneWidth: '60%',
          },
          size,
        );
        if (respawn && respawn.skipped) {
          log.info(
            `[respawn] session ${sessionName} came back on its own — leaving its Claude alone`,
          );
        } else {
          await sessionManager.startClaude(sessionName, this.config.sessions.claudePane);
          log.info(`[respawn] session ${sessionName} (${info.name}) restarted`);
        }
        results.respawned.push(num);
      } catch (err) {
        log.error(`[respawn] session ${num} failed: ${err.message}`);
        results.failed.push({ num, error: err.message });
      }
    }

    if (results.respawned.length > 0) {
      this.pushFeed(
        'state',
        null,
        `Respawned ${results.respawned.length} session(s): ${results.respawned.join(', ')}`,
      );
    }

    // Run rename script once after all respawns
    if (results.respawned.length > 0) {
      const renameScript = process.env.HIVE_RENAME_SCRIPT;
      if (renameScript) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          execSync(`bash "${renameScript}"`, { timeout: 10000, stdio: 'pipe' });
        } catch {
          // Rename is best-effort
        }
      }
    }

    return results;
  }

  // -- Broadcast ----------------------------------------------------

  async broadcast(message, target, specificSessions) {
    const sessions = await fleet.getFleetStatus(this.config, this.router);
    let targets;

    if (specificSessions && specificSessions.length) {
      targets = sessions.filter((s) => specificSessions.includes(s.num));
    } else if (target === 'idle') {
      targets = sessions.filter((s) => s.state === SessionState.IDLE);
    } else if (target === 'working') {
      targets = sessions.filter((s) => s.state === SessionState.WORKING);
    } else {
      targets = sessions.filter((s) => s.state !== SessionState.OFF);
    }

    let sent = 0,
      failed = 0;
    for (const s of targets) {
      try {
        const node = this.router.nodeFor(s.name);
        if (!node) {
          failed++;
          continue;
        }
        const result = await relay.tell(this.config, node, s.name, message, {
          vimMode: this.vimMode,
        });
        if (result.success) sent++;
        else failed++;
      } catch {
        failed++;
      }
    }

    this.pushFeed(
      'broadcast',
      null,
      `Broadcast to ${target || 'all'}: "${message}" (${sent} sent, ${failed} failed)`,
    );
    return { sent, failed };
  }

  // -- Approvals ----------------------------------------------------

  createApproval(sessionNum, prompt) {
    // Don't create duplicate pending approvals for the same session
    for (const a of this.approvals.values()) {
      if (a.session === sessionNum && a.status === 'pending') return a;
    }

    const approval = {
      id: String(nextApprovalId++),
      session: sessionNum,
      prompt,
      status: ApprovalStatus.PENDING,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.approvals.set(approval.id, approval);
    this.emit('approval:new', approval);
    this.pushFeed('approval', sessionNum, `Approval requested: "${prompt}"`);
    return approval;
  }

  async resolveApproval(approvalId, approved) {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.status !== 'pending') return null;

    approval.status = approved ? 'approved' : 'denied';
    approval.resolvedAt = Date.now();

    // Send y or n key to the session
    const found = await fleet.findSession(this.config, this.router, approval.session);
    if (found) {
      const { name: sessionName, nodeId } = found;
      const node = this.router.getNode(nodeId);
      if (node) {
        const paneTarget = tmux.paneTarget(sessionName, this.config.sessions.claudePane);
        const key = approved ? 'y' : 'n';
        await node.exec(`tmux send-keys -t "${paneTarget}" ${key}`);
      }
    }

    this.emit('approval:resolved', approval);
    this.pushFeed(
      'approval',
      approval.session,
      `Approval ${approved ? 'approved' : 'denied'}: "${approval.prompt}"`,
    );
    return approval;
  }

  getPendingApprovals() {
    return Array.from(this.approvals.values()).filter((a) => a.status === 'pending');
  }

  // -- Feed ---------------------------------------------------------

  pushFeed(type, session, detail, extra) {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type, // 'state' | 'task' | 'ci' | 'approval' | 'broadcast' | 'user'
      session,
      detail,
      timestamp: Date.now(),
      ...extra,
    };

    this.feed.push(entry);
    // Prune feed entries older than 3 days
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    while (this.feed.length && this.feed[0].timestamp < threeDaysAgo) this.feed.shift();
    this._debounceSave();

    this.emit('feed:new', entry);
    return entry;
  }

  getFeed(before, limit = 50) {
    let entries = this.feed;
    if (before) {
      const idx = entries.findIndex((e) => e.id === before);
      if (idx > 0) entries = entries.slice(0, idx);
    }
    const slice = entries.slice(-limit);
    return {
      entries: slice,
      hasMore: entries.length > slice.length,
    };
  }

  // -- Auto-pilot rules --------------------------------------------

  getRules() {
    return this.rules;
  }

  toggleRule(ruleId) {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (rule) {
      rule.enabled = !rule.enabled;
      this._saveState();
      this.emit('rules:changed', this.rules);
    }
    return rule;
  }

  evaluateRules(trigger, data) {
    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger !== trigger) continue;

      switch (rule.action) {
        case 'auto-dispatch':
          this._tryAutoDispatch().catch((err) => log.error('Auto-dispatch error:', err.message));
          break;

        case 'dispatch-fix':
          if (data && data.num && this.autoSessions.has(data.num)) {
            const pr = data.pr ? ` PR #${data.pr}` : '';
            const message =
              trigger === 'ci:fail'
                ? `CI failed on${pr}. Run /ci-status ${data.pr || ''} to see failures, then fix them.`
                : `Review changes requested on${pr}. Check the PR review comments and address the feedback.`;
            this.createTask(message, 'manual', data.num, null, {
              source: trigger === 'ci:fail' ? 'ci-fail' : 'review-changes',
              pr: data.pr || null,
              session: data.num,
            });
          }
          break;
      }
    }
  }

  // -- Persistence ---------------------------------------------------

  _loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(data.autoSessions)) {
        for (const n of data.autoSessions) this.autoSessions.add(n);
      }
      if (Array.isArray(data.manualSessions)) {
        for (const n of data.manualSessions) this.manualSessions.add(n);
      }
      if (Array.isArray(data.rules)) {
        for (const saved of data.rules) {
          const rule = this.rules.find((r) => r.id === saved.id);
          if (rule) rule.enabled = saved.enabled;
        }
      }
      if (data.designations && typeof data.designations === 'object') {
        for (const [num, des] of Object.entries(data.designations)) {
          this.designations.set(Number(num), des);
        }
      }
      if (data.spawnedAgents && typeof data.spawnedAgents === 'object') {
        for (const [num, info] of Object.entries(data.spawnedAgents)) {
          this.spawnedAgents.set(Number(num), info);
        }
      }
      if (Array.isArray(data.designationDefs)) {
        for (const def of data.designationDefs) {
          if (!def.name) continue;
          // Same rule the write path applies. State gets hand-edited, and a cap
          // written as "5" would load as a string: Number.isInteger is false for
          // it, so the cap would enforce nothing and show no badge, silently.
          // Validating only on write leaves that hole open on every restart.
          const n = parseInt(def.sessionCap);
          if (!isNaN(n) && n >= 0) def.sessionCap = n;
          else delete def.sessionCap;
          this.designationDefs.set(def.name, def);
        }
      }
      if (Array.isArray(data.agentRoots)) {
        this.agentRoots = data.agentRoots;
      }
      if (Array.isArray(data.checklistTemplates)) {
        for (const tpl of data.checklistTemplates) {
          if (tpl.name) this.checklistTemplates.set(tpl.name, tpl);
        }
      }
      if (data.users && typeof data.users === 'object') {
        for (const [login, info] of Object.entries(data.users)) {
          this.users.set(login, info);
        }
      }
      if (data.vimMode !== undefined) this.vimMode = data.vimMode;
      if (data.taskAutoComplete !== undefined) this.taskAutoComplete = data.taskAutoComplete;
      if (data.showRequeueBtn !== undefined) this.showRequeueBtn = !!data.showRequeueBtn;
      if (data.showDeferBtn !== undefined) this.showDeferBtn = !!data.showDeferBtn;
      if (typeof data.requireHumanCloseAll === 'boolean')
        this.requireHumanCloseAll = data.requireHumanCloseAll;
      if (typeof data.autoCreateForManualTasks === 'boolean')
        this.autoCreateForManualTasks = data.autoCreateForManualTasks;
      if (data.spawnSlotMin !== undefined) this.spawnSlotMin = data.spawnSlotMin;
      if (data.spawnSlotMax !== undefined) this.spawnSlotMax = data.spawnSlotMax;
      if (data.repoSessionCaps && typeof data.repoSessionCaps === 'object') {
        for (const [k, v] of Object.entries(data.repoSessionCaps)) this.repoSessionCaps.set(k, v);
      }
      if (data.sessionContext && typeof data.sessionContext === 'object') {
        // Heal legacy shapes on load. State written before canonicalize-on-write
        // (`PR #N`, bare `N`) or by the first commit of this PR (arrays) is
        // unrenderable until the next `branch:changed`. Canonicalize `pr`
        // and flatten array-shaped `jira` now so the dashboard shows chips
        // immediately after restart.
        const defaultRepo = this.config && this.config.github && this.config.github.repo;
        for (const [num, ctx] of Object.entries(data.sessionContext)) {
          const healed = { ...ctx };
          if (healed.pr !== undefined && healed.pr !== null) {
            healed.pr = sessionLinks.canonicalizePrField(healed.pr, defaultRepo);
          }
          if (Array.isArray(healed.jira)) {
            healed.jira = healed.jira.filter((v) => typeof v === 'string').join(', ');
          }
          this.sessionContext.set(Number(num), healed);
        }
      }
      if (data.slackDedup && typeof data.slackDedup === 'object') {
        for (const [ts, markedAt] of Object.entries(data.slackDedup)) {
          this.slackDedup.set(ts, Number(markedAt));
        }
      }
      if (data.backupConfig && typeof data.backupConfig === 'object') {
        this.backupConfig = { ...this.backupConfig, ...data.backupConfig };
      }
      if (Array.isArray(data.workStates) && data.workStates.length) {
        this.workStates = data.workStates.map((s) => ({
          ...s,
          autoOnStatus: Array.isArray(s.autoOnStatus) ? s.autoOnStatus : [],
        }));
      }
      // Restore tasks
      if (Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
          // Preserve dispatched tasks and their session assignments across restarts.
          // The session is still running in tmux — don't reset to queued or send /clear.
          if (t.status === TaskStatus.DISPATCHED && t.assignedTo) {
            log.info(`[taskmap] S:${t.assignedTo} ← task ${t.id} (loadState restore)`);
            this.activeTaskBySession.set(t.assignedTo, t.id);
            this.dispatchLock.add(t.assignedTo);
          }
          // Re-arm snooze timers for persisted snoozed tasks
          if (t.status === TaskStatus.SNOOZED && t.snoozedUntil) {
            this._armSnoozeTimer(t);
          }
          // Normalize fields added in later versions so old tasks have a consistent shape
          if (!('title' in t)) t.title = null;
          this.tasks.set(t.id, t);
          if (Number(t.id) >= nextTaskId) nextTaskId = Number(t.id) + 1;
        }
      }
      // Restore feed
      if (Array.isArray(data.feed)) {
        this.feed = data.feed;
      }
      log.info(
        `Loaded state: ${this.autoSessions.size} auto-sessions, ${this.designations.size} designations, ${this.designationDefs.size} defs, ${this.agentRoots.length} agent roots, ${this.spawnedAgents.size} spawned agents, ${this.users.size} users`,
      );
      if (this.tasks.size) log.info(`Restored ${this.tasks.size} tasks`);
      if (this.feed.length) log.info(`Restored ${this.feed.length} feed entries`);
    } catch {
      // No state file yet -- that's fine
    }
  }

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveState();
    }, 5000);
  }

  _saveState() {
    const spawnedObj = {};
    for (const [num, info] of this.spawnedAgents) spawnedObj[num] = info;
    // Persist non-cancelled tasks; drop completed/failed older than 2 days
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const tasksArr = Array.from(this.tasks.values())
      .filter((t) => t.status !== TaskStatus.CANCELLED)
      .filter(
        (t) =>
          !(
            (t.status === TaskStatus.COMPLETED || t.status === TaskStatus.FAILED) &&
            t.completedAt &&
            t.completedAt < twoDaysAgo
          ),
      )
      .map((t) => ({ ...t }));
    const usersObj = {};
    for (const [login, info] of this.users) usersObj[login] = info;
    const data = {
      autoSessions: Array.from(this.autoSessions),
      manualSessions: Array.from(this.manualSessions),
      rules: this.rules.map((r) => ({ id: r.id, enabled: r.enabled })),
      designations: this.getDesignations(),
      designationDefs: this.getDesignationDefs(),
      agentRoots: this.agentRoots,
      spawnedAgents: spawnedObj,
      users: usersObj,
      tasks: tasksArr,
      feed: this.feed,
      vimMode: this.vimMode,
      taskAutoComplete: this.taskAutoComplete,
      showRequeueBtn: this.showRequeueBtn,
      showDeferBtn: this.showDeferBtn,
      requireHumanCloseAll: this.requireHumanCloseAll,
      autoCreateForManualTasks: this.autoCreateForManualTasks,
      spawnSlotMin: this.spawnSlotMin,
      spawnSlotMax: this.spawnSlotMax,
      checklistTemplates: this.getChecklistTemplates(),
      sessionContext: this.getAllSessionContexts(),
      backupConfig: this.backupConfig,
      workStates: this.workStates,
      repoSessionCaps: this.getRepoCaps(),
      slackDedup: Object.fromEntries(this.slackDedup),
    };
    // Merge PM data if pmManager is attached
    if (this._pmManager) {
      data.pms = this._pmManager.serialize();
    }
    try {
      const json = JSON.stringify(data, null, 2);
      const tmpFile = STATE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, STATE_FILE);
    } catch (err) {
      log.error('Failed to save state:', err.message);
    }
  }

  // -- Watcher integration ------------------------------------------

  _wireWatcher() {
    this.watcher.on('session:idle', (data) => {
      // Include terminal preview so feed entries show what Claude finished / is asking
      const extra = {};
      if (data.preview) {
        // Grab last ~20 lines of meaningful content for the feed
        const lines = data.preview.split('\n');
        extra.preview = lines.slice(-20).join('\n');
      }
      this.pushFeed('state', data.num, `Session ${data.num} went idle`, extra);
      this._handleSessionIdle(data.num, data.ansiSnapshot || data.preview, data.paneCols);

      // Evaluate auto-pilot rules
      this.evaluateRules('session:idle', data);
    });

    // Note: task completion is handled by 'session:idle' event above,
    // which now requires two consecutive polls confirming idle state.
    // No periodic fallback needed — the watcher confirmation prevents
    // false positives from brief idle flickers between tool calls.

    this.watcher.on('session:working', (data) => {
      this.pushFeed('state', data.num, `Session ${data.num} started working`);
      // Update lastActivityAt on the active task for this session
      const taskId = this.activeTaskBySession.get(data.num);
      if (taskId) {
        const task = this.tasks.get(taskId);
        if (task) {
          task.lastActivityAt = Date.now();
          this.emit('task:updated', task);
        }
      }
    });

    this.watcher.on('ci:changed', (data) => {
      const label = data.to === 'SUCCESS' ? 'PASS' : data.to === 'FAILURE' ? 'FAIL' : data.to;
      this.pushFeed('ci', data.num, `CI ${label} -- session ${data.num} PR#${data.pr}`);

      if (data.to === 'FAILURE') {
        this.evaluateRules('ci:fail', data);
      }
    });

    this.watcher.on('approval:requested', (data) => {
      this.createApproval(data.num, data.prompt);
    });

    this.watcher.on('review:changed', (data) => {
      this.pushFeed('ci', data.num, `Review: ${data.to} -- session ${data.num} PR#${data.pr}`);

      if (data.to === 'CHANGES_REQUESTED') {
        this.evaluateRules('review:changes_requested', data);
      }
    });

    // Auto-sync branch/PR into session context when branch changes
    this.watcher.on('branch:changed', (data) => {
      if (!this.activeTaskBySession.has(data.num)) return;
      const updates = {};
      if (data.to) updates.branch = data.to;
      if (data.pr && data.pr.prNum) updates.pr = `PR #${data.pr.prNum}`;
      if (Object.keys(updates).length) {
        this.setSessionContext(data.num, updates);
      }
    });
  }

  // -- Serialization (for sending to clients) -----------------------

  /**
   * Where a task sits in the queue — the position the dashboard shows.
   *
   * Deliberately NOT sorted by createdAt. _tryAutoDispatch walks
   * this.tasks.values() with no sort of its own, so Map insertion order IS the
   * queue. Sorting by createdAt here made the number describe a queue that does
   * not exist: any task moved within the Map kept displaying where it used to
   * be, so the dashboard reported a position it did not hold. On one fleet that
   * was 29 of 33 queued tasks.
   */
  getQueuePosition(taskId) {
    const queued = Array.from(this.tasks.values()).filter((t) => t.status === TaskStatus.QUEUED);
    const idx = queued.findIndex((t) => t.id === taskId);
    return idx >= 0 ? idx + 1 : null;
  }

  getTasksList() {
    return Array.from(this.tasks.values())
      .filter((t) => t.status !== TaskStatus.CANCELLED)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => {
        const { snapshot, snapshotCols, ...rest } = t;
        return rest;
      });
  }
}

// Mix in users/permissions/comments from tq-users.js
TaskQueue.ALL_PERMISSIONS = tqUsers.ALL_PERMISSIONS;
const { ALL_PERMISSIONS: _, ...tqUserMethods } = tqUsers;
Object.assign(TaskQueue.prototype, tqUserMethods);

// Mix in checklists, context, designations, agent files from tq-features.js
Object.assign(TaskQueue.prototype, tqFeatures);

module.exports = TaskQueue;
