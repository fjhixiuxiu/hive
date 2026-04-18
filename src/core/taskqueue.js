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
const sessionManager = require('./session-manager');
const { cloneOrReuse } = require('./git-utils');
const tqUsers = require('./tq-users');
const tqFeatures = require('./tq-features');

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
    this.tasks = new Map();           // id -> Task
    this.autoSessions = new Set();    // session numbers opted into auto-mode
    this.designations = new Map();    // session num -> designation string
    this.feed = [];                   // ring buffer, max 200
    this.approvals = new Map();       // id -> Approval
    this.users = new Map();           // login -> { login, name, avatar, permissions, firstSeen }
    this.dispatchLock = new Set();    // session numbers currently being dispatched to
    this._autoDispatching = false;   // re-entrancy guard for _tryAutoDispatch
    this.activeTaskBySession = new Map(); // session num -> task id
    this.lastDispatchedAt = new Map();   // session num -> timestamp of last task dispatch
    this.lastCompletedAt = new Map();    // session num -> timestamp of last task completion (cooldown)
    this.spawnedAgents = new Map();  // slot num -> { repoDir, name }
    this.spawnSlotMin = 1;
    this.spawnSlotMax = 32;
    this.vimMode = false;
    this.taskAutoComplete = true; // when false, tasks require manual completion
    this.repoSessionCaps = new Map(); // repoBaseName -> max session count
    this._snoozeTimers = new Map(); // taskId → setTimeout handle
    this.checklistTemplates = new Map(); // name → { name, items: [string] }
    this.sessionContext = new Map();    // session num -> { plan: '/path', pr: 'url', jira: 'KEY', ... }

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
    this.agentRoots = [];             // array of scan paths (e.g. '~/dev/agents/')
    this.agentFilesList = [];         // cached scan results: [{ path, name, relativePath, root }]

    // Auto-pilot rules
    this.rules = [
      { id: 'ci-fail-fix', name: 'Auto-fix CI failures', enabled: false,
        trigger: 'ci:fail', action: 'dispatch-fix' },
      { id: 'review-changes', name: 'Auto-address review changes', enabled: false,
        trigger: 'review:changes_requested', action: 'dispatch-fix' },
      { id: 'idle-next-task', name: 'Auto-pick next task on idle', enabled: true,
        trigger: 'session:idle', action: 'auto-dispatch' },
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
          const s = sessions.find(s => s.num === num);
          const task = this.tasks.get(taskId);
          if (s && s.state === 'idle' && (!task || task.status !== 'dispatched')) {
            staleCount++;
            log.info(`[reconcile] S:${num} is idle with stale task mapping (task=${taskId}, status=${task?.status}), clearing lock`);
            log.info(`[taskmap] S:${num} ✕ task ${taskId} (reconcile — stale)`);
            this.dispatchLock.delete(num);
            this.activeTaskBySession.delete(num);
          } else if (s && task?.status === 'dispatched') {
            // Session has an in-progress dispatched task — keep lock held regardless of apparent state
            log.info(`[reconcile] S:${num} has dispatched task "${(task.text || '').slice(0, 60)}" — keeping lock`);
          }
        }
        if (staleCount > 0) {
          log.info(`[reconcile] Cleared locks on ${staleCount} idle session(s) with dispatched tasks`);
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
      this._tryAutoDispatch().catch(err => log.error('Auto-dispatch error:', err.message));
    }, 60000);

    // Periodic backlog check — catches tasks stuck when sessions boot after startup
    // or when idle events are missed. Runs every 30s.
    this._backlogInterval = setInterval(() => {
      const hasQueued = Array.from(this.tasks.values()).some(t => t.status === 'queued');
      if (hasQueued) {
        this._tryAutoDispatch().catch(err => log.error('Backlog check error:', err.message));
      }
    }, 30000);
  }

  // -- Task lifecycle -----------------------------------------------

  createTask(text, mode, targetSession, designation, meta) {
    const task = {
      id: String(nextTaskId++),
      text,
      mode, // 'auto' or 'manual'
      targetSession: targetSession || null,
      designation: designation || null,
      status: 'queued',
      assignedTo: null,
      createdAt: Date.now(),
      dispatchedAt: null,
      completedAt: null,
      result: null,
      source: (meta && meta.source) || null,   // e.g. 'ci-fail', 'review-changes'
      // [Phase 1 — context-consolidation] sourcePR kept for back-compat.
      // Phase 2 will remove this field; PR is already tracked live via fleet
      // (s.pr) and in sessionContext.pr. Plan marks this LOW RISK but requires
      // auditing consumers (see plan risk #6 "task.sourcePR in tests").
      // See: ~/dev/agents/hive/context-consolidation-plan.md (Step 6)
      sourcePR: (meta && meta.pr) || null,      // PR number that triggered this
      sourceSession: (meta && meta.session) || null, // session that triggered this
      createdBy: (meta && meta.createdBy) || null,   // GitHub login of creator
      actionContext: (meta && meta.actionContext) || null, // contextual actions metadata
      workState: (meta && meta.workState) || null,
      workStateManual: false,
      assignee: (meta && meta.assignee) || null,
      requireHumanClose: meta?.requireHumanClose !== undefined ? !!meta.requireHumanClose : false,
      pendingResult: null,       // set when MCP tries to complete a requireHumanClose task
      pendingCompleteAt: null,
    };
    this.tasks.set(task.id, task);
    this.emit('task:created', task);
    const byWho = task.createdBy ? ` by ${task.createdBy}` : '';
    this.pushFeed('task', null, `Task created${byWho}: "${text}" (${mode})`);

    if (mode === 'manual' && targetSession) {
      this._dispatchTask(task, targetSession).catch(err =>
        log.error('Dispatch error:', err.message));
    } else if (mode === 'auto') {
      // Try to dispatch immediately to an idle auto-session
      this._tryAutoDispatch().catch(err =>
        log.error('Auto-dispatch error:', err.message));
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
      status: 'dispatched',
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
    if (task.status === 'queued' || task.status === 'snoozed') {
      const allowed = ['text', 'mode', 'targetSession', 'designation', 'actionContext'];
      for (const key of allowed) {
        if (key in updates) task[key] = updates[key];
      }
    }

    this.emit('task:updated', task);
    this._saveState();
    return task;
  }

  /**
   * Rename a task (update its text). Works on any status.
   * Returns the updated task or null if not found.
   */
  renameTask(taskId, newText) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (!newText || typeof newText !== 'string') return null;
    const trimmed = newText.trim();
    if (!trimmed) return null;
    task.text = trimmed;
    this.emit('task:updated', task);
    this._saveState();
    return task;
  }

  /**
   * Manually dispatch a queued task to a specific session.
   */
  async dispatchTaskTo(taskId, sessionNum) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'queued') return null;
    task.mode = 'manual';
    task.targetSession = sessionNum;
    await this._dispatchTask(task, sessionNum);
    return task;
  }

  requeueTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'dispatched') return null;
    if (task.assignedTo) {
      log.info(`[taskmap] S:${task.assignedTo} ✕ task ${task.id} (requeue)`);
      this.activeTaskBySession.delete(task.assignedTo);
      this.dispatchLock.delete(task.assignedTo);
      this.clearSessionContext(task.assignedTo);
    }
    const prevSession = task.assignedTo;
    task.status = 'queued';
    task.workStateManual = false;
    task.assignedTo = null;
    task.dispatchedAt = null;
    task.targetSession = null;
    this.emit('task:requeued', task);
    this.pushFeed('task', prevSession, `Task returned to queue: "${task.text}"`);
    this._saveState();
    return task;
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'failed') return null;

    // Clear snooze timer if task was snoozed
    if (this._snoozeTimers.has(taskId)) {
      clearTimeout(this._snoozeTimers.get(taskId));
      this._snoozeTimers.delete(taskId);
    }

    if (task.status === 'dispatched' && task.assignedTo) {
      log.info(`[taskmap] S:${task.assignedTo} ✕ task ${task.id} (cancel)`);
      this.activeTaskBySession.delete(task.assignedTo);
      this.clearSessionContext(task.assignedTo);
    }
    task.status = 'cancelled';
    task.workStateManual = false;
    this.emit('task:cancelled', task);
    this.pushFeed('task', task.assignedTo, `Task cancelled: "${task.text}"`);
    return task;
  }

  snoozeTask(taskId, durationMs) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    // If dispatched, requeue first (requeue already clears session context)
    if (task.status === 'dispatched') {
      this.requeueTask(taskId);
    }
    if (task.status !== 'queued') return null;
    task.status = 'snoozed';
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
    if (!task || task.status !== 'snoozed') return null;
    if (this._snoozeTimers.has(taskId)) {
      clearTimeout(this._snoozeTimers.get(taskId));
      this._snoozeTimers.delete(taskId);
    }
    task.status = 'queued';
    task.workStateManual = false;
    task.snoozedUntil = null;
    this.emit('task:unsnoozed', task);
    this.pushFeed('task', null, `Task unsnoozed: "${task.text}"`);
    this._saveState();
    this._tryAutoDispatch().catch(err =>
      log.error('Auto-dispatch error:', err.message));
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
    if (!task || task.status !== 'snoozed') return;
    task.status = 'queued';
    task.workStateManual = false;
    task.snoozedUntil = null;
    this.emit('task:unsnoozed', task);
    this.pushFeed('task', null, `Snoozed task woke up: "${task.text}"`);
    this._saveState();
    this._tryAutoDispatch().catch(err =>
      log.error('Auto-dispatch error:', err.message));
  }

  /**
   * Resume a completed/failed task — put it back to dispatched (in-progress)
   * on the same session it originally ran on, as a manual task so it won't
   * auto-complete when the session goes idle.
   */
  resumeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status !== 'completed' && task.status !== 'failed') return null;
    if (!task.assignedTo) return null;

    // Check if session already has an active task
    const existingTaskId = this.activeTaskBySession.get(task.assignedTo);
    if (existingTaskId && existingTaskId !== taskId) return null;

    task.status = 'dispatched';
    task.workStateManual = false;
    task.mode = 'manual';
    task.completedAt = null;
    task.lastActivityAt = Date.now();

    log.info(`[taskmap] S:${task.assignedTo} ← task ${task.id} (resume)`);
    this.activeTaskBySession.set(task.assignedTo, task.id);
    // Don't set dispatchLock — manual tasks don't hold the lock

    this.emit('task:dispatched', task);
    this.pushFeed('task', task.assignedTo,
      `Task resumed on session ${task.assignedTo}: "${task.text}"`);
    this._saveState();
    return task;
  }

  /**
   * Complete a task.
   * @param {string} taskId
   * @param {string} result - summary text
   * @param {string} [snapshot] - terminal snapshot
   * @param {number} [snapshotCols]
   * @param {object} [opts] - { force: true } to bypass requireHumanClose
   * @returns {object|null|'pending'} task, null if not found, or 'pending' if awaiting human approval
   */
  completeTask(taskId, result, snapshot, snapshotCols, opts) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'dispatched') return null;

    // Gate: requireHumanClose blocks MCP-initiated completions
    if (task.requireHumanClose && !(opts && opts.force)) {
      task.pendingResult = result || 'Completed via MCP';
      task.pendingCompleteAt = Date.now();
      this.emit('task:pending-complete', task);
      this.pushFeed('task', task.assignedTo,
        `Task pending approval: "${task.text.substring(0, 60)}..."`);
      this._saveState();
      return 'pending';
    }

    task.status = 'completed';
    task.workStateManual = false;
    task.completedAt = Date.now();
    task.result = result || null;
    task.pendingResult = null;
    task.pendingCompleteAt = null;
    task.snapshot = snapshot || null;
    task.snapshotCols = snapshotCols || 0;

    const sessionNum = task.assignedTo;
    if (sessionNum) {
      log.info(`[taskmap] S:${sessionNum} ✕ task ${task.id} (complete, "${(task.text || '').slice(0, 60)}")`);
      this.activeTaskBySession.delete(sessionNum);
      this.dispatchLock.delete(sessionNum);
      this.lastCompletedAt.set(sessionNum, Date.now());
      // Reset state cache so watcher detects session as idle for next dispatch
      try {
        const stateFile = path.join(this.config.cache.stateDir, String(sessionNum));
        fs.writeFileSync(stateFile, 'idle');
      } catch {}

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
    this.pushFeed('task', task.assignedTo,
      `Task completed: "${task.text}" (${duration}m)`);
    this._saveState();
    // Dispatch next queued task now that a session is free
    this._tryAutoDispatch().catch(err =>
      log.error('Auto-dispatch error:', err.message));
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
    this.pushFeed('task', task.assignedTo,
      `Task completion rejected — task continues on S:${task.assignedTo}`);
    this._saveState();
    this.emit('task:reject-complete', task);
    return task;
  }

  failTask(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'dispatched') return null;

    task.status = 'failed';
    task.workStateManual = false;
    task.completedAt = Date.now();
    task.result = error;

    if (task.assignedTo) {
      log.info(`[taskmap] S:${task.assignedTo} ✕ task ${task.id} (fail: ${error})`);
      this.activeTaskBySession.delete(task.assignedTo);
      this.dispatchLock.delete(task.assignedTo);
      this.lastCompletedAt.set(task.assignedTo, Date.now());
      // Reset state cache so watcher detects session as idle for next dispatch
      try {
        const stateFile = path.join(this.config.cache.stateDir, String(task.assignedTo));
        fs.writeFileSync(stateFile, 'idle');
      } catch {}
      // [Phase 2 — context-consolidation] TODO: same snapshot pattern as
      // completeTask — capture sessionContext.slackThread into task._completionContext
      // before clearing. See completeTask for details and plan ref.
      this.clearSessionContext(task.assignedTo);
    }

    this.emit('task:failed', task);
    this.pushFeed('task', task.assignedTo,
      `Task failed: "${task.text}" -- ${error}`);
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

    task.status = 'dispatched';
    task.workStateManual = false;
    task.assignedTo = sessionNum;
    task.dispatchedAt = Date.now();
    task.lastActivityAt = Date.now();
    // Update watcher activity timestamp on dispatch
    if (this.watcher) this.watcher.sessionActivity.set(sessionNum, Date.now());
    const prevTaskId = this.activeTaskBySession.get(sessionNum);
    if (prevTaskId && prevTaskId !== task.id) {
      log.warn(`[taskmap] S:${sessionNum} OVERWRITE task ${prevTaskId} → ${task.id} (dispatch)`);
    }
    log.info(`[taskmap] S:${sessionNum} ← task ${task.id} (dispatch, "${(task.text || '').slice(0, 60)}")`);
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
    this.pushFeed('task', sessionNum,
      `Task dispatched to session ${sessionNum}: "${task.text}"`);
    log.info(`[dispatch] Task ${task.id} dispatched to S:${sessionNum}: "${task.text.slice(0, 80)}"`);
    this._saveState();

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
      await relay.ask(this.config, node, sessionName, '/clear', { vimMode: this.vimMode });
      // Build message with agent file preamble if designation has agent files
      let fullMessage = this._pmManager ? this._pmManager.enrichTaskText(task) : task.text;
      const desigName = task.designation || this.designations.get(sessionNum);
      const desigDef = desigName ? this.designationDefs.get(desigName) : null;
      if (desigDef && desigDef.agentFiles && desigDef.agentFiles.length > 0) {
        const parts = [];
        for (const f of desigDef.agentFiles) {
          try { parts.push(fs.readFileSync(f, 'utf8')); } catch {}
        }
        if (parts.length > 0) {
          // Preserve the enriched text (PM instructions, Slack contact, MCP block)
          // built above — don't fall back to raw task.text, or we silently drop it.
          fullMessage = parts.join('\n\n---\n\n') + '\n\n---\n\nTASK:\n' + fullMessage;
        }
      }
      return relay.tell(this.config, node, sessionName, fullMessage, { vimMode: this.vimMode });
    };

    sendTask().then((result) => {
      log.info(`[dispatch] Task ${task.id} send ${result.success ? 'OK' : 'FAILED'} to S:${sessionNum}${result.error ? ': ' + result.error : ''}`);
      if (!result.success) {
        this.failTask(task.id, result.error || 'Tell failed');
      }
      // Don't unlock dispatchLock here -- wait for session to go idle
    }).catch((err) => {
      this.failTask(task.id, err.message);
    });

    return true;
  }

  /**
   * Clean up all TaskQueue state for a killed session.
   * Fails active task, removes dispatch lock and spawned agent tracking.
   */
  cleanupSession(num) {
    const taskId = this.activeTaskBySession.get(num);
    if (taskId) {
      log.info(`[taskmap] S:${num} ✕ task ${taskId} (cleanupSession — session killed)`);
      this.failTask(taskId, 'Session killed');
    }
    this.activeTaskBySession.delete(num);
    this.dispatchLock.delete(num);
    this.spawnedAgents.delete(num);
    this.autoSessions.delete(num);
    this.lastDispatchedAt.delete(num);
    this.designations.delete(num);
    this._saveState();
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
      t => t.status === 'queued' && t.mode === 'manual' && t.targetSession === num
    );
    if (pendingManual) {
      this._dispatchTask(pendingManual, num).catch(err =>
        log.error('Manual retry dispatch error:', err.message));
    }
  }

  async _tryAutoDispatch() {
    if (this._autoDispatching) return;
    this._autoDispatching = true;
    try {
      const sessions = await fleet.getFleetStatus(this.config, this.router);

      // First: retry queued manual tasks with a targetSession
      // For targeted tasks, dispatch if the session has no active task — don't require
      // fleet state === 'idle' since the state file can be stale
      const manualTargeted = Array.from(this.tasks.values())
        .filter(t => t.status === 'queued' && t.mode === 'manual' && t.targetSession);
      for (const task of manualTargeted) {
        const session = sessions.find(s => s.num === task.targetSession);
        if (session && !this.dispatchLock.has(session.num) && !this.activeTaskBySession.has(session.num)) {
          await this._dispatchTask(task, task.targetSession);
        }
      }

      // Then: auto-mode tasks
      const queuedTasks = Array.from(this.tasks.values())
        .filter(t => t.status === 'queued' && t.mode === 'auto');
      if (!queuedTasks.length) return;

      const COOLDOWN_MS = 15000; // 15s cooldown after completion before re-dispatch
      const now = Date.now();
      const idleAuto = sessions.filter(s =>
        this.autoSessions.has(s.num)
        && !this.dispatchLock.has(s.num)
        && !this.activeTaskBySession.has(s.num)
        && (now - (this.lastCompletedAt.get(s.num) || 0)) > COOLDOWN_MS
      );
      if (!idleAuto.length) return;

      // Sort by least recently used — sessions idle longest get tasks first
      idleAuto.sort((a, b) =>
        (this.lastDispatchedAt.get(a.num) || 0) - (this.lastDispatchedAt.get(b.num) || 0)
      );

      // Dispatch one task per idle session.
      // Designated tasks prefer sessions with matching designation, but fall
      // back to undesignated sessions. They never cross-designate (e.g. a
      // 'cherrypick' task won't go to an 'ios'-designated session).
      // Undesignated tasks still only go to undesignated sessions.
      const dispatched = new Set(); // track sessions claimed this round
      for (const task of queuedTasks) {
        if (task.status !== 'queued') continue;
        const candidates = idleAuto.filter(s => !dispatched.has(s.num));
        let best = null;
        if (task.designation) {
          best = candidates.find(s => this.designations.get(s.num) === task.designation)
            || candidates.find(s => !this.designations.get(s.num));
        } else {
          best = candidates.find(s => !this.designations.get(s.num));
        }
        if (best) {
          dispatched.add(best.num);
          await this._dispatchTask(task, best.num);
        }
      }

      // Auto-create session for queued tasks whose source PM has autoCreate enabled
      const autoCreateTasks = queuedTasks.filter(t => {
        if (t.status !== 'queued') return false;
        const pm = this._getSourcePm(t);
        return pm && pm.autoCreate;
      });

      // Group by designation (null = undesignated)
      const byDesig = new Map();
      for (const t of autoCreateTasks) {
        const d = t.designation || null;
        if (!byDesig.has(d)) byDesig.set(d, []);
        byDesig.get(d).push(t);
      }

      for (const [desig, tasks] of byDesig) {
        // Check if there's already an idle or booting session for this designation.
        // Designated tasks can also fall back to undesignated sessions, so include
        // those in the matching set to avoid needless auto-creation.
        const matching = sessions.filter(s => {
          const sd = this.designations.get(s.num);
          return desig ? (sd === desig || !sd) : !sd;
        });
        const hasIdle = matching.some(s =>
          s.state === 'idle' && this.autoSessions.has(s.num)
          && !this.dispatchLock.has(s.num) && !this.activeTaskBySession.has(s.num)
        );
        const hasBooting = matching.some(s =>
          s.state !== 'idle' && this.autoSessions.has(s.num)
          && !this.activeTaskBySession.has(s.num)
        );
        if (hasIdle || hasBooting) continue;

        try {
          const slots = await this.getAvailableSlots();
          if (slots.length === 0) continue;
          const num = slots[0];
          const repoDir = this.config.sessions.repoDir(num);
          const repoName = TaskQueue.repoBaseName(repoDir);
          const cap = this.repoSessionCaps.get(repoName);
          if (cap !== undefined && this._countRepoSessions(sessions, repoName) >= cap) {
            log.info(`[auto-dispatch] Repo "${repoName}" at session cap (${cap}) — skipping auto-create`);
            continue;
          }
          const size = this.config.tmux?.defaultSize || { cols: 200, rows: 50 };
          const prefix = this.config.sessions?.namePrefix || '';
          const sessionName = `${prefix}${num}`;
          const desigLabel = desig || 'undesignated';
          log.info(`[auto-dispatch] No idle ${desigLabel} session — creating session ${num}`);
          await sessionManager.createSession(sessionName, repoDir, this.config.tmux?.defaultLayout || { panes: 2, tmuxLayout: 'main-vertical', claudePaneWidth: '60%' }, size);
          await sessionManager.startClaude(sessionName, this.config.sessions.claudePane, 'claude');
          this.autoSessions.add(num);
          if (desig) this.designations.set(num, desig);
          this._saveState();
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
    return sessions.filter(s => {
      const dir = this.getRepoDir(s.num) || this.config.sessions.repoDir(s.num);
      return TaskQueue.repoBaseName(dir) === repoName;
    }).length;
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
    } else {
      this.autoSessions.add(num);
    }
    this._saveState();
    this.emit('auto:changed', this.getAutoSessions());
    // Re-evaluate dispatch with new auto-session set
    this._tryAutoDispatch().catch(err =>
      log.error('Auto-dispatch error:', err.message));
    return this.autoSessions.has(num);
  }

  setAutoSessions(nums) {
    this.autoSessions.clear();
    for (const n of nums) this.autoSessions.add(n);
    this._saveState();
    this.emit('auto:changed', this.getAutoSessions());
  }

  getAutoSessions() {
    return Array.from(this.autoSessions).sort((a, b) => a - b);
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
    const occupied = new Set(sessions.map(s => s.num));
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

  async spawnSession({ num, baseDir, name, gitUrl } = {}) {
    if (!name) throw new Error('Agent name is required');
    log.info(`[spawn] starting: name=${name}, num=${num ?? 'auto'}, baseDir=${baseDir || 'default'}, gitUrl=${gitUrl || 'none'}`);

    // Resolve base directory
    baseDir = (baseDir || process.env.HIVE_REPO_DIR || '~/ai-dev').replace(/^~/, os.homedir());
    log.info(`[spawn] resolved baseDir=${baseDir}`);

    // Pick slot
    if (num === undefined || num === null) {
      const slots = await this.getAvailableSlots();
      if (!slots.length) throw new Error(`No available slots (${this.spawnSlotMin}-${this.spawnSlotMax} all occupied)`);
      num = slots[0];
      log.info(`[spawn] auto-picked slot ${num}`);
    }
    if (num < this.spawnSlotMin || num > this.spawnSlotMax) throw new Error(`Spawn slots must be ${this.spawnSlotMin}-${this.spawnSlotMax}`);

    const sessions = await fleet.getFleetStatus(this.config, this.router);
    if (sessions.find(s => s.num === num)) {
      throw new Error(`Slot ${num} is already occupied`);
    }

    // Build repo path: baseDir/name+num (e.g. ~/ai-dev/ios17)
    const repoDir = path.join(baseDir, `${name}${num}`);
    log.info(`[spawn] repoDir=${repoDir}`);

    // Clone or create directory
    await cloneOrReuse(gitUrl, repoDir);

    // Start tmux session via session-manager (no tmuxinator dependency)
    const size = this.config.tmux?.defaultSize || { cols: 200, rows: 50 };
    const prefix = this.config.sessions?.namePrefix || '';
    const sessionName = `${prefix}${num}`;
    log.info(`[spawn] creating session ${sessionName} at ${repoDir}`);
    try {
      await sessionManager.createSession(sessionName, repoDir, this.config.tmux?.defaultLayout || { panes: 2, tmuxLayout: 'main-vertical', claudePaneWidth: '60%' }, size);
      await sessionManager.startClaude(sessionName, this.config.sessions.claudePane, 'claude');
      log.info(`[spawn] session ${sessionName} created`);
    } catch (err) {
      log.error(`[spawn] session creation failed: ${err.message}`);
      throw new Error(`Failed to start session ${num}: ${err.message}`);
    }

    // Register spawned agent
    this.spawnedAgents.set(num, { repoDir, name });
    this._saveState();

    // Wait for init then rename
    await new Promise(r => setTimeout(r, 2000));
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
    const liveSessions = new Set(sessions.map(s => s.num));

    const size = this.config.tmux?.defaultSize || { cols: 200, rows: 50 };
    const prefix = this.config.sessions?.namePrefix || '';

    for (const [num, info] of this.spawnedAgents) {
      if (liveSessions.has(num)) {
        results.skipped.push(num);
        continue;
      }
      const sessionName = `${prefix}${num}`;
      try {
        await sessionManager.createSession(sessionName, info.repoDir, this.config.tmux?.defaultLayout || { panes: 2, tmuxLayout: 'main-vertical', claudePaneWidth: '60%' }, size);
        await sessionManager.startClaude(sessionName, this.config.sessions.claudePane);
        log.info(`[respawn] session ${sessionName} (${info.name}) restarted`);
        results.respawned.push(num);
      } catch (err) {
        log.error(`[respawn] session ${num} failed: ${err.message}`);
        results.failed.push({ num, error: err.message });
      }
    }

    if (results.respawned.length > 0) {
      this.pushFeed('state', null, `Respawned ${results.respawned.length} session(s): ${results.respawned.join(', ')}`);
    }

    // Run rename script once after all respawns
    if (results.respawned.length > 0) {
      const renameScript = process.env.HIVE_RENAME_SCRIPT;
      if (renameScript) {
        await new Promise(r => setTimeout(r, 2000));
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
      targets = sessions.filter(s => specificSessions.includes(s.num));
    } else if (target === 'idle') {
      targets = sessions.filter(s => s.state === 'idle');
    } else if (target === 'working') {
      targets = sessions.filter(s => s.state === 'working');
    } else {
      targets = sessions.filter(s => s.state !== 'off');
    }

    let sent = 0, failed = 0;
    for (const s of targets) {
      try {
        const node = this.router.nodeFor(s.name);
        if (!node) { failed++; continue; }
        const result = await relay.tell(this.config, node, s.name, message, { vimMode: this.vimMode });
        if (result.success) sent++;
        else failed++;
      } catch {
        failed++;
      }
    }

    this.pushFeed('broadcast', null,
      `Broadcast to ${target || 'all'}: "${message}" (${sent} sent, ${failed} failed)`);
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
      status: 'pending', // 'pending' | 'approved' | 'denied'
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
        const paneTarget = `${sessionName}:.${this.config.sessions.claudePane}`;
        const key = approved ? 'y' : 'n';
        await node.exec(`tmux send-keys -t "${paneTarget}" ${key}`);
      }
    }

    this.emit('approval:resolved', approval);
    this.pushFeed('approval', approval.session,
      `Approval ${approved ? 'approved' : 'denied'}: "${approval.prompt}"`);
    return approval;
  }

  getPendingApprovals() {
    return Array.from(this.approvals.values())
      .filter(a => a.status === 'pending');
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
      const idx = entries.findIndex(e => e.id === before);
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
    const rule = this.rules.find(r => r.id === ruleId);
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
          this._tryAutoDispatch().catch(err =>
            log.error('Auto-dispatch error:', err.message));
          break;

        case 'dispatch-fix':
          if (data && data.num && this.autoSessions.has(data.num)) {
            const pr = data.pr ? ` PR #${data.pr}` : '';
            const message = trigger === 'ci:fail'
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
      if (Array.isArray(data.rules)) {
        for (const saved of data.rules) {
          const rule = this.rules.find(r => r.id === saved.id);
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
          if (def.name) this.designationDefs.set(def.name, def);
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
      if (data.spawnSlotMin !== undefined) this.spawnSlotMin = data.spawnSlotMin;
      if (data.spawnSlotMax !== undefined) this.spawnSlotMax = data.spawnSlotMax;
      if (data.repoSessionCaps && typeof data.repoSessionCaps === 'object') {
        for (const [k, v] of Object.entries(data.repoSessionCaps)) this.repoSessionCaps.set(k, v);
      }
      if (data.sessionContext && typeof data.sessionContext === 'object') {
        for (const [num, ctx] of Object.entries(data.sessionContext)) {
          this.sessionContext.set(Number(num), ctx);
        }
      }
      if (data.backupConfig && typeof data.backupConfig === 'object') {
        this.backupConfig = { ...this.backupConfig, ...data.backupConfig };
      }
      if (Array.isArray(data.workStates) && data.workStates.length) {
        this.workStates = data.workStates.map(s => ({
          ...s,
          autoOnStatus: Array.isArray(s.autoOnStatus) ? s.autoOnStatus : [],
        }));
      }
      // Restore tasks
      if (Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
          // Preserve dispatched tasks and their session assignments across restarts.
          // The session is still running in tmux — don't reset to queued or send /clear.
          if (t.status === 'dispatched' && t.assignedTo) {
            log.info(`[taskmap] S:${t.assignedTo} ← task ${t.id} (loadState restore)`);
            this.activeTaskBySession.set(t.assignedTo, t.id);
            this.dispatchLock.add(t.assignedTo);
          }
          // Re-arm snooze timers for persisted snoozed tasks
          if (t.status === 'snoozed' && t.snoozedUntil) {
            this._armSnoozeTimer(t);
          }
          this.tasks.set(t.id, t);
          if (Number(t.id) >= nextTaskId) nextTaskId = Number(t.id) + 1;
        }
      }
      // Restore feed
      if (Array.isArray(data.feed)) {
        this.feed = data.feed;
      }
      log.info(`Loaded state: ${this.autoSessions.size} auto-sessions, ${this.designations.size} designations, ${this.designationDefs.size} defs, ${this.agentRoots.length} agent roots, ${this.spawnedAgents.size} spawned agents, ${this.users.size} users`);
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
      .filter(t => t.status !== 'cancelled')
      .filter(t => !(
        (t.status === 'completed' || t.status === 'failed') && t.completedAt && t.completedAt < twoDaysAgo
      ))
      .map(t => ({ ...t }));
    const usersObj = {};
    for (const [login, info] of this.users) usersObj[login] = info;
    const data = {
      autoSessions: Array.from(this.autoSessions),
      rules: this.rules.map(r => ({ id: r.id, enabled: r.enabled })),
      designations: this.getDesignations(),
      designationDefs: this.getDesignationDefs(),
      agentRoots: this.agentRoots,
      spawnedAgents: spawnedObj,
      users: usersObj,
      tasks: tasksArr,
      feed: this.feed,
      vimMode: this.vimMode,
      taskAutoComplete: this.taskAutoComplete,
      spawnSlotMin: this.spawnSlotMin,
      spawnSlotMax: this.spawnSlotMax,
      checklistTemplates: this.getChecklistTemplates(),
      sessionContext: this.getAllSessionContexts(),
      backupConfig: this.backupConfig,
      workStates: this.workStates,
      repoSessionCaps: this.getRepoCaps(),
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
      this.pushFeed('ci', data.num,
        `CI ${label} -- session ${data.num} PR#${data.pr}`);

      if (data.to === 'FAILURE') {
        this.evaluateRules('ci:fail', data);
      }
    });

    this.watcher.on('approval:requested', (data) => {
      this.createApproval(data.num, data.prompt);
    });

    this.watcher.on('review:changed', (data) => {
      this.pushFeed('ci', data.num,
        `Review: ${data.to} -- session ${data.num} PR#${data.pr}`);

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

  getQueuePosition(taskId) {
    const queued = Array.from(this.tasks.values())
      .filter(t => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    const idx = queued.findIndex(t => t.id === taskId);
    return idx >= 0 ? idx + 1 : null;
  }

  getTasksList() {
    return Array.from(this.tasks.values())
      .filter(t => t.status !== 'cancelled')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(t => {
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
