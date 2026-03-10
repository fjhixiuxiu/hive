const EventEmitter = require('events');
const { exec } = require('child_process');
const cron = require('node-cron');
const log = require('./log');
const pmSources = require('./pm-sources');

const MAX_MEMORY = 100;
const MAX_LEARNING_LENGTH = 500;
const SIMILARITY_THRESHOLD = 0.8; // 80% token overlap = duplicate

let nextPmId = 1;

/**
 * Normalize text for comparison: lowercase, strip punctuation, collapse whitespace.
 */
function _normalizeForCompare(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Check if two learning strings are semantically the same.
 * Uses normalized containment: if the shorter text's words are mostly
 * contained in the longer text, it's a duplicate.
 * Returns true if duplicate.
 */
function _isSimilar(a, b) {
  const normA = _normalizeForCompare(a);
  const normB = _normalizeForCompare(b);
  // Exact normalized match
  if (normA === normB) return true;
  const wordsA = new Set(normA.split(' '));
  const wordsB = new Set(normB.split(' '));
  // Use the shorter one as the query — check how much of it appears in the longer one
  const [smaller, larger] = wordsA.size <= wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA];
  if (smaller.size < 3) return normA === normB;
  let overlap = 0;
  for (const w of smaller) {
    if (larger.has(w)) overlap++;
  }
  // If 80%+ of the shorter text's words appear in the longer one, it's a dup
  return (overlap / smaller.size) >= SIMILARITY_THRESHOLD;
}

/**
 * Check if a new learning is a duplicate of any existing one.
 */
function _isDuplicate(text, memory) {
  for (const existing of memory) {
    if (_isSimilar(text, existing)) return true;
  }
  return false;
}

/**
 * Remove duplicate learnings from a memory array (keeps the later/longer version).
 */
function _deduplicateMemory(memory) {
  const result = [];
  for (const text of memory) {
    const dupeIdx = result.findIndex(existing => _isSimilar(text, existing));
    if (dupeIdx === -1) {
      result.push(text);
    } else if (text.length > result[dupeIdx].length) {
      // Keep the longer (more detailed) version
      result[dupeIdx] = text;
    }
  }
  return result.slice(-MAX_MEMORY);
}

class ProjectManager extends EventEmitter {
  constructor(taskQueue) {
    super();
    this.taskQueue = taskQueue;
    this.pms = new Map(); // id → PM config
    this.timers = new Map(); // id → interval handle
    // Let taskQueue know about us so _saveState() includes PM data
    taskQueue._pmManager = this;
    this._githubLogin = null;
    this._resolveGithubLogin();
  }

  // ── CRUD ────────────────────────────────────────────

  create(cfg) {
    const id = String(nextPmId++);
    const pm = {
      id,
      name: cfg.name || 'Untitled PM',
      source: cfg.source || { type: 'jira', jql: '' },
      designation: cfg.designation || null,
      instructions: cfg.instructions || '',
      targetSession: cfg.targetSession || null,
      autoThreshold: cfg.autoThreshold != null ? cfg.autoThreshold : 3,
      pollInterval: cfg.pollInterval || 60000,
      schedule: cfg.schedule || null,
      taskFormat: cfg.taskFormat || null,
      checklistTemplate: cfg.checklistTemplate || null,
      mcpEnabled: cfg.mcpEnabled || false,
      learningEnabled: cfg.learningEnabled || false,
      learningPrompt: cfg.learningPrompt || '',
      memory: [],
      completionConditions: cfg.completionConditions || [],
      continueConditions: cfg.continueConditions || [],
      boardStates: cfg.boardStates || null, // per-PM work state overrides: [{ stateId, autoOnStatus }]
      enabled: false,
      seenKeys: [],
      tasksCreated: 0,
      lastPoll: null,
      lastError: null,
    };
    this.pms.set(id, pm);
    this._save();
    this.emit('pm:changed');
    return pm;
  }

  update(id, updates) {
    const pm = this.pms.get(id);
    if (!pm) return null;
    const wasEnabled = pm.enabled;
    for (const [k, v] of Object.entries(updates)) {
      if (k === 'id' || k === 'seenKeys' || k === 'tasksCreated' || k === 'lastPoll' || k === 'lastError' || k === 'memory') continue;
      pm[k] = v;
    }
    // Restart polling if interval changed or was re-enabled
    if (wasEnabled && pm.enabled) {
      this._stopPolling(id);
      this._startPolling(id);
    }
    this._save();
    this.emit('pm:changed');
    return pm;
  }

  remove(id) {
    this._stopPolling(id);
    this.pms.delete(id);
    this._save();
    this.emit('pm:changed');
  }

  toggle(id) {
    const pm = this.pms.get(id);
    if (!pm) return;
    pm.enabled = !pm.enabled;
    if (pm.enabled) {
      this._startPolling(id);
    } else {
      this._stopPolling(id);
    }
    this._save();
    this.emit('pm:changed');
  }

  rescan(id) {
    const pm = this.pms.get(id);
    if (!pm) return;
    // Clear per-PM poll timestamp so next poll does a full scan
    if (this._reReviewPollTimes) delete this._reReviewPollTimes[id];
    // Trigger an immediate poll
    if (pm.enabled) {
      this._poll(id).catch(err => log.error(`Scan Now error for ${pm.name}:`, err.message));
    }
    log.info(`[pm] Scan Now triggered for "${pm.name}"`);
  }

  reset(id) {
    const pm = this.pms.get(id);
    if (!pm) return;
    pm.seenKeys = [];
    pm.tasksCreated = 0;
    pm.lastPoll = null;
    pm.lastError = null;
    if (this._reReviewPollTimes) delete this._reReviewPollTimes[id];
    this._save();
    this.emit('pm:changed');
    log.info(`[pm] Reset memory for "${pm.name}" — next poll will treat all issues as new`);
  }

  getAll() {
    return Array.from(this.pms.values());
  }

  get(id) {
    return this.pms.get(id) || null;
  }

  addLearnings(id, learnings) {
    const pm = this.pms.get(id);
    if (!pm || !Array.isArray(learnings)) return 0;
    if (!pm.memory) pm.memory = [];
    let added = 0;
    for (const learning of learnings) {
      if (typeof learning !== 'string' || !learning.trim()) continue;
      const text = learning.trim().slice(0, MAX_LEARNING_LENGTH);
      if (_isDuplicate(text, pm.memory)) continue;
      pm.memory.push(text);
      added++;
    }
    // Cap entries (FIFO)
    if (pm.memory.length > MAX_MEMORY) {
      pm.memory = pm.memory.slice(-MAX_MEMORY);
    }
    if (added > 0) {
      this._save();
      this.emit('pm:changed');
    }
    return added;
  }

  // ── Serialization ───────────────────────────────────

  serialize() {
    return this.getAll().map(pm => ({
      ...pm,
      seenKeys: pm.seenKeys.slice(-5000),
      memory: (pm.memory || []).slice(-MAX_MEMORY),
    }));
  }

  loadState(pmsData) {
    if (!Array.isArray(pmsData)) return;
    for (const data of pmsData) {
      const id = data.id || String(nextPmId++);
      if (Number(id) >= nextPmId) nextPmId = Number(id) + 1;
      const pm = {
        id,
        name: data.name || 'Untitled PM',
        source: data.source || { type: 'jira', jql: '' },
        designation: data.designation || null,
        instructions: data.instructions || '',
        targetSession: data.targetSession || null,
        autoThreshold: data.autoThreshold != null ? data.autoThreshold : 3,
        pollInterval: data.pollInterval || 60000,
        schedule: data.schedule || null,
        taskFormat: data.taskFormat || null,
        checklistTemplate: data.checklistTemplate || null,
        mcpEnabled: data.mcpEnabled || false,
        learningEnabled: data.learningEnabled || false,
        learningPrompt: data.learningPrompt || '',
        memory: _deduplicateMemory(Array.isArray(data.memory) ? data.memory.filter(m => typeof m === 'string' && m.trim()) : []),
        completionConditions: Array.isArray(data.completionConditions) ? data.completionConditions : [],
        continueConditions: Array.isArray(data.continueConditions) ? data.continueConditions : [],
        enabled: data.enabled || false,
        seenKeys: Array.isArray(data.seenKeys) ? data.seenKeys : [],
        tasksCreated: data.tasksCreated || 0,
        lastPoll: data.lastPoll || null,
        lastError: data.lastError || null,
      };
      this.pms.set(id, pm);
      if (pm.enabled) {
        this._startPolling(id);
      }
    }
    log.info(`Loaded ${this.pms.size} project managers`);
  }

  // ── Polling ─────────────────────────────────────────

  _startPolling(id) {
    const pm = this.pms.get(id);
    if (!pm) return;
    this._stopPolling(id); // clear any existing

    // Slack source: config-only, no polling (bot reads PM on demand)
    if (pm.source.type === 'slack') {
      return;
    }

    // Manual source: create one task immediately; if no schedule, stop
    if (pm.source.type === 'manual' && !pm.schedule) {
      this._createManualTask(id);
      return;
    }

    // Determine the callback based on source type
    let callback;
    if (pm.source.type === 'manual') {
      callback = async () => { await this._createManualTask(id); await this._checkCompletions(id); await this._checkContinueConditions(id); };
    } else if (pm.source.type === 'command') {
      callback = async () => { await this._createCommandTask(id); await this._checkCompletions(id); await this._checkContinueConditions(id); };
    } else if (pm.source.type === 'script') {
      callback = async () => { await this._runScript(id); await this._checkCompletions(id); await this._checkContinueConditions(id); };
    } else {
      callback = async () => { await this._poll(id); await this._checkCompletions(id); await this._checkContinueConditions(id); };
    }

    // Run immediately (skip for manual+schedule — those should only fire on cron)
    if (!(pm.source.type === 'manual' && pm.schedule)) {
      callback();
    }

    // Schedule repeats: cron expression takes precedence over interval
    if (pm.schedule && cron.validate(pm.schedule)) {
      const task = cron.schedule(pm.schedule, callback);
      this.timers.set(id, task);
    } else {
      if (pm.schedule && !cron.validate(pm.schedule)) {
        log.error(`[pm] Invalid cron expression "${pm.schedule}" for "${pm.name}", falling back to interval`);
        pm.lastError = `Invalid cron expression: ${pm.schedule}`;
      }
      const interval = setInterval(callback, pm.pollInterval);
      this.timers.set(id, interval);
    }
  }

  _stopPolling(id) {
    const timer = this.timers.get(id);
    if (timer) {
      if (typeof timer.stop === 'function') {
        timer.stop(); // cron ScheduledTask
      } else {
        clearInterval(timer); // plain interval handle
      }
      this.timers.delete(id);
    }
  }

  _createManualTask(id) {
    const pm = this.pms.get(id);
    if (!pm) return;

    const text = (pm.source.command || pm.source.text || '').trim();
    if (!text) {
      pm.lastError = 'No task text provided';
      this._save();
      this.emit('pm:changed');
      return;
    }

    // Skip if there's already a queued or dispatched task with the same text
    const existing = [...this.taskQueue.tasks.values()].find(
      (t) => t.source === `pm:${pm.name}` && (t.status === 'queued' || t.status === 'dispatched'),
    );
    if (existing) return;

    const key = `manual-${id}-${Date.now()}`;
    pm.seenKeys.push(key);
    const mode = 'manual'; // manual tasks always go to manual queue
    let taskText = text;
    if (pm.taskFormat) {
      taskText = pm.taskFormat.replace('{key}', key).replace('{summary}', text);
    }
    const task = this.taskQueue.createTask(taskText, mode, pm.targetSession || null, pm.designation, { source: `pm:${pm.name}` });
    this._seedChecklist(pm, task);
    pm.tasksCreated++;
    pm.lastPoll = Date.now();
    pm.lastError = null;

    // Auto-disable after creating the task (unless scheduled to repeat)
    if (!pm.schedule) {
      pm.enabled = false;
      this._stopPolling(id);
    }

    this.taskQueue.pushFeed('task', null, `PM "${pm.name}" created manual task`);
    this._save();
    this.emit('pm:changed');
  }

  async _createCommandTask(id) {
    const pm = this.pms.get(id);
    if (!pm || !pm.enabled) return;

    const command = (pm.source.command || '').trim();
    if (!command) return;

    // Skip if there's already a queued or active task for this command
    const existing = [...this.taskQueue.tasks.values()].find(
      (t) =>
        t.text === command &&
        (t.status === 'queued' ||
          t.status === 'dispatched' ||
          t.status === 'in-progress'),
    );
    if (existing) return;

    // Find any idle session (bypass auto-mode requirement)
    const fleet = require('./fleet');
    const sessions = await fleet.getFleetStatus(
      this.taskQueue.config,
      this.taskQueue.router,
    );
    const idle = sessions.find(
      (s) =>
        s.state === 'idle' &&
        !this.taskQueue.dispatchLock.has(s.num) &&
        !this.taskQueue.activeTaskBySession.has(s.num) &&
        (!pm.designation ||
          this.taskQueue.designations.get(s.num) === pm.designation),
    );

    if (idle) {
      const task = this.taskQueue.createTask(
        command,
        'auto',
        idle.num,
        pm.designation,
      );
      this._seedChecklist(pm, task);
      pm.tasksCreated++;
      this.taskQueue.pushFeed(
        'task',
        null,
        `PM "${pm.name}" dispatched ${command} to session ${idle.num}`,
      );
    } else {
      const task = this.taskQueue.createTask(command, 'auto', null, pm.designation);
      this._seedChecklist(pm, task);
      pm.tasksCreated++;
      this.taskQueue.pushFeed(
        'task',
        null,
        `PM "${pm.name}" queued ${command} (no idle session)`,
      );
    }

    pm.lastPoll = Date.now();
    pm.lastError = null;
    this._save();
    this.emit('pm:changed');
  }

  async _runScript(id) {
    const pm = this.pms.get(id);
    if (!pm || !pm.enabled) return;

    const script = (pm.source.script || '').trim();
    if (!script) return;

    const action = pm.source.scriptAction || 'feed';

    try {
      const output = await this._exec(script, { shell: '/bin/zsh -l', timeout: 30000 });

      pm.lastPoll = Date.now();
      pm.lastError = null;

      if (action === 'feed') {
        if (output) {
          this.taskQueue.pushFeed('task', null, `PM "${pm.name}" script output: ${output}`);
        }
      } else if (action === 'task' || (action === 'task-if-output' && output)) {
        // Skip if there's already a queued or active task from this PM/script
        const existing = [...this.taskQueue.tasks.values()].find(
          (t) =>
            t.source === `pm:${pm.name}` &&
            (t.status === 'queued' ||
              t.status === 'dispatched' ||
              t.status === 'in-progress'),
        );
        if (!existing) {
          const mode = pm.targetSession ? 'manual' : 'auto';
          const taskText = output || '(no output)';
          const task = this.taskQueue.createTask(taskText, mode, pm.targetSession || null, pm.designation, { source: `pm:${pm.name}` });
          this._seedChecklist(pm, task);
          pm.tasksCreated++;
          this.taskQueue.pushFeed('task', null, `PM "${pm.name}" created task from script output`);
        }
      }
      // action === 'task-if-output' with empty output: do nothing

      this._save();
      this.emit('pm:changed');
    } catch (err) {
      pm.lastPoll = Date.now();
      pm.lastError = err.message;
      this._save();
      this.emit('pm:changed');
    }
  }

  async _poll(id) {
    const pm = this.pms.get(id);
    if (!pm || !pm.enabled) return;
    if (pm.source.type === 'slack') return; // config-only, no polling

    try {
      let issues;
      switch (pm.source.type) {
        case 'jira':    issues = await this._fetchJira(pm.source); break;
        case 'github-issues': issues = await this._fetchGithubIssues(pm.source); break;
        case 'github-prs':   issues = await this._fetchGithubPrs(pm.source); break;
        case 'jenkins': issues = await this._fetchJenkins(pm.source); break;
        case 'zoho':    issues = await this._fetchZoho(pm.source); break;
        case 'github-re-reviews': issues = await this._fetchReReviews(pm.source, pm.id); break;
        default: throw new Error(`Unsupported source type: ${pm.source.type}`);
      }
      pm.lastPoll = Date.now();
      pm.lastError = null;

      const seenSet = new Set(pm.seenKeys);
      let created = 0;

      for (const issue of issues) {
        if (seenSet.has(issue.key)) continue;

        // Add to seen
        pm.seenKeys.push(issue.key);
        seenSet.add(issue.key);

        // Already-queued: reply on GitHub instead of creating a duplicate task
        if (issue._alreadyQueued) {
          const assignee = pm.source.reviewer || 'hive';
          const body = `🐝 Already queued for review by \`${assignee}\``;
          this._commentOnPR(issue._repo, issue._prNumber, body).catch(err => {
            log.error(`Failed to comment on PR #${issue._prNumber}:`, err.message);
          });
          continue;
        }

        // Evaluate complexity; force 'manual' if PM targets a specific session
        const mode = pm.targetSession ? 'manual' : this._evaluateComplexity(issue, pm.autoThreshold);
        let text;
        if (pm.taskFormat) {
          text = pm.taskFormat
            .replace('{key}', issue.key)
            .replace('{summary}', issue.summary)
            .replace('{prNumber}', issue._prNumber || '');
        } else {
          text = `[${issue.key}] ${issue.summary}`;
        }
        const meta = { source: `pm:${pm.name}` };

        // Attach actionContext for PR-sourced tasks
        if (pm.source.type === 'github-prs' || pm.source.type === 'github-re-reviews') {
          const prMeta = this._parsePRFromKey(issue.key);
          if (prMeta) {
            meta.actionContext = { type: 'github-pr', repo: prMeta.repo, prNumber: prMeta.prNumber };
            meta.pr = prMeta.prNumber;
          }
        }

        const task = this.taskQueue.createTask(text, mode, pm.targetSession || null, pm.designation, meta);
        task.sourceKey = issue.key;
        this._seedChecklist(pm, task);

        // Post GitHub PR comment if this is a PR-sourced task
        if (pm.source.type === 'github-prs' || pm.source.type === 'github-re-reviews') {
          const prInfo = this._parsePRFromKey(issue.key);
          if (prInfo) {
            const pos = this.taskQueue.getQueuePosition(task.id);
            const desig = pm.designation || 'general';
            const posText = pos === 1 ? 'next up' : `#${pos} in queue`;
            const assignee = pm.source.reviewer || 'hive';
            const body = `🐝 **Queued for review** by \`${assignee}\` — ${posText} (${desig})`;
            this._commentOnPR(prInfo.repo, prInfo.prNumber, body).catch(err => {
              log.error(`Failed to comment on PR #${prInfo.prNumber}:`, err.message);
            });
          }
        }

        created++;
        pm.tasksCreated++;
      }

      // Cap seenKeys (FIFO)
      if (pm.seenKeys.length > 5000) {
        pm.seenKeys = pm.seenKeys.slice(-5000);
      }

      if (created > 0) {
        this.taskQueue.pushFeed('task', null,
          `PM "${pm.name}" created ${created} task${created > 1 ? 's' : ''}`);
      }

      this._save();
      this.emit('pm:changed');
    } catch (err) {
      pm.lastPoll = Date.now();
      pm.lastError = err.message;
      this._save();
      this.emit('pm:error', { id, error: err.message });
      this.emit('pm:changed');
    }
  }

  async _checkCompletions(id) {
    const pm = this.pms.get(id);
    if (!pm || !pm.enabled || !pm.completionConditions?.length) return;

    const prefix = `pm:${pm.name}`;
    const activeTasks = [...this.taskQueue.tasks.values()]
      .filter(t => (t.status === 'queued' || t.status === 'dispatched') && t.source === prefix && t.sourceKey);

    for (const task of activeTasks) {
      try {
        const reason = await this._evaluateCompletion(pm, task);
        if (reason) {
          if (task.status === 'dispatched') {
            this.taskQueue.completeTask(task.id, `Auto-completed: ${reason}`);
          } else {
            // Queued tasks can't use completeTask (requires dispatched), mark directly
            task.status = 'completed';
            task.completedAt = Date.now();
            task.result = `Auto-completed: ${reason}`;
            this.taskQueue.emit('task:completed', task);
          }
          this.taskQueue.pushFeed('task', task.assignedTo,
            `PM "${pm.name}" auto-completed task: ${reason}`);
        }
      } catch (err) {
        log.error(`[pm] Completion check error for task ${task.id}:`, err.message);
      }
    }
  }

  async _evaluateCompletion(pm, task) {
    for (const cond of pm.completionConditions) {
      try {
        if (cond.type === 'github-pr-state') {
          const prInfo = this._parsePRFromKey(task.sourceKey);
          if (!prInfo) continue;
          const url = `https://api.github.com/repos/${prInfo.repo}/pulls/${prInfo.prNumber}`;
          const pr = await this._httpRequest(url, this._githubHeaders());
          if (cond.states.includes('merged') && pr.merged) {
            return `PR #${prInfo.prNumber} merged`;
          }
          if (cond.states.includes('closed') && pr.state === 'closed' && !pr.merged) {
            return `PR #${prInfo.prNumber} closed`;
          }
        } else if (cond.type === 'jira-status') {
          const baseUrl = process.env.JIRA_BASE_URL;
          const email = process.env.JIRA_EMAIL;
          const apiToken = process.env.JIRA_API_TOKEN;
          if (!baseUrl || !email || !apiToken) continue;
          const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
          const url = `${baseUrl}/rest/api/3/issue/${task.sourceKey}?fields=status`;
          const issue = await this._httpRequest(url, {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
          });
          const statusName = issue.fields?.status?.name;
          if (statusName && cond.statuses.some(s => s.toLowerCase() === statusName.toLowerCase())) {
            return `${task.sourceKey} status: ${statusName}`;
          }
        }
      } catch (err) {
        log.error(`[pm] Completion eval error (${cond.type}) for ${task.sourceKey}:`, err.message);
      }
    }
    return null;
  }

  async _checkContinueConditions(id) {
    const pm = this.pms.get(id);
    if (!pm || !pm.enabled || !pm.continueConditions?.length) return;

    const fleet = require('./fleet');
    const relay = require('./relay');
    const prefix = `pm:${pm.name}`;
    const now = Date.now();

    // Find dispatched tasks from this PM that have a sourceKey
    const activeTasks = [...this.taskQueue.tasks.values()]
      .filter(t => t.status === 'dispatched'
        && t.source === prefix
        && t.sourceKey
        && t.assignedTo);

    if (!activeTasks.length) return;
    if (!this._lastContinueCheck) this._lastContinueCheck = new Map();

    // Get fleet status once for all tasks
    const sessions = await fleet.getFleetStatus(this.taskQueue.config, this.taskQueue.router);
    const idleSet = new Set(sessions.filter(s => s.state === 'idle').map(s => s.num));

    for (const task of activeTasks) {
      // Only nudge idle sessions — don't interrupt active work
      if (!idleSet.has(task.assignedTo)) continue;

      // Debounce: skip if checked within last 5 minutes
      const lastCheck = this._lastContinueCheck.get(task.sourceKey);
      if (lastCheck && (now - lastCheck) < 5 * 60 * 1000) continue;
      this._lastContinueCheck.set(task.sourceKey, now);

      // Check since last continue nudge, or since dispatch
      const checkSince = task._lastContinueAt || task.dispatchedAt || task.createdAt;

      try {
        const reason = await this._evaluateContinue(pm, task, checkSince);
        if (reason) {
          // Send follow-up message to the session
          const found = await fleet.findSession(this.taskQueue.config, this.taskQueue.router, task.assignedTo);
          if (found) {
            const node = this.taskQueue.router.getNode(found.nodeId);
            const message = `New activity on ${task.sourceKey}:\n\n${reason}\n\nReview these changes and continue your work.`;
            const result = await relay.tell(this.taskQueue.config, node, found.name, message, { vimMode: this.taskQueue.vimMode });
            if (result.success) {
              task._lastContinueAt = now;
              task.lastActivityAt = now;
              this.taskQueue.pushFeed('task', task.assignedTo,
                `PM "${pm.name}" nudged S:${task.assignedTo}: ${reason}`);
              log.info(`[pm] Continue nudge sent to S:${task.assignedTo} for ${task.sourceKey}: ${reason}`);
            } else {
              log.error(`[pm] Continue nudge failed for S:${task.assignedTo}: ${result.error}`);
            }
          }
          this._save();
          this.emit('pm:changed');
        }
      } catch (err) {
        log.error(`[pm] Continue check error for task ${task.id}:`, err.message);
      }
    }
  }

  async _evaluateContinue(pm, task, since) {
    const sinceDate = new Date(since);
    const sinceISO = sinceDate.toISOString();

    for (const cond of pm.continueConditions) {
      try {
        if (cond.type === 'github-pr-changes') {
          const prInfo = this._parsePRFromKey(task.sourceKey);
          if (!prInfo) continue;
          // Check for new commits since last check
          const commitsUrl = `https://api.github.com/repos/${prInfo.repo}/pulls/${prInfo.prNumber}/commits?per_page=100`;
          const commits = await this._httpRequest(commitsUrl, this._githubHeaders());
          const newCommits = Array.isArray(commits)
            ? commits.filter(c => c.commit?.committer?.date && new Date(c.commit.committer.date) > sinceDate)
            : [];
          // Check for new comments (inline review + issue comments)
          const reviewsUrl = `https://api.github.com/repos/${prInfo.repo}/pulls/${prInfo.prNumber}/comments?since=${sinceISO}&per_page=100`;
          const issueCommentsUrl = `https://api.github.com/repos/${prInfo.repo}/issues/${prInfo.prNumber}/comments?since=${sinceISO}&per_page=100`;
          const [reviewComments, issueComments] = await Promise.all([
            this._httpRequest(reviewsUrl, this._githubHeaders()),
            this._httpRequest(issueCommentsUrl, this._githubHeaders()),
          ]);
          const allComments = [
            ...(Array.isArray(reviewComments) ? reviewComments : []),
            ...(Array.isArray(issueComments) ? issueComments : []),
          ];
          const newComments = allComments.filter(c => {
            const created = new Date(c.created_at || c.updated_at);
            if (created <= sinceDate) return false;
            // Ignore hive's own comments and bot users
            if (c.body && c.body.startsWith('🐝')) return false;
            const login = (c.user && c.user.login) || '';
            if (login.endsWith('[bot]') || c.user?.type === 'Bot') return false;
            if (this._githubLogin && login === this._githubLogin) return false;
            return true;
          });
          if (newCommits.length || newComments.length) {
            const parts = [];
            if (newCommits.length) {
              parts.push(`${newCommits.length} new commit(s):`);
              for (const c of newCommits.slice(0, 5)) {
                const sha = (c.sha || '').slice(0, 7);
                const msg = c.commit?.message?.split('\n')[0] || '';
                parts.push(`  ${sha} ${msg}`);
              }
            }
            if (newComments.length) {
              parts.push(`${newComments.length} new comment(s):`);
              for (const c of newComments.slice(0, 5)) {
                const author = c.user?.login || 'unknown';
                const body = (c.body || '').slice(0, 200);
                const file = c.path ? ` on ${c.path}` : '';
                parts.push(`  @${author}${file}: ${body}`);
              }
            }
            return parts.join('\n');
          }
        } else if (cond.type === 'jira-status') {
          const baseUrl = process.env.JIRA_BASE_URL;
          const email = process.env.JIRA_EMAIL;
          const apiToken = process.env.JIRA_API_TOKEN;
          if (!baseUrl || !email || !apiToken) continue;
          const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
          const url = `${baseUrl}/rest/api/3/issue/${task.sourceKey}?fields=status`;
          const issue = await this._httpRequest(url, {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
          });
          const statusName = issue.fields?.status?.name;
          if (statusName && cond.statuses.some(s => s.toLowerCase() === statusName.toLowerCase())) {
            return `${task.sourceKey} status changed to: ${statusName}`;
          }
        }
      } catch (err) {
        log.error(`[pm] Continue eval error (${cond.type}) for ${task.sourceKey}:`, err.message);
      }
    }
    return null;
  }

  _evaluateComplexity(issue, threshold) {
    const storyPoints = issue.storyPoints;
    const issueType = (issue.issueType || '').toLowerCase();

    if (storyPoints != null && storyPoints !== '') {
      const points = Number(storyPoints);
      return points <= threshold ? 'auto' : 'manual';
    }

    // No story points — decide by issue type
    const autoTypes = ['bug', 'task', 'sub-task', 'subtask', 'pr', 'issue', 'ticket'];
    if (autoTypes.includes(issueType)) return 'auto';
    return 'manual'; // Story, Epic, etc.
  }

  _exec(script, options) {
    return new Promise((resolve, reject) => {
      exec(script, options, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve((stdout || '').trim());
      });
    });
  }

  _save() {
    this.taskQueue._saveState();
  }

  stopAll() {
    for (const id of this.timers.keys()) {
      this._stopPolling(id);
    }
  }
}

// Mix in source fetchers, HTTP layer, and helpers from pm-sources.js
Object.assign(ProjectManager.prototype, pmSources);

module.exports = ProjectManager;
