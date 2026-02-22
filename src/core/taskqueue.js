const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const relay = require('./relay');
const fleet = require('./fleet');
const tmux = require('./tmux');

const STATE_FILE = path.join(__dirname, '..', '..', '.hive-state.json');

let nextTaskId = 1;
let nextApprovalId = 1;

class TaskQueue extends EventEmitter {
  constructor(config, watcher) {
    super();
    this.config = config;
    this.watcher = watcher;

    // State
    this.tasks = new Map();           // id → Task
    this.autoSessions = new Set();    // session numbers opted into auto-mode
    this.feed = [];                   // ring buffer, max 200
    this.approvals = new Map();       // id → Approval
    this.dispatchLock = new Set();    // session numbers currently being dispatched to
    this.activeTaskBySession = new Map(); // session num → task id

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
  }

  // ── Task lifecycle ─────────────────────────────────

  createTask(text, mode, targetSession) {
    const task = {
      id: String(nextTaskId++),
      text,
      mode, // 'auto' or 'manual'
      targetSession: targetSession || null,
      status: 'queued',
      assignedTo: null,
      createdAt: Date.now(),
      dispatchedAt: null,
      completedAt: null,
      result: null,
    };
    this.tasks.set(task.id, task);
    this.emit('task:created', task);
    this.pushFeed('task', null, `Task created: "${text}" (${mode})`);

    if (mode === 'manual' && targetSession) {
      this._dispatchTask(task, targetSession);
    } else if (mode === 'auto') {
      // Try to dispatch immediately to an idle auto-session
      this._tryAutoDispatch();
    }

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

  completeTask(taskId, result) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'dispatched') return null;

    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result || null;

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
      `Task failed: "${task.text}" — ${error}`);
    return task;
  }

  _dispatchTask(task, sessionNum) {
    if (this.dispatchLock.has(sessionNum)) return false;
    this.dispatchLock.add(sessionNum);

    const sessionName = fleet.findSession(this.config, sessionNum);
    if (!sessionName) {
      this.dispatchLock.delete(sessionNum);
      this.failTask(task.id, `Session ${sessionNum} not found`);
      return false;
    }

    task.status = 'dispatched';
    task.assignedTo = sessionNum;
    task.dispatchedAt = Date.now();
    this.activeTaskBySession.set(sessionNum, task.id);

    this.emit('task:dispatched', task);
    this.pushFeed('task', sessionNum,
      `Task dispatched to session ${sessionNum}: "${task.text}"`);

    // Fire-and-forget: send the task text to Claude
    relay.tell(this.config, sessionName, task.text).then((result) => {
      if (!result.success) {
        this.failTask(task.id, result.error || 'Tell failed');
      }
      // Don't unlock dispatchLock here — wait for session to go idle
    }).catch((err) => {
      this.failTask(task.id, err.message);
    });

    return true;
  }

  _tryAutoDispatch() {
    // Find first queued auto task
    const queuedTask = Array.from(this.tasks.values())
      .find(t => t.status === 'queued' && t.mode === 'auto');
    if (!queuedTask) return;

    // Find an idle auto-session that isn't locked
    const sessions = fleet.getFleetStatus(this.config);
    for (const s of sessions) {
      if (s.state === 'idle'
          && this.autoSessions.has(s.num)
          && !this.dispatchLock.has(s.num)
          && !this.activeTaskBySession.has(s.num)) {
        this._dispatchTask(queuedTask, s.num);
        return;
      }
    }
  }

  // ── Auto-mode ──────────────────────────────────────

  toggleAutoSession(num) {
    if (this.autoSessions.has(num)) {
      this.autoSessions.delete(num);
    } else {
      this.autoSessions.add(num);
    }
    this._saveState();
    this.emit('auto:changed', this.getAutoSessions());
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

  // ── Broadcast ──────────────────────────────────────

  async broadcast(message, target, specificSessions) {
    const sessions = fleet.getFleetStatus(this.config);
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
        const result = await relay.tell(this.config, s.name, message);
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

  // ── Approvals ──────────────────────────────────────

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

  resolveApproval(approvalId, approved) {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.status !== 'pending') return null;

    approval.status = approved ? 'approved' : 'denied';
    approval.resolvedAt = Date.now();

    // Send y or n key to the session
    const sessionName = fleet.findSession(this.config, approval.session);
    if (sessionName) {
      const paneTarget = `${sessionName}:.${this.config.sessions.claudePane}`;
      const key = approved ? 'y' : 'n';
      tmux.exec(`tmux send-keys -t "${paneTarget}" ${key}`);
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

  // ── Feed ───────────────────────────────────────────

  pushFeed(type, session, detail) {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type, // 'state' | 'task' | 'ci' | 'approval' | 'broadcast' | 'user'
      session,
      detail,
      timestamp: Date.now(),
    };

    this.feed.push(entry);
    if (this.feed.length > 200) this.feed.shift();

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

  // ── Auto-pilot rules ──────────────────────────────

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
          this._tryAutoDispatch();
          break;

        case 'dispatch-fix':
          if (data && data.num && this.autoSessions.has(data.num)) {
            const message = trigger === 'ci:fail'
              ? 'CI failed. Please check the build logs and fix any issues.'
              : 'Review changes requested. Please address the review feedback.';
            this.createTask(message, 'manual', data.num);
          }
          break;
      }
    }
  }

  // ── Persistence ─────────────────────────────────────

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
      console.log(`Loaded state: ${this.autoSessions.size} auto-sessions`);
    } catch {
      // No state file yet — that's fine
    }
  }

  _saveState() {
    const data = {
      autoSessions: Array.from(this.autoSessions),
      rules: this.rules.map(r => ({ id: r.id, enabled: r.enabled })),
    };
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Failed to save state:', err.message);
    }
  }

  // ── Watcher integration ────────────────────────────

  _wireWatcher() {
    this.watcher.on('session:idle', (data) => {
      this.pushFeed('state', data.num, `Session ${data.num} went idle`);

      // Complete active task for this session
      const taskId = this.activeTaskBySession.get(data.num);
      if (taskId) {
        this.completeTask(taskId);
      }
      this.dispatchLock.delete(data.num);

      // Evaluate auto-pilot rules
      this.evaluateRules('session:idle', data);
    });

    this.watcher.on('session:working', (data) => {
      this.pushFeed('state', data.num, `Session ${data.num} started working`);
    });

    this.watcher.on('ci:changed', (data) => {
      const label = data.to === 'SUCCESS' ? 'PASS' : data.to === 'FAILURE' ? 'FAIL' : data.to;
      this.pushFeed('ci', data.num,
        `CI ${label} — session ${data.num} PR#${data.pr}`);

      if (data.to === 'FAILURE') {
        this.evaluateRules('ci:fail', data);
      }
    });

    this.watcher.on('approval:requested', (data) => {
      this.createApproval(data.num, data.prompt);
    });

    this.watcher.on('review:changed', (data) => {
      this.pushFeed('ci', data.num,
        `Review: ${data.to} — session ${data.num} PR#${data.pr}`);

      if (data.to === 'CHANGES_REQUESTED') {
        this.evaluateRules('review:changes_requested', data);
      }
    });
  }

  // ── Serialization (for sending to clients) ─────────

  getTasksList() {
    return Array.from(this.tasks.values())
      .filter(t => t.status !== 'cancelled')
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

module.exports = TaskQueue;
