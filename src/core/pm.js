const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const cron = require('node-cron');
const log = require('./log');

const MAX_MEMORY = 100;
const MAX_LEARNING_LENGTH = 500;

const MCP_INSTRUCTIONS = `
## Hive Integration

You have hive MCP tools available. Use them:

1. **Start**: Call \`hive_get_task\` to see your full assignment before doing anything.
2. **Progress updates**: Call \`hive_post_update\` at key milestones — when you have a plan, when implementation is done, or if you hit a blocker.
3. **Plan sharing**: When you create or update a plan file, call \`hive_set_context\` with \`{ "plan": "/absolute/path/to/plan.md" }\` so the dashboard can display it. Also set \`"pr"\` or \`"jira"\` keys if relevant.
4. **Coordination**: If your task mentions other sessions or dependencies, call \`hive_get_sessions\` to check their status.
5. **Finish**: Do NOT call \`hive_complete_task\` unless the task instructions explicitly tell you to. The task owner will close it manually or it will close when you go idle.
6. **Learnings**: If learning mode is active, call \`hive_report_learnings\` with insights you discovered — patterns, root causes, or tips for similar tasks.
`.trim();

let nextPmId = 1;

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
    const existing = new Set(pm.memory);
    let added = 0;
    for (const learning of learnings) {
      if (typeof learning !== 'string' || !learning.trim()) continue;
      const text = learning.trim().slice(0, MAX_LEARNING_LENGTH);
      if (existing.has(text)) continue;
      pm.memory.push(text);
      existing.add(text);
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
        memory: Array.isArray(data.memory) ? data.memory.filter(m => typeof m === 'string' && m.trim()).slice(-MAX_MEMORY) : [],
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
            t.meta && t.meta.source === `pm:${pm.name}` &&
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

  // ── Source integrations ─────────────────────────────

  async _fetchJira(source) {
    const baseUrl = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const apiToken = process.env.JIRA_API_TOKEN;

    if (!baseUrl || !email || !apiToken) {
      throw new Error('JIRA credentials not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
    }

    const jql = source.jql || '';
    const fields = ['summary', 'issuetype', 'customfield_10016', 'priority', 'labels'];
    const urlStr = `${baseUrl}/rest/api/3/search/jql`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const data = await this._httpRequest(urlStr, {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }, JSON.stringify({ jql, fields, maxResults: 50 }));
    return (data.issues || []).map(i => ({
      key: i.key,
      summary: i.fields.summary,
      issueType: i.fields.issuetype ? i.fields.issuetype.name : '',
      storyPoints: i.fields.customfield_10016,
    }));
  }

  _githubHeaders() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN not configured');
    return { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'hive-pm' };
  }

  async _resolveGithubLogin() {
    try {
      const data = await this._httpRequest('https://api.github.com/user', this._githubHeaders());
      if (data && data.login) {
        this._githubLogin = data.login;
        log.info(`[pm] GitHub token belongs to @${data.login}`);
      }
    } catch (err) {
      log.error('[pm] Could not resolve GitHub login:', err.message);
    }
  }

  async _fetchGithubIssues(source) {
    if (!source.repo) throw new Error('GitHub repo not configured');
    const params = new URLSearchParams({ per_page: '50' });
    if (source.labels) params.set('labels', source.labels);
    if (source.state) params.set('state', source.state);
    const urlStr = `https://api.github.com/repos/${source.repo}/issues?${params}`;

    const data = await this._httpRequest(urlStr, this._githubHeaders());
    const authorFilter = source.author ? source.author.toLowerCase() : null;
    const excludeSet = source.excludeLabels
      ? new Set(source.excludeLabels.split(',').map(l => l.trim().toLowerCase()).filter(Boolean))
      : null;
    return (Array.isArray(data) ? data : [])
      .filter(i => !i.pull_request) // exclude PRs from issues endpoint
      .filter(i => !authorFilter || (i.user && i.user.login.toLowerCase() === authorFilter))
      .filter(i => !excludeSet || !i.labels.some(l => excludeSet.has(l.name.toLowerCase())))
      .map(i => ({
        key: `${source.repo}#${i.number}`,
        summary: i.title,
        issueType: 'issue',
        storyPoints: null,
      }));
  }

  async _fetchGithubPrs(source) {
    if (!source.repo) throw new Error('GitHub repo not configured');

    const hasLabels = source.labels && source.labels.trim();
    const hasExcludeLabels = source.excludeLabels && source.excludeLabels.trim();

    // When labels are specified, use the Search API (Pulls API ignores labels param).
    // Search API supports labels, base, author, and state natively.
    if (hasLabels || hasExcludeLabels) {
      return this._fetchGithubPrsViaSearch(source);
    }

    // No label filters — use the Pulls API (faster, no rate limit concerns)
    const allowedBases = source.base
      ? source.base.split(',').map(b => b.trim()).filter(Boolean)
      : ['main', 'master'];

    const allPrs = [];
    for (const base of allowedBases) {
      const params = new URLSearchParams({ per_page: '50', base });
      if (source.state) params.set('state', source.state);
      const urlStr = `https://api.github.com/repos/${source.repo}/pulls?${params}`;
      const data = await this._httpRequest(urlStr, this._githubHeaders());
      if (Array.isArray(data)) allPrs.push(...data);
    }

    const baseSet = new Set(allowedBases);
    const authorFilter = source.author ? source.author.toLowerCase() : null;
    return allPrs
      .filter(pr => baseSet.has(pr.base && pr.base.ref) && !pr.draft)
      .filter(pr => !authorFilter || (pr.user && pr.user.login.toLowerCase() === authorFilter))
      .map(pr => ({
        key: `${source.repo}#${pr.number}`,
        summary: pr.title,
        issueType: 'pr',
        storyPoints: null,
      }));
  }

  async _fetchGithubPrsViaSearch(source) {
    // Build GitHub Search query: is:pr + repo + state + labels + excludeLabels + base + author
    const parts = ['is:pr', `repo:${source.repo}`];
    if (source.state && source.state !== 'all') parts.push(`is:${source.state}`);
    if (source.labels) {
      for (const l of source.labels.split(',').map(s => s.trim()).filter(Boolean)) {
        parts.push(`label:${l}`);
      }
    }
    if (source.excludeLabels) {
      for (const l of source.excludeLabels.split(',').map(s => s.trim()).filter(Boolean)) {
        parts.push(`-label:${l}`);
      }
    }
    if (source.base) parts.push(`base:${source.base}`);
    if (source.author) parts.push(`author:${source.author}`);
    parts.push('-is:draft');

    const q = parts.join(' ');
    const params = new URLSearchParams({ q, per_page: '50', sort: 'created', order: 'desc' });
    const urlStr = `https://api.github.com/search/issues?${params}`;
    const data = await this._httpRequest(urlStr, this._githubHeaders());
    const items = data && data.items ? data.items : [];

    return items.map(item => ({
      key: `${source.repo}#${item.number}`,
      summary: item.title,
      issueType: 'pr',
      storyPoints: null,
    }));
  }

  async _fetchJenkins(source) {
    const baseUrl = process.env.JENKINS_URL;
    const user = process.env.JENKINS_USER;
    const token = process.env.JENKINS_API_TOKEN;
    if (!baseUrl || !user || !token) throw new Error('Jenkins credentials not configured (JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN)');
    if (!source.jobPath) throw new Error('Jenkins job path not configured');

    const urlStr = `${baseUrl}/job/${source.jobPath}/api/json?tree=builds[number,result,timestamp,url]{0,20}`;
    const auth = Buffer.from(`${user}:${token}`).toString('base64');

    const data = await this._httpRequest(urlStr, {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
    });
    return (data.builds || [])
      .filter(b => b.result === 'FAILURE')
      .map(b => ({
        key: `jenkins-${b.number}`,
        summary: `Build #${b.number} failed — ${source.jobPath}`,
        issueType: 'bug',
        storyPoints: null,
      }));
  }

  async _refreshZohoToken() {
    const clientId = process.env.ZOHO_DESK_CLIENT_ID;
    const clientSecret = process.env.ZOHO_DESK_CLIENT_SECRET;
    const refreshToken = process.env.ZOHO_DESK_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Zoho OAuth refresh credentials not configured (ZOHO_DESK_CLIENT_ID, ZOHO_DESK_CLIENT_SECRET, ZOHO_DESK_REFRESH_TOKEN)');
    }
    const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Zoho token refresh failed: ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error('Zoho token refresh returned no access_token');
    this._zohoAccessToken = data.access_token;
    this._zohoTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000; // refresh 1 min early
    return this._zohoAccessToken;
  }

  async _getZohoToken() {
    // Return cached token if still valid
    if (this._zohoAccessToken && this._zohoTokenExpiry && Date.now() < this._zohoTokenExpiry) {
      return this._zohoAccessToken;
    }
    // Fall back to static token if set
    if (process.env.ZOHO_DESK_API_TOKEN) return process.env.ZOHO_DESK_API_TOKEN;
    return this._refreshZohoToken();
  }

  async _fetchZoho(source) {
    const orgId = process.env.ZOHO_DESK_ORG_ID;
    if (!orgId) throw new Error('ZOHO_DESK_ORG_ID not configured');
    const token = await this._getZohoToken();

    let urlStr;
    if (source.query) {
      const params = new URLSearchParams({ searchStr: source.query, limit: '50' });
      if (source.department) params.set('departmentId', source.department);
      if (source.status) params.set('status', source.status);
      urlStr = `https://desk.zoho.com/api/v1/tickets/search?${params}`;
    } else {
      const params = new URLSearchParams({ limit: '50' });
      if (source.department) params.set('departmentId', source.department);
      if (source.status) params.set('status', source.status);
      urlStr = `https://desk.zoho.com/api/v1/tickets?${params}`;
    }

    const data = await this._httpRequest(urlStr, {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'orgId': orgId,
      'Accept': 'application/json',
    });
    const tickets = data.data || data || [];
    const since = source.since ? new Date(source.since).getTime() : 0;
    return (Array.isArray(tickets) ? tickets : [])
      .filter(t => {
        if (!since) return true;
        const created = new Date(t.createdTime).getTime();
        return created >= since;
      })
      .map(t => ({
        key: `zoho-${t.ticketNumber || t.id}`,
        summary: t.subject || t.description || '',
        issueType: 'ticket',
        storyPoints: null,
      }));
  }

  async _fetchReReviews(source, pmId) {
    if (!source.repo) throw new Error('GitHub repo not configured');
    if (!source.reviewer) throw new Error('Reviewer username not configured');

    const triggers = (source.triggerPhrases || 'ready for review,ptal,please review,addressed')
      .split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (triggers.length === 0) throw new Error('No trigger phrases configured');

    const headers = this._githubHeaders();

    // 1. Fetch open PRs (100 max — GitHub API limit per page)
    const prsUrl = `https://api.github.com/repos/${source.repo}/pulls?state=open&per_page=100`;
    const prs = await this._httpRequest(prsUrl, headers);
    if (!Array.isArray(prs)) return [];

    const results = [];
    const reviewer = source.reviewer.toLowerCase();

    for (const pr of prs) {
      if (pr.draft) continue;
      // Skip PRs not updated since this PM's last poll (2 min buffer for clock/propagation lag)
      if (!this._reReviewPollTimes) this._reReviewPollTimes = {};
      const lastPoll = this._reReviewPollTimes[pmId];
      if (lastPoll && new Date(pr.updated_at).getTime() < lastPoll - 120000) continue;

      // 2. Fetch recent issue comments (last 48h) and check for trigger phrases
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const commentsUrl = `https://api.github.com/repos/${source.repo}/issues/${pr.number}/comments?since=${since}&per_page=100`;
      let comments;
      try { comments = await this._httpRequest(commentsUrl, headers); } catch (e) { continue; }
      if (!Array.isArray(comments)) continue;

      for (const comment of comments) {
        // Skip bot comments (hive 🐝 prefix, GitHub [bot] users, and HTML/markdown-heavy bot posts)
        if (comment.body && comment.body.startsWith('🐝')) continue;
        const login = (comment.user && comment.user.login) || '';
        if (login.endsWith('[bot]') || comment.user?.type === 'Bot') continue;

        const rawBody = comment.body || '';
        if (rawBody.length > 500) continue; // Skip long bot summaries / auto-generated comments
        const body = rawBody.toLowerCase();
        if (!triggers.some(t => body.includes(t))) continue;

        // If there's already a queued/dispatched task, flag it for "already queued" reply
        if (this._hasActiveTaskForPR(source.repo, pr.number)) {
          results.push({
            key: `re-review-${source.repo}#${pr.number}-${comment.id}`,
            summary: `Re-review PR #${pr.number}: ${pr.title}`,
            issueType: 'pr',
            storyPoints: null,
            _alreadyQueued: true,
            _repo: source.repo,
            _prNumber: pr.number,
          });
          continue;
        }

        results.push({
          key: `re-review-${source.repo}#${pr.number}-${comment.id}`,
          summary: `Re-review PR #${pr.number}: ${pr.title}`,
          issueType: 'pr',
          storyPoints: null,
          _repo: source.repo,
          _prNumber: pr.number,
        });
      }
    }

    if (!this._reReviewPollTimes) this._reReviewPollTimes = {};
    this._reReviewPollTimes[pmId] = Date.now();
    return results;
  }

  _hasActiveTaskForPR(repo, number) {
    const pattern = `${repo}#${number}`;
    for (const task of this.taskQueue.tasks.values()) {
      if ((task.status === 'queued' || task.status === 'dispatched') && task.text.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  _httpMethod(method, urlStr, headers, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const mod = url.protocol === 'https:' ? https : http;
      const data = body ? JSON.stringify(body) : '';
      const reqHeaders = { ...headers, 'Content-Type': 'application/json' };
      if (data) reqHeaders['Content-Length'] = Buffer.byteLength(data);
      const req = mod.request(urlStr, {
        method,
        headers: reqHeaders,
        timeout: 15000,
      }, (res) => {
        let resBody = '';
        res.on('data', (chunk) => resBody += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(resBody)); } catch { resolve(resBody); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${resBody.slice(0, 200)}`));
          }
        });
      });
      req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      if (data) req.write(data);
      req.end();
    });
  }

  _httpPost(urlStr, headers, body) {
    return this._httpMethod('POST', urlStr, headers, body);
  }

  async _commentOnPR(repo, prNumber, body) {
    const headers = this._githubHeaders();
    const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
    await this._httpPost(url, headers, { body });
  }

  _parsePRFromKey(key) {
    // re-review-org/repo#123-commentId
    let m = key.match(/^re-review-(.+?)#(\d+)/);
    if (m) return { repo: m[1], prNumber: parseInt(m[2]) };
    // org/repo#123
    m = key.match(/^(.+?)#(\d+)/);
    if (m) return { repo: m[1], prNumber: parseInt(m[2]) };
    return null;
  }

  _httpRequest(urlStr, headers, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const mod = url.protocol === 'https:' ? https : http;

      const options = {
        method: body ? 'POST' : 'GET',
        headers: { ...headers },
        timeout: 15000,
      };

      const req = mod.request(urlStr, options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON response: ${e.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      if (body) req.write(body);
      req.end();
    });
  }

  // ── Checklist seeding ───────────────────────────────

  _seedChecklist(pm, task) {
    if (!pm.checklistTemplate || !task) return;
    const tpl = this.taskQueue.checklistTemplates.get(pm.checklistTemplate);
    if (!tpl || !tpl.items || !tpl.items.length) return;
    const checklist = tpl.items.map(text => ({
      id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      checked: false,
    }));
    task.checklist = checklist;
    this.taskQueue.emit('task:updated', task);
    this.taskQueue._saveState();
  }

  // ── Helpers ─────────────────────────────────────────

  /**
   * Enrich task text with PM instructions, MCP, and learnings at dispatch time.
   * Called by taskqueue._dispatchTask.
   */
  enrichTaskText(task) {
    if (!task.source || !task.source.startsWith('pm:')) return task.text;
    const pmName = task.source.replace('pm:', '');
    const pm = [...this.pms.values()].find(p => p.name === pmName);
    if (!pm) return task.text;
    return this._buildFullText(pm, task.text);
  }

  _buildFullText(pm, text) {
    let result = text;
    if (pm.instructions) result += `\n\nInstructions: ${pm.instructions}`;
    if (pm.mcpEnabled) result += `\n\n${MCP_INSTRUCTIONS}`;
    if (pm.learningEnabled && pm.learningPrompt) {
      result += '\n\n## Learning\n\n';
      result += 'After completing this task, call `hive_report_learnings` with what you discovered.\n\n';
      result += 'Focus on: ' + pm.learningPrompt + '\n';
      const mem = pm.memory ? pm.memory.slice() : [];
      if (mem.length > 0) {
        result += "\nAlready known (don't repeat these):\n";
        result += mem.map(m => `- ${m}`).join('\n');
      }
    }
    return result;
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

module.exports = ProjectManager;
