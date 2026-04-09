const EventEmitter = require('events');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const log = require('./log');
const sessionManager = require('./session-manager');
const pmSources = require('./pm-sources');

const KB_FILE = path.join(process.cwd(), '.hive-knowledge.json');

const MAX_MEMORY = 100;
const MAX_LEARNING_LENGTH = 500;
const MAX_KB_ENTRIES = 500;
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
    this.knowledgeBase = []; // shared cross-PM learnings: [{ text, files[], sourcePm, createdAt }]
    this._loadKnowledgeBase();
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
      pollInterval: cfg.pollInterval || 300000,
      schedule: cfg.schedule || null,
      taskFormat: cfg.taskFormat || null,
      checklistTemplate: cfg.checklistTemplate || null,
      mcpEnabled: cfg.mcpEnabled || false,
      learningEnabled: cfg.learningEnabled || false,
      learningPrompt: cfg.learningPrompt || '',
      memory: [],
      completionConditions: cfg.completionConditions || [],
      continueConditions: cfg.continueConditions || [],
      slackUserId: cfg.slackUserId || null, // Slack user ID for PM status reporting
      actions: cfg.actions || null, // allowed context action IDs (null = all)
      boardStates: cfg.boardStates || null, // per-PM work state overrides: [{ stateId, autoOnStatus }]
      autoCreate: cfg.autoCreate || false, // when true, auto-create sessions for this PM's queued tasks
      primaryAction: cfg.primaryAction || { enabled: false }, // { enabled: bool } — opt-in "Open PR/Issue/Thread" button on task cards
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
    // Emit rescan event so external bots (GitHub, etc.) can react
    this.emit('pm:rescan', pm);
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

  // ── Knowledge Base (shared cross-PM) ─────────────────

  /**
   * Add a structured knowledge entry to the shared knowledge base.
   */
  addKnowledge(entry) {
    // Dedup by insight text
    const kbTexts = this.knowledgeBase.map(e => e.insight);
    if (_isDuplicate(entry.insight, kbTexts)) return false;
    this.knowledgeBase.push(entry);
    if (this.knowledgeBase.length > MAX_KB_ENTRIES) {
      this.knowledgeBase = this.knowledgeBase.slice(-MAX_KB_ENTRIES);
    }
    this._saveKnowledgeBase();
    return true;
  }

  /**
   * Query the knowledge base.
   * Matches by domain (exact), file paths (basename), and keyword overlap.
   */
  queryKnowledge(queryText, { files, domain, limit = 20 } = {}) {
    if (!this.knowledgeBase.length) return [];
    const queryFiles = Array.isArray(files) ? files : [];
    const queryDomain = (domain || '').toLowerCase();
    const queryWords = queryText
      ? new Set(queryText.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3))
      : new Set();

    // If no filters at all, return nothing (don't dump the whole KB)
    if (!queryWords.size && !queryFiles.length && !queryDomain) return [];

    const scored = [];
    for (const entry of this.knowledgeBase) {
      let score = 0;

      // Domain match: strong signal
      if (queryDomain && entry.domain === queryDomain) score += 20;

      // File match
      if (queryFiles.length && entry.files && entry.files.length) {
        for (const ef of entry.files) {
          const efBase = ef.split('/').pop();
          for (const qf of queryFiles) {
            if (ef === qf) score += 10;
            else if (qf.split('/').pop() === efBase) score += 5;
          }
        }
      }

      // Keyword overlap on insight text
      if (queryWords.size) {
        const entryWords = entry.insight.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
        for (const w of entryWords) {
          if (queryWords.has(w)) score += 1;
        }
      }

      if (score > 0) scored.push({ ...entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    // Strip internal score from results
    return scored.slice(0, limit).map(({ score, ...rest }) => rest);
  }

  // ── Export ─────────────────────────────────────────

  exportPM(id, skillPaths) {
    const pm = this.pms.get(id);
    if (!pm) return null;

    // Build clean PM config (strip runtime and local-only fields)
    const exportConfig = {
      name: pm.name,
      source: pm.source,
      designation: pm.designation,
      instructions: pm.instructions,
      autoThreshold: pm.autoThreshold,
      pollInterval: pm.pollInterval,
      schedule: pm.schedule,
      taskFormat: pm.taskFormat,
      checklistTemplate: pm.checklistTemplate,
      mcpEnabled: pm.mcpEnabled,
      learningEnabled: pm.learningEnabled,
      learningPrompt: pm.learningPrompt,
      completionConditions: pm.completionConditions,
      continueConditions: pm.continueConditions,
      slackUserId: pm.slackUserId,
      boardStates: pm.boardStates,
      actions: pm.actions,
      autoCreate: pm.autoCreate,
      memory: pm.memory || [],
    };

    // Get linked designation def
    let designationDef = null;
    if (pm.designation) {
      designationDef = this.taskQueue.designationDefs.get(pm.designation) || null;
    }

    // Read agent file contents
    const agentFiles = [];
    if (designationDef && designationDef.agentFiles) {
      for (const filePath of designationDef.agentFiles) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const name = path.basename(filePath);
          agentFiles.push({ name, path: filePath, content });
        } catch {
          agentFiles.push({ name: path.basename(filePath), path: filePath, content: null });
        }
      }
    }

    // Read selected skill contents
    const skills = [];
    if (Array.isArray(skillPaths)) {
      for (const skillPath of skillPaths) {
        try {
          const content = fs.readFileSync(skillPath, 'utf8');
          const name = path.basename(path.dirname(skillPath));
          skills.push({ name, content });
        } catch {
          // skip unreadable skills
        }
      }
    }

    // Build the prompt
    return this._buildExportPrompt(exportConfig, designationDef, agentFiles, skills);
  }

  _buildExportPrompt(config, designationDef, agentFiles, skills) {
    const sections = [];
    let sectionNum = 0;
    const hasAgentFiles = agentFiles.length > 0;
    const hasDesignation = !!designationDef;

    // Extract instructions from config — include directly in pm:create config
    const instructions = config.instructions || '';
    const configForJson = { ...config };
    if (instructions) {
      configForJson.instructions = '(see Instructions section below — set this field in the pm:create/pm:update call)';
    }

    // Preamble with API reference
    sections.push(`I need you to set up a Project Manager in hive. Follow the sections below — skip any that don't apply.

**Important:** Before creating anything, check if a PM with the same name or a designation with the same name already exists. If so, update the existing one instead of creating a duplicate.

**Hive WebSocket API:**
Connect to the hive WebSocket server (check \`WEB_PORT\` in the hive \`.env\` for the port, default is 3000). Authenticate first: send \`{ "type": "auth", "token": "<WEB_TOKEN from .env>" }\`, wait for \`{ "type": "auth", "ok": true }\`.

| Action | Send | Response |
|--------|------|----------|
| List PMs | \`{ "type": "pm:list" }\` | \`{ "type": "pm:list", "pms": [...] }\` |
| Create PM | \`{ "type": "pm:create", "config": { ... } }\` | \`{ "type": "pm:created", "pm": { ... } }\` + broadcast \`pm:list\` |
| Update PM | \`{ "type": "pm:update", "id": "<id>", "updates": { ... } }\` | broadcast \`pm:list\` |
| List designations | \`{ "type": "designationDefs:get" }\` | \`{ "type": "designationDefs:list", "defs": [...] }\` |
| Set designation | \`{ "type": "designationDef:set", "name": "...", ... }\` | broadcast \`designationDefs:list\` |
| Get agent roots | \`{ "type": "agentRoots:get" }\` | \`{ "type": "agentRoots:list", "roots": [...] }\` |

PMs are created disabled by default — no need to set \`enabled: false\`.`);

    // Agent files (only if there are any)
    if (hasAgentFiles) {
      sectionNum++;
      let agentSection = `## ${sectionNum}. Agent Files\n\nWrite the following agent file(s) to the first available agent root directory (query \`agentRoots:get\` to find it). If no agent roots are configured, ask the user where to save them.\n`;
      for (const af of agentFiles) {
        if (af.content) {
          agentSection += `\n### ${af.name}\n\n\`\`\`markdown\n${af.content}\n\`\`\`\n`;
        } else {
          agentSection += `\n### ${af.name}\n\n*(File content was not available at export time — ask the user to provide it)*\n`;
        }
      }
      sections.push(agentSection);
    }

    // Designation (only if there is one)
    if (hasDesignation) {
      sectionNum++;
      const defExport = {
        name: designationDef.name,
        description: designationDef.description || '',
        color: designationDef.color || 'orange',
      };
      if (hasAgentFiles) {
        defExport.agentFiles = agentFiles.map(f => f.name);
      }
      let desigNote = '';
      if (hasAgentFiles) {
        desigNote = `\n\nNote: The \`agentFiles\` values above are filenames — after writing them to the agent root, use their full absolute paths when sending the \`designationDef:set\` message.`;
      }
      sections.push(`## ${sectionNum}. Designation\n\nCreate or update via \`designationDef:set\`:\n\n\`\`\`json\n${JSON.stringify(defExport, null, 2)}\n\`\`\`${desigNote}`);
    }

    // PM config
    sectionNum++;
    // Build notes about fields that may need adjustment
    const envNotes = [];
    if (config.source && config.source.repo) envNotes.push(`\`source.repo\` ("${config.source.repo}") — verify this repo is accessible from the target environment`);
    if (config.source && config.source.jql) envNotes.push(`\`source.jql\` — verify this JQL query works in the target JIRA instance`);
    if (config.checklistTemplate) envNotes.push(`\`checklistTemplate\` ("${config.checklistTemplate}") — this template must exist on the target hive`);
    if (config.boardStates) envNotes.push(`\`boardStates\` — these work state IDs must exist on the target hive`);
    const envWarning = envNotes.length > 0
      ? `\n\n**Review before importing** — these fields may need adjustment for the target environment:\n${envNotes.map(n => '- ' + n).join('\n')}`
      : '';
    sections.push(`## ${sectionNum}. PM Configuration\n\nCreate or update a PM named "${config.name}" via \`pm:create\` (with \`config\` field) or \`pm:update\` (with \`id\` and \`updates\` fields):\n\n\`\`\`json\n${JSON.stringify(configForJson, null, 2)}\n\`\`\`${envWarning}`);

    // Instructions as separate section
    if (instructions) {
      sectionNum++;
      sections.push(`## ${sectionNum}. Instructions\n\nSet the PM's \`instructions\` field to the content below. Include this directly in the \`pm:create\` config or \`pm:update\` updates — the WebSocket JSON handles the escaping, so just pass the string value as-is.\n\nFull instructions content:\n\n---\n${instructions}\n---`);
    }

    // Memory note
    if (config.memory && config.memory.length > 0) {
      sectionNum++;
      sections.push(`## ${sectionNum}. PM Learnings\n\nThe PM has ${config.memory.length} learned insight(s) included in the PM configuration above. These are from previous task executions and may contain useful context. **Review them for any sensitive data before sharing.**`);
    }

    // Skills
    if (skills.length > 0) {
      sectionNum++;
      let skillSection = `## ${sectionNum}. Skills Reference\n\nThe following skills are used by this PM's workflow. They are normally loaded via Claude Code skills system. If these skills are not installed on the target system, the content is embedded below for reference:\n`;
      for (const skill of skills) {
        skillSection += `\n### Skill: ${skill.name}\n\n\`\`\`markdown\n${skill.content}\n\`\`\`\n`;
      }
      sections.push(skillSection);
    }

    // Verification spec
    sectionNum++;
    const verifyChecks = [];
    if (hasDesignation) {
      verifyChecks.push(`- Send \`designationDefs:get\` → response \`designationDefs:list\` should contain a def with \`name: "${designationDef.name}"\``);
    }
    verifyChecks.push(`- Send \`pm:list\` → response \`pm:list\` should contain a PM with \`name: "${config.name}"\` and \`enabled: false\``);
    if (instructions) {
      const instrPreview = instructions.slice(0, 80).replace(/\n/g, ' ').trim();
      verifyChecks.push(`- The PM's \`instructions\` field should start with: "${instrPreview}..."`);
    }
    if (hasAgentFiles) {
      for (const af of agentFiles) {
        verifyChecks.push(`- Agent file "${af.name}" exists on disk in an agent root directory`);
      }
    }
    sections.push(`## ${sectionNum}. Verification\n\nAfter setup, verify by querying the API:\n${verifyChecks.join('\n')}`);

    return sections.join('\n\n');
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
        pollInterval: data.pollInterval || 300000,
        schedule: data.schedule || null,
        taskFormat: data.taskFormat || null,
        checklistTemplate: data.checklistTemplate || null,
        mcpEnabled: data.mcpEnabled || false,
        learningEnabled: data.learningEnabled || false,
        learningPrompt: data.learningPrompt || '',
        memory: _deduplicateMemory(Array.isArray(data.memory) ? data.memory.filter(m => typeof m === 'string' && m.trim()) : []),
        completionConditions: Array.isArray(data.completionConditions) ? data.completionConditions : [],
        continueConditions: Array.isArray(data.continueConditions) ? data.continueConditions : [],
        slackUserId: data.slackUserId || null,
        boardStates: Array.isArray(data.boardStates) ? data.boardStates : null,
        actions: Array.isArray(data.actions) ? data.actions : null,
        autoCreate: data.autoCreate || false,
        enabled: data.enabled || false,
        seenKeys: Array.isArray(data.seenKeys) ? data.seenKeys : [],
        tasksCreated: data.tasksCreated || 0,
        lastPoll: data.lastPoll || null,
        lastError: data.lastError || null,
      };
      // Config-only sources don't poll — clear stale poll errors
      if (pm.source.type === 'slack' || pm.source.type === 'github-mentions' || pm.source.type === 'slack-channel-monitor') {
        pm.lastError = null;
      }
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

    // Slack/GitHub mentions source: config-only, no polling (bot reads PM on demand)
    if (pm.source.type === 'slack' || pm.source.type === 'github-mentions' || pm.source.type === 'slack-channel-monitor') {
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
    const mode = pm.targetSession ? 'manual' : 'auto';
    let taskText = text;
    if (pm.taskFormat) {
      taskText = pm.taskFormat.replace('{key}', key).replace('{summary}', text);
    }
    const task = this.taskQueue.createTask(taskText, mode, pm.targetSession || null, pm.designation, { source: `pm:${pm.name}`, requireHumanClose: !!pm.requireHumanClose });
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

    // Find an idle auto-session to dispatch to
    const fleet = require('./fleet');
    const sessions = await fleet.getFleetStatus(
      this.taskQueue.config,
      this.taskQueue.router,
    );
    const idle = sessions.find(
      (s) =>
        s.state === 'idle' &&
        this.taskQueue.autoSessions.has(s.num) &&
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
        { source: `pm:${pm.name}`, requireHumanClose: !!pm.requireHumanClose },
      );
      this._seedChecklist(pm, task);
      pm.tasksCreated++;
      this.taskQueue.pushFeed(
        'task',
        null,
        `PM "${pm.name}" dispatched ${command} to session ${idle.num}`,
      );
    } else {
      const task = this.taskQueue.createTask(command, 'auto', null, pm.designation, { source: `pm:${pm.name}`, requireHumanClose: !!pm.requireHumanClose });
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
    if (pm.source.type === 'slack' || pm.source.type === 'github-mentions' || pm.source.type === 'slack-channel-monitor') return; // config-only, no polling

    try {
      let issues;
      switch (pm.source.type) {
        case 'jira':    issues = await this._fetchJira(pm.source); break;
        case 'github-issues': issues = await this._fetchGithubIssues(pm.source); break;
        case 'github-prs':   issues = await this._fetchGithubPrs(pm.source); break;
        case 'jenkins': issues = await this._fetchJenkins(pm.source); break;
        case 'zoho':    issues = await this._fetchZoho(pm.source); break;
        case 'github-re-reviews': issues = await this._fetchReReviews(pm.source, pm.id); break;
        case 'nectar':  issues = await this._fetchNectar(pm.source); break;
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
        const meta = { source: `pm:${pm.name}`, requireHumanClose: !!pm.requireHumanClose };

        // Claim Nectar task when creating a Hive task for it
        if (pm.source.type === 'nectar' && issue._nectarTask) {
          meta.nectarTaskId = issue._nectarTask.id;
          meta.actionContext = { type: 'nectar-task', taskId: issue._nectarTask.id };
          this._claimNectarTask(pm.source, issue._nectarTask.id).catch(() => {});
        }

        // Attach actionContext for PR-sourced tasks
        if (pm.source.type === 'github-prs' || pm.source.type === 'github-re-reviews') {
          const prMeta = this._parsePRFromKey(issue.key);
          if (prMeta) {
            meta.actionContext = { type: 'github-pr', repo: prMeta.repo, prNumber: prMeta.prNumber };
            meta.pr = prMeta.prNumber;
          }
        }

        // Attach actionContext for issue-sourced tasks (used by Primary Action URL builder)
        if (pm.source.type === 'github-issues') {
          const m = /^(.+)#(\d+)$/.exec(issue.key);
          if (m) meta.actionContext = { type: 'github-issue', repo: m[1], issueNumber: parseInt(m[2], 10) };
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
          // Guard: verify session is actually on this PR's branch before completing
          if (task.assignedTo && pr.head && pr.head.ref) {
            const ctx = this.taskQueue.getSessionContext(task.assignedTo);
            const sessionBranch = ctx.branch;
            if (sessionBranch && sessionBranch !== pr.head.ref) {
              log.warn(`[pm] Skipping completion for task ${task.id}: session S:${task.assignedTo} on branch "${sessionBranch}" but PR #${prInfo.prNumber} is on "${pr.head.ref}"`);
              continue;
            }
          }
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

      // Guard: verify session is actually on the PR's branch before nudging
      const session = sessions.find(s => s.num === task.assignedTo);
      const ctx = this.taskQueue.getSessionContext(task.assignedTo);
      const sessionBranch = ctx.branch || session?.branch;
      if (sessionBranch) {
        const prInfo = this._parsePRFromKey(task.sourceKey);
        if (prInfo) {
          try {
            const prUrl = `https://api.github.com/repos/${prInfo.repo}/pulls/${prInfo.prNumber}`;
            const pr = await this._httpRequest(prUrl, this._githubHeaders());
            if (pr.head?.ref && sessionBranch !== pr.head.ref) {
              log.warn(`[pm] Skipping continue nudge for task ${task.id}: S:${task.assignedTo} on "${sessionBranch}" but PR #${prInfo.prNumber} is on "${pr.head.ref}"`);
              continue;
            }
          } catch {} // if API fails, proceed with nudge
        }
      }

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

  _saveKnowledgeBase() {
    try {
      const json = JSON.stringify(this.knowledgeBase, null, 2);
      const tmpFile = KB_FILE + '.tmp';
      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, KB_FILE);
    } catch (err) {
      log.error('[pm] Failed to save knowledge base:', err.message);
    }
  }

  _loadKnowledgeBase() {
    try {
      const data = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
      if (Array.isArray(data)) {
        this.knowledgeBase = data.slice(-MAX_KB_ENTRIES);
        log.info(`[pm] Loaded ${this.knowledgeBase.length} knowledge base entries`);
      }
    } catch {
      // No KB file yet — that's fine
    }
  }

  // ── Channel Monitor PM session ──────────────────────

  /**
   * Ensure the tmux session for a channel-monitor PM exists with Claude running.
   * Called by bot.js before relaying messages. Idempotent.
   */
  async ensureMonitorSession(pm, config) {
    if (pm.source.type !== 'slack-channel-monitor') return;

    const sessionName = `hive-pm-${pm.id}`;
    const sessionDir = path.join(__dirname, '..', '..'); // hive project root

    const result = await sessionManager.createSession(sessionName, sessionDir, { panes: 1 }, { cols: 80, rows: 50 });
    if (result.created) {
      // Write MCP config so the PM session can use hive tools
      const port = config?.web?.port || process.env.WEB_PORT || 3000;
      const token = process.env.HIVE_TOKEN || process.env.WEB_TOKEN || '';
      const mcpTools = ['hive_get_task', 'hive_create_task', 'hive_get_sessions', 'hive_get_knowledge', 'hive_post_update', 'hive_set_context'];
      sessionManager.writeMcpConfig(sessionDir, `ws://127.0.0.1:${port}`, token, sessionName, mcpTools);

      // Build system prompt
      const systemPrompt = pm.source.systemPrompt || this._defaultMonitorPrompt(pm);

      // Write launch script (avoids shell quoting issues with complex prompts)
      const launchScript = path.join(require('os').tmpdir(), `hive-pm-${pm.id}-launch.sh`);
      fs.writeFileSync(launchScript, [
        '#!/bin/zsh -l',
        "read -r -d '' PROMPT << 'PROMPT_END'",
        systemPrompt,
        'PROMPT_END',
        'claude --dangerously-skip-permissions --append-system-prompt "$PROMPT"',
        '',
      ].join('\n'));
      fs.chmodSync(launchScript, 0o755);

      await sessionManager.startClaude(sessionName, 1, `bash ${launchScript}`);
      log.info(`[pm] Created monitor session "${sessionName}" for PM "${pm.name}"`);

      // Give Claude time to start up
      await new Promise(r => setTimeout(r, 8000));
    } else {
      log.info(`[pm] Monitor session "${sessionName}" already exists`);
    }
  }

  _defaultMonitorPrompt(pm) {
    const channels = (pm.source.channels || []).join(', ');
    return [
      `You are a Slack channel monitor for the hive fleet. Your job is to watch messages from Slack channels and decide if they need engineering action.`,
      ``,
      `You monitor channels: ${channels}`,
      ``,
      `You have access to hive MCP tools. Use them to:`,
      `- hive_get_sessions: See what sessions are currently working on`,
      `- hive_create_task: Create a new task when you identify actionable work`,
      `- hive_get_knowledge: Check if there's existing knowledge about a topic`,
      ``,
      `Rules:`,
      `- Only create tasks for messages that need actual engineering work`,
      `- Check hive_get_sessions first to see if work is already in progress`,
      `- If a message is a follow-up to existing work, do NOT create a new task`,
      `- If unclear whether something is actionable, err on the side of ignoring`,
      `- Never do the work yourself — only triage and route`,
      `- Include full context in task descriptions so workers have what they need`,
      // [context-consolidation] This instruction references the MCP wire params
      // (slackChannel / slackThreadTs) which are STABLE per the plan. The field
      // names Claude sets at the API are NOT the same as the task field names —
      // ws-handlers.js translates them. Phase 2 doesn't need to change this line.
      // Ref: ~/dev/agents/hive/context-consolidation-plan.md
      `- When creating tasks, set the slackChannel and slackThreadTs so replies route back`,
      `- Do NOT set a designation on tasks unless you know the exact designation name. Leave it empty/null so any idle session can pick it up.`,
    ].join('\n');
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
