const log = require('./log');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const relay = require('./relay');
const fleet = require('./fleet');

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
    this.spawnedAgents = new Map();  // slot num -> { repoDir, name }
    this.spawnSlotMin = 1;
    this.spawnSlotMax = 32;
    this.vimMode = false;
    this.checklistTemplates = new Map(); // name → { name, items: [string] }

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
          if (s && s.state === 'idle') {
            staleCount++;
            const task = this.tasks.get(taskId);
            log.info(`[reconcile] S:${num} is idle with dispatched task: "${(task?.text || '').slice(0, 60)}"`);
          }
        }
        if (staleCount > 0) {
          log.info(`[reconcile] ${staleCount} dispatched task(s) on idle sessions — watcher will handle transitions`);
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
      sourcePR: (meta && meta.pr) || null,      // PR number that triggered this
      sourceSession: (meta && meta.session) || null, // session that triggered this
      createdBy: (meta && meta.createdBy) || null,   // GitHub login of creator
      actionContext: (meta && meta.actionContext) || null, // contextual actions metadata
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
      sourcePR: (meta && meta.pr) || null,
      sourceSession: sessionNum,
      actionContext: (meta && meta.actionContext) || null,
    };
    this.tasks.set(task.id, task);
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
    if (!task || task.status !== 'queued') return null;

    const allowed = ['text', 'mode', 'targetSession', 'designation', 'actionContext'];
    for (const key of allowed) {
      if (key in updates) task[key] = updates[key];
    }
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

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'failed') return null;

    if (task.status === 'dispatched' && task.assignedTo) {
      this.activeTaskBySession.delete(task.assignedTo);
    }
    task.status = 'cancelled';
    this.emit('task:cancelled', task);
    this.pushFeed('task', task.assignedTo, `Task cancelled: "${task.text}"`);
    return task;
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
    task.mode = 'manual';
    task.completedAt = null;
    task.lastActivityAt = Date.now();

    this.activeTaskBySession.set(task.assignedTo, task.id);
    // Don't set dispatchLock — manual tasks don't hold the lock

    this.emit('task:dispatched', task);
    this.pushFeed('task', task.assignedTo,
      `Task resumed on session ${task.assignedTo}: "${task.text}"`);
    this._saveState();
    return task;
  }

  completeTask(taskId, result, snapshot, snapshotCols) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'dispatched') return null;

    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result || null;
    task.snapshot = snapshot || null;
    task.snapshotCols = snapshotCols || 0;

    if (task.assignedTo) {
      this.activeTaskBySession.delete(task.assignedTo);
      this.dispatchLock.delete(task.assignedTo);
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

  failTask(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'dispatched') return null;

    task.status = 'failed';
    task.completedAt = Date.now();
    task.result = error;

    if (task.assignedTo) {
      this.activeTaskBySession.delete(task.assignedTo);
      this.dispatchLock.delete(task.assignedTo);
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

    // Double-check session is actually idle right now (fresh read)
    const sessions = await fleet.getFleetStatus(this.config, this.router);
    const session = sessions.find(s => s.num === sessionNum);
    if (!session || session.state !== 'idle') {
      this.dispatchLock.delete(sessionNum);
      return false; // silently skip -- don't fail the task, just don't dispatch yet
    }

    task.status = 'dispatched';
    task.assignedTo = sessionNum;
    task.dispatchedAt = Date.now();
    task.lastActivityAt = Date.now();
    // Update watcher activity timestamp on dispatch
    if (this.watcher) this.watcher.sessionActivity.set(sessionNum, Date.now());
    this.activeTaskBySession.set(sessionNum, task.id);
    this.lastDispatchedAt.set(sessionNum, Date.now());

    this.emit('task:dispatched', task);
    this.pushFeed('task', sessionNum,
      `Task dispatched to session ${sessionNum}: "${task.text}"`);
    log.info(`[dispatch] Task ${task.id} dispatched to S:${sessionNum}: "${task.text.slice(0, 80)}"`);
    this._saveState();

    // Fire-and-forget: send the task text to Claude
    // For auto-dispatched tasks, clear context first so the agent starts fresh
    const sendTask = async () => {
      if (task.mode === 'auto') {
        const clearResult = await relay.tell(this.config, node, sessionName, '/clear', { vimMode: this.vimMode });
        if (clearResult.success) {
          await new Promise(r => setTimeout(r, 2500));
        }
      }
      // Build message with agent file preamble if designation has agent files
      let fullMessage = task.text;
      const desigName = task.designation || this.designations.get(sessionNum);
      const desigDef = desigName ? this.designationDefs.get(desigName) : null;
      if (desigDef && desigDef.agentFiles && desigDef.agentFiles.length > 0) {
        const parts = [];
        for (const f of desigDef.agentFiles) {
          try { parts.push(fs.readFileSync(f, 'utf8')); } catch {}
        }
        if (parts.length > 0) {
          fullMessage = parts.join('\n\n---\n\n') + '\n\n---\n\nTASK:\n' + task.text;
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
    log.info(`[idle] S:${num} idle — ${taskId ? 'completing task ' + taskId : 'no active task'}`);
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task || task.mode !== 'manual') {
        this.completeTask(taskId, null, preview || null, paneCols);
      } else {
        // Manual task still active — don't clear locks or dispatch next
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
      const manualTargeted = Array.from(this.tasks.values())
        .filter(t => t.status === 'queued' && t.mode === 'manual' && t.targetSession);
      for (const task of manualTargeted) {
        const session = sessions.find(s => s.num === task.targetSession);
        if (session && session.state === 'idle' && !this.dispatchLock.has(session.num) && !this.activeTaskBySession.has(session.num)) {
          await this._dispatchTask(task, task.targetSession);
        }
      }

      // Then: auto-mode tasks
      const queuedTasks = Array.from(this.tasks.values())
        .filter(t => t.status === 'queued' && t.mode === 'auto');
      if (!queuedTasks.length) return;

      const idleAuto = sessions.filter(s =>
        s.state === 'idle'
        && this.autoSessions.has(s.num)
        && !this.dispatchLock.has(s.num)
        && !this.activeTaskBySession.has(s.num)
      );
      if (!idleAuto.length) return;

      // Sort by least recently used — sessions idle longest get tasks first
      idleAuto.sort((a, b) =>
        (this.lastDispatchedAt.get(a.num) || 0) - (this.lastDispatchedAt.get(b.num) || 0)
      );

      // Dispatch one task per idle session (not all at once)
      for (const session of idleAuto) {
        const task = queuedTasks.find(t => {
          if (t.status !== 'queued') return false;
          if (t.designation) {
            return this.designations.get(session.num) === t.designation;
          }
          return true; // no designation -- any session
        });
        if (task) {
          await this._dispatchTask(task, session.num);
        }
      }
    } finally {
      this._autoDispatching = false;
    }
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

  // -- Users + Permissions -------------------------------------------

  static ALL_PERMISSIONS = ['view', 'comment', 'create-tasks', 'send-messages', 'cancel', 'restart', 'dispatch', 'admin'];

  ensureUser(login, name, avatar) {
    if (!login) return null;
    // Case-insensitive lookup: user may have been pre-added with lowercase key
    let user = this.users.get(login) || this.users.get(login.toLowerCase());
    if (user) {
      // Update profile fields on each login
      if (name) user.name = name;
      if (avatar) user.avatar = avatar;
      this.emit('users:changed', this.getUsersList());
      this._saveState();
      return user;
    }
    // First user ever, or env-specified admin
    const adminUser = process.env.HIVE_ADMIN_USER;
    const isFirstUser = this.users.size === 0;
    const isAdmin = isFirstUser || (adminUser && adminUser.toLowerCase() === login.toLowerCase());
    user = {
      login,
      name: name || login,
      avatar: avatar || '',
      permissions: isAdmin ? [...TaskQueue.ALL_PERMISSIONS] : ['view', 'comment'],
      firstSeen: Date.now(),
    };
    this.users.set(login, user);
    this.emit('users:changed', this.getUsersList());
    this._saveState();
    log.info(`[auth] User "${login}" registered (${isAdmin ? 'admin' : 'viewer'})`);
    return user;
  }

  hasPermission(login, capability) {
    if (!login) return false;
    const user = this.users.get(login);
    if (!user) return false;
    if (user.permissions.includes('admin')) return true;
    return user.permissions.includes(capability);
  }

  setUserPermissions(login, permissions) {
    const user = this.users.get(login);
    if (!user) return null;
    user.permissions = permissions.filter(p => TaskQueue.ALL_PERMISSIONS.includes(p));
    this.emit('users:changed', this.getUsersList());
    this._saveState();
    return user;
  }

  getUser(login) {
    return this.users.get(login) || null;
  }

  getUsersList() {
    return Array.from(this.users.values());
  }

  addUser(login, permissions) {
    if (!login) return null;
    login = login.trim().toLowerCase();
    if (this.users.has(login)) return this.users.get(login); // already exists
    const user = {
      login,
      name: login,
      avatar: '',
      permissions: Array.isArray(permissions) ? permissions : ['view', 'comment'],
      firstSeen: Date.now(),
    };
    this.users.set(login, user);
    this.emit('users:changed', this.getUsersList());
    this._saveState();
    log.info(`[auth] User "${login}" pre-added by admin`);
    return user;
  }

  removeUser(login) {
    if (!login) return false;
    login = login.trim().toLowerCase();
    if (!this.users.has(login)) return false;
    this.users.delete(login);
    this.emit('users:changed', this.getUsersList());
    this._saveState();
    log.info(`[auth] User "${login}" removed by admin`);
    return true;
  }

  // -- Task Comments ------------------------------------------------

  addComment(taskId, authorLogin, authorName, text) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (!task.comments) task.comments = [];
    const comment = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      author: authorLogin,
      authorName: authorName || authorLogin,
      text,
      createdAt: Date.now(),
    };
    task.comments.push(comment);
    this.emit('task:comment:added', { taskId, comment });
    this._saveState();
    return comment;
  }

  deleteComment(taskId, commentId, requestingLogin) {
    const task = this.tasks.get(taskId);
    if (!task || !task.comments) return false;
    const idx = task.comments.findIndex(c => c.id === commentId);
    if (idx < 0) return false;
    const comment = task.comments[idx];
    // Only author or admin can delete
    if (comment.author !== requestingLogin && !this.hasPermission(requestingLogin, 'admin')) {
      return false;
    }
    task.comments.splice(idx, 1);
    this.emit('task:comment:deleted', { taskId, commentId });
    this._saveState();
    return true;
  }

  // -- Checklist Templates -------------------------------------------

  getChecklistTemplates() {
    return Array.from(this.checklistTemplates.values());
  }

  setChecklistTemplate(name, items) {
    if (!name) return null;
    const template = { name, items: Array.isArray(items) ? items : [] };
    this.checklistTemplates.set(name, template);
    this.emit('checklistTemplates:changed', this.getChecklistTemplates());
    this._saveState();
    return template;
  }

  removeChecklistTemplate(name) {
    if (!this.checklistTemplates.has(name)) return false;
    this.checklistTemplates.delete(name);
    this.emit('checklistTemplates:changed', this.getChecklistTemplates());
    this._saveState();
    return true;
  }

  // -- Task Checklist -----------------------------------------------

  toggleChecklistItem(taskId, itemId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.checklist) return null;
    const item = task.checklist.find(i => i.id === itemId);
    if (!item) return null;
    item.checked = !item.checked;
    this.emit('task:updated', task);
    this._saveState();
    return task;
  }

  addChecklistItem(taskId, text) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (!task.checklist) task.checklist = [];
    const item = {
      id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      checked: false,
    };
    task.checklist.push(item);
    this.emit('task:updated', task);
    this._saveState();
    return task;
  }

  removeChecklistItem(taskId, itemId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.checklist) return null;
    const idx = task.checklist.findIndex(i => i.id === itemId);
    if (idx < 0) return null;
    task.checklist.splice(idx, 1);
    this.emit('task:updated', task);
    this._saveState();
    return task;
  }

  setTaskChecklist(taskId, checklist) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.checklist = (checklist || []).map(item => ({
      id: item.id || `cl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: item.text,
      checked: !!item.checked,
    }));
    this.emit('task:updated', task);
    this._saveState();
    return task;
  }

  // -- Designations -------------------------------------------------

  setDesignation(num, designation) {
    if (designation) {
      this.designations.set(num, designation);
    } else {
      this.designations.delete(num);
    }
    this._saveState();
    this.emit('designations:changed', this.getDesignations());
    // Re-evaluate dispatch with new designation mapping
    this._tryAutoDispatch().catch(err =>
      log.error('Auto-dispatch error:', err.message));
  }

  getDesignations() {
    const obj = {};
    for (const [num, des] of this.designations) obj[num] = des;
    return obj;
  }

  // -- Designation Definitions --------------------------------------

  getDesignationDefs() {
    return Array.from(this.designationDefs.values());
  }

  setDesignationDef(name, { agentFiles, description, color }) {
    if (!name) return null;
    const def = {
      name,
      agentFiles: Array.isArray(agentFiles) ? agentFiles : [],
      description: description || '',
      color: color || 'orange',
    };
    this.designationDefs.set(name, def);
    this._saveState();
    this.emit('designationDefs:changed', this.getDesignationDefs());
    return def;
  }

  removeDesignationDef(name) {
    if (!this.designationDefs.has(name)) return false;
    this.designationDefs.delete(name);
    // Clear any session assignments using this designation
    for (const [num, des] of this.designations) {
      if (des === name) this.designations.delete(num);
    }
    this._saveState();
    this.emit('designationDefs:changed', this.getDesignationDefs());
    this.emit('designations:changed', this.getDesignations());
    return true;
  }

  // -- Agent Roots + File Scanning ----------------------------------

  getAgentRoots() {
    return this.agentRoots;
  }

  setAgentRoots(roots) {
    this.agentRoots = Array.isArray(roots) ? roots : [];
    this._saveState();
    this.emit('agentRoots:changed', this.agentRoots);
  }

  scanAgentFiles() {
    const results = [];
    for (const root of this.agentRoots) {
      const expanded = root.replace(/^~/, os.homedir());
      try {
        this._scanDir(expanded, expanded, results);
      } catch {
        // Root doesn't exist or isn't readable
      }
    }
    this.agentFilesList = results;
    this.emit('agentFiles:scanned', this.agentFilesList);
    return this.agentFilesList;
  }

  _scanDir(dir, root, results) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this._scanDir(fullPath, root, results);
      } else if (entry.name.endsWith('.md')) {
        results.push({
          path: fullPath,
          name: entry.name,
          relativePath: path.relative(root, fullPath),
          root,
        });
      }
    }
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

  async spawnSession({ num, baseDir, name, gitUrl, worktreeFrom, branch, baseBranch } = {}) {
    if (!name) throw new Error('Agent name is required');
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Agent name must contain only letters, numbers, hyphens, and underscores');
    log.info(`[spawn] starting: name=${name}, num=${num ?? 'auto'}, baseDir=${baseDir || 'default'}, gitUrl=${gitUrl || 'none'}`);

    // Resolve base directory
    baseDir = (baseDir || process.env.HIVE_REPO_DIR || '~/Desktop/Viv').replace(/^~(?=\/|$)/, os.homedir());
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

    // Build repo path: baseDir/num-name (e.g. ~/Desktop/Viv/0-ascend)
    const repoDir = path.join(baseDir, `${num}-${name}`);
    log.info(`[spawn] repoDir=${repoDir}`);

    // Create repo: worktree, clone, or empty directory
    if (worktreeFrom) {
      const parentRepo = worktreeFrom.replace(/^~(?=\/|$)/, os.homedir());
      if (!path.isAbsolute(parentRepo)) throw new Error('Parent repo must be an absolute path');
      if (!fs.existsSync(path.join(parentRepo, '.git'))) throw new Error('Parent repo is not a git repository');
      const branchName = branch || `hive-slot-${num}`;
      const baseBranchRef = baseBranch || 'master';
      try {
        if (fs.existsSync(repoDir)) {
          // Verify it's a valid linked worktree before reusing
          const gitPath = path.join(repoDir, '.git');
          if (!fs.existsSync(gitPath) || fs.statSync(gitPath).isDirectory()) {
            throw new Error(`Directory ${repoDir} exists but is not a linked worktree. Remove it manually first.`);
          }
          log.info(`[spawn] reusing existing worktree at ${repoDir}`);
        } else {
          execFileSync('git', ['-C', parentRepo, 'worktree', 'add', repoDir, '-b', branchName, baseBranchRef], {
            timeout: 30000,
            stdio: 'pipe',
          });
        }
      } catch (err) {
        throw new Error(`Worktree creation failed: ${err.message}`);
      }
    } else if (gitUrl) {
      if (fs.existsSync(path.join(repoDir, '.git'))) {
        // Directory already cloned — fetch and reset to latest default branch
        log.info(`[spawn] Reusing existing clone at ${repoDir}`);
        try {
          await execAsync(`git -C "${repoDir}" fetch origin`, { timeout: 60000 });
          // Determine default branch — try main, fall back to master
          let defaultBranch = 'main';
          try {
            await execAsync(`git -C "${repoDir}" rev-parse --verify origin/main`, { timeout: 5000 });
          } catch {
            defaultBranch = 'master';
          }
          await execAsync(`git -C "${repoDir}" checkout ${defaultBranch}`, { timeout: 10000 });
          await execAsync(`git -C "${repoDir}" reset --hard origin/${defaultBranch}`, { timeout: 10000 });
        } catch (err) {
          throw new Error(`Git reset of existing clone failed: ${err.message}`);
        }
      } else {
        try {
          execFileSync('git', ['clone', gitUrl, repoDir], { timeout: 300000, stdio: 'pipe' });
        } catch (err) {
          throw new Error(`Git clone failed: ${err.message}`);
        }
      }
    } else {
      try {
        fs.mkdirSync(repoDir, { recursive: true });
      } catch (err) {
        throw new Error(`Failed to create directory: ${err.message}`);
      }
    }

    // Start tmux session using agent.yml template
    const agentYml = (
      process.env.HIVE_AGENT_YML ||
      path.join(os.homedir(), 'Desktop', 'Viv', 'hive-agents', 'agent.yml')
    ).replace(/^~(?=\/|$)/, os.homedir());
    const tmuxCmd = `/bin/zsh -lc 'tmuxinator start -p ${agentYml} N=${num} ROOT="${repoDir}" --no-attach'`;
    log.info(`[spawn] running: ${tmuxCmd}`);
    try {
      await execAsync(tmuxCmd, { timeout: 15000 });
      log.info(`[spawn] tmuxinator started session ${num}`);
    } catch (err) {
      log.error(`[spawn] tmuxinator failed: ${err.message}`);
      throw new Error(`Failed to start session ${num}: ${err.message}`);
    }

    // Register spawned agent
    this.spawnedAgents.set(num, { repoDir, name });
    this._saveState();

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

    const agentYml = (
      process.env.HIVE_AGENT_YML ||
      path.join(os.homedir(), 'dev', 'agents', 'tmux', 'agent.yml')
    ).replace(/^~/, os.homedir());

    for (const [num, info] of this.spawnedAgents) {
      if (liveSessions.has(num)) {
        results.skipped.push(num);
        continue;
      }
      const tmuxCmd = `/bin/zsh -lc 'tmuxinator start -p ${agentYml} N=${num} ROOT="${info.repoDir}" --no-attach'`;
      try {
        await execAsync(tmuxCmd, { timeout: 15000 });
        log.info(`[respawn] session ${num} (${info.name}) restarted`);
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
      if (data.spawnSlotMin !== undefined) this.spawnSlotMin = data.spawnSlotMin;
      if (data.spawnSlotMax !== undefined) this.spawnSlotMax = data.spawnSlotMax;
      // Restore tasks
      if (Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
          // Preserve dispatched tasks and their session assignments across restarts.
          // The session is still running in tmux — don't reset to queued or send /clear.
          if (t.status === 'dispatched' && t.assignedTo) {
            this.activeTaskBySession.set(t.assignedTo, t.id);
            this.dispatchLock.add(t.assignedTo);
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
      spawnSlotMin: this.spawnSlotMin,
      spawnSlotMax: this.spawnSlotMax,
      checklistTemplates: this.getChecklistTemplates(),
    };
    // Merge PM data if pmManager is attached
    if (this._pmManager) {
      data.pms = this._pmManager.serialize();
    }
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
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

module.exports = TaskQueue;
