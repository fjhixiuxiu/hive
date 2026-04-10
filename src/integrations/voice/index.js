'use strict';

const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const MeetingJoiner = require('./meeting');
const TTS = require('./tts');
const StandupReport = require('./standup');
const Transcriber = require('./transcriber');
const sessionManager = require('../../core/session-manager');
const relay = require('../../core/relay');
const log = require('../../core/log');

const VOICE_SESSION = 'hive-voice';
const VOICE_SESSION_DIR = path.join(__dirname, '..', '..', '..');
const MEETINGS_FILE = path.join(__dirname, '..', '..', '..', '.hive-meetings.json');

// Defaults (overridden by config.voice)
const DEFAULTS = {
  systemPrompt: null,       // null = use built-in default
  mcpTools: null,           // null = all hive MCP tools
  ttsVoice: 'aura-orion-en',
  reportOnJoin: true,
  maxDuration: 3600000,     // 1 hour
  silenceGap: 3000,         // ms before sending buffered transcript
  maxMeetings: 50,
};

/**
 * Voice Agent — orchestrates meeting joining, standup reporting,
 * audio capture/playback, transcription, and conversational AI.
 *
 * Brain: a dedicated Claude Code session ("hive-voice") that receives
 * transcripts and decides whether/how to respond. No regex triggers —
 * Claude handles intent detection and natural conversation.
 *
 * Configuration: set config.voice in hive.config.js to override defaults.
 */
class VoiceAgent extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.taskQueue = opts.taskQueue;
    this.watcher = opts.watcher;
    this.router = opts.router;
    this.pmName = opts.pmName || 'Voice Meeting';
    this.knowledgeBase = opts.knowledgeBase;
    this.config = opts.config || {};

    // Merge voice config with defaults
    const vc = { ...DEFAULTS, ...this.config.voice };

    // Sub-components (created on join)
    this.meeting = null;
    this.tts = new TTS({ voice: vc.ttsVoice });
    this.standup = new StandupReport();
    this.transcriber = null;

    // Config (from voice config block)
    this.reportOnJoin = vc.reportOnJoin;
    this.maxDuration = vc.maxDuration;
    this._silenceGap = vc.silenceGap;
    this._maxMeetings = vc.maxMeetings;
    this._customSystemPrompt = vc.systemPrompt;
    this._mcpTools = vc.mcpTools;

    // State
    this.active = false;
    this.joinedAt = null;
    this.meetingUrl = null;
    this.audioBridgeWss = null;
    this.audioBridgeClients = new Set();
    this._maxDurationTimer = null;
    this._speaking = false; // true while TTS is playing
    this._tasksCreated = 0;

    // Transcript buffer for speech-pause detection
    this._transcriptBuffer = [];
    this._silenceTimer = null;
    this._processingTranscript = false;

    // Meeting history
    this._currentMeetingId = null;
    this._currentTranscript = [];
    this._currentResponses = [];
    this.meetings = [];
    this._loadMeetings();
  }

  // ── Meeting history persistence ──────────────────────────

  _loadMeetings() {
    try {
      if (fs.existsSync(MEETINGS_FILE)) {
        this.meetings = JSON.parse(fs.readFileSync(MEETINGS_FILE, 'utf8'));
        log.info(`[voice] Loaded ${this.meetings.length} past meetings`);
      }
    } catch (e) {
      log.warn(`[voice] Failed to load meetings: ${e.message}`);
      this.meetings = [];
    }
  }

  _saveMeetings() {
    try {
      fs.writeFileSync(MEETINGS_FILE, JSON.stringify(this.meetings, null, 2));
    } catch (e) {
      log.warn(`[voice] Failed to save meetings: ${e.message}`);
    }
  }

  _deriveMeetingName(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('zoom')) return 'Zoom Meeting';
      if (u.hostname.includes('meet.google')) return 'Google Meet';
      if (u.hostname.includes('teams')) return 'Teams Meeting';
      return u.hostname;
    } catch { return 'Meeting'; }
  }

  getMeetings() {
    return this.meetings.map(m => ({
      id: m.id,
      name: m.name,
      url: m.url,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      transcriptCount: (m.transcript || []).length,
      responseCount: (m.responses || []).length,
      tasksCreated: m.tasksCreated || 0,
    }));
  }

  getMeeting(id) {
    // Active meeting
    if (this._currentMeetingId === id && this.active) {
      return {
        id,
        name: this._currentMeetingName,
        url: this.meetingUrl,
        startedAt: this.joinedAt,
        endedAt: null,
        transcript: this._currentTranscript,
        responses: this._currentResponses,
        tasksCreated: this._tasksCreated || 0,
        active: true,
      };
    }
    // Past meeting
    return this.meetings.find(m => m.id === id) || null;
  }

  renameMeeting(id, name) {
    if (this._currentMeetingId === id) {
      this._currentMeetingName = name;
      return true;
    }
    const m = this.meetings.find(m => m.id === id);
    if (m) { m.name = name; this._saveMeetings(); return true; }
    return false;
  }

  /**
   * Set up the WebSocket audio bridge endpoint.
   */
  setupAudioBridge(server) {
    this.audioBridgeWss = new WebSocketServer({ noServer: true });

    this.audioBridgeWss.on('connection', (ws) => {
      log.info('[voice] Audio bridge client connected');
      this.audioBridgeClients.add(ws);

      ws.on('message', (data) => {
        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
          this._audioChunksReceived = (this._audioChunksReceived || 0) + 1;
          if (this._audioChunksReceived === 1) log.info(`[voice] First audio chunk received (${data.length || data.byteLength} bytes)`);
          if (this._audioChunksReceived % 100 === 0) log.info(`[voice] Audio chunks received: ${this._audioChunksReceived}`);
          if (this.transcriber) {
            this.transcriber.send(data);
          }
        }
      });

      ws.on('close', () => {
        this.audioBridgeClients.delete(ws);
        log.info('[voice] Audio bridge client disconnected');
      });
    });

    return this.audioBridgeWss;
  }

  /**
   * Public: ensure the hive-voice tmux session exists with Claude running.
   * Called from WS handler for voice:ensure-session so the session
   * can be accessed outside of meetings.
   */
  async ensureSession() { return this._ensureVoiceSession(); }

  async _ensureVoiceSession() {
    if (!await sessionManager.isTmuxAvailable()) {
      throw new Error('tmux not available');
    }

    const result = await sessionManager.createSession(VOICE_SESSION, VOICE_SESSION_DIR, { panes: 1 }, { cols: 80, rows: 50 });
    if (result.created) {
      // Set up hive MCP server so the voice session has fleet tools
      const port = this.config?.web?.port || 3000;
      const token = process.env.HIVE_TOKEN || '';
      sessionManager.writeMcpConfig(
        VOICE_SESSION_DIR,
        `ws://127.0.0.1:${port}`,
        token,
        VOICE_SESSION,
        this._mcpTools, // null = all tools
      );
      log.info(`[voice] MCP config written (tools: ${this._mcpTools ? this._mcpTools.join(', ') : 'all'})`);

      // Write a launcher script with heredoc to avoid shell-quoting issues
      // (system prompt has parens, quotes, brackets that break tmux send-keys)
      const launchScript = path.join(require('os').tmpdir(), 'hive-voice-launch.sh');
      const prompt = this._getSystemPrompt();
      fs.writeFileSync(launchScript, [
        '#!/bin/zsh -l',
        "read -r -d '' PROMPT << 'PROMPT_END'",
        prompt,
        'PROMPT_END',
        'claude --dangerously-skip-permissions --append-system-prompt "$PROMPT"',
        '',
      ].join('\n'));
      fs.chmodSync(launchScript, 0o755);

      await sessionManager.startClaude(VOICE_SESSION, 1, `bash ${launchScript}`);
      log.info('[voice] Created hive-voice session with Claude');
      // Give Claude time to start up
      await new Promise(r => setTimeout(r, 8000));
    } else {
      log.info('[voice] hive-voice session already exists');
    }
  }

  /**
   * System prompt for the voice Claude session.
   */
  _getSystemPrompt() {
    if (this._customSystemPrompt) return this._customSystemPrompt;

    return [
      'You are Hive, an AI engineering fleet manager, speaking in a live meeting.',
      'You hear meeting transcripts and decide whether to respond.',
      '',
      'RESPONSE RULES:',
      '- If someone addresses you (Hive/hive/hi/hey hive or similar), respond.',
      '- If no one is talking to you, reply with exactly: SILENT',
      '- Keep responses under 2 sentences. Be concise — this is spoken aloud via TTS.',
      '- No markdown, no code blocks, no bullet points. Plain conversational English.',
      '- If you don\'t know something, say so briefly.',
      '',
      'FIRST INTERACTION:',
      '- The first time you are called on in a meeting, briefly introduce yourself.',
      '  Example: "Hey everyone, I\'m Hive — I manage the engineering fleet. Here\'s where we\'re at..."',
      '- Then deliver any standup data you were primed with.',
      '- After the first introduction, just be conversational — no need to re-introduce.',
      '',
      'HIVE STATE — you have full access to the fleet:',
      '- Read .hive-state.json in the project root to see all tasks, sessions, and fleet state.',
      '- Key fields in the state file:',
      // [Phase 1 — context-consolidation] sourcePR mentioned here is a docs-only
      // reference to the task field. Phase 2 removes task.sourcePR; update this
      // string then. See: ~/dev/agents/hive/context-consolidation-plan.md (risk #8)
      '  tasks[]: id, text, status (queued/dispatched/completed/failed/cancelled), assignedTo (session number), workState, source, sourcePR, createdAt, completedAt',
      '  autoSessions[]: session numbers in auto-dispatch mode',
      '  designations: { sessionNum: designationName } — named roles like "iOS", "Hive", "Android"',
      '  sessionContext: { sessionNum: { planText, pr, jira, branch } } — what each session is working on',
      '  feed[]: recent activity log entries',
      '  spawnedAgents: { sessionNum: { repoDir, name } }',
      '  pms[]: project managers with their instructions and sources',
      '',
      'When asked about tasks, fleet status, what sessions are doing, PRs, etc. — read the state file and answer from it.',
      'You also have hive MCP tools available (hive_get_task, hive_get_sessions, hive_share_knowledge, etc.) — use them for live data.',
      '',
      'ACTIONS — include these tags in your response to take actions:',
      '- [CREATE_TASK: description] — create a new task in the queue',
      '- [COMPLETE_TASK: id] — mark a task as completed',
      '- [CANCEL_TASK: id] — cancel a queued or dispatched task',
      '- [DISPATCH_TASK: id TO session] — dispatch a queued task to a session number',
      'Action tags are stripped before speaking. You can include multiple actions in one response.',
    ].join('\n');
  }

  /**
   * Build context message to send to Claude with each transcript batch.
   */
  _buildContextMessage(transcriptText) {
    // Gather fleet status
    let fleetContext = '';
    if (this.taskQueue) {
      const tasks = [...this.taskQueue.tasks.values()];
      const since = Date.now() - 86400000;
      const completed = tasks.filter(t => t.status === 'completed' && t.completedAt >= since);
      const active = tasks.filter(t => t.status === 'dispatched');
      const queued = tasks.filter(t => t.status === 'queued');
      let blocked = 0;
      if (this.watcher?.lastState) {
        for (const [, state] of this.watcher.lastState) {
          if (state === 'waiting') blocked++;
        }
      }
      fleetContext = `\n[Fleet: ${active.length} active, ${queued.length} queued, ${completed.length} completed today, ${blocked} blocked]`;
    }

    return `[Meeting transcript]${fleetContext}\n\n${transcriptText}`;
  }

  /**
   * Extract Claude's response from the full pane capture.
   * The pane includes startup noise, previous exchanges, and the current
   * transcript. We find the last occurrence of the sent transcript and
   * take everything after it as Claude's response.
   */
  _extractClaudeResponse(fullResponse, sentTranscript) {
    // Find the last [Speaker ...] line from the sent transcript
    const lastSpeakerLine = sentTranscript.split('\n').filter(l => l.startsWith('[')).pop();
    if (!lastSpeakerLine) return fullResponse;

    // Search for it in the pane output (may be wrapped/truncated)
    const searchKey = lastSpeakerLine.substring(0, Math.min(lastSpeakerLine.length, 40));
    const idx = fullResponse.lastIndexOf(searchKey);
    if (idx < 0) return fullResponse;

    // Take everything after the matched line
    const afterTranscript = fullResponse.substring(idx + searchKey.length);
    // Find the end of the matched line
    const nlIdx = afterTranscript.indexOf('\n');
    const response = nlIdx >= 0 ? afterTranscript.substring(nlIdx + 1).trim() : afterTranscript.trim();
    return response || fullResponse;
  }

  /**
   * Join a meeting, deliver standup, and start listening.
   */
  async joinMeeting(meetingUrl, opts = {}) {
    if (this.active) {
      log.warn('[voice] Already in a meeting');
      return;
    }

    log.info(`[voice] ===== Starting voice agent for: ${meetingUrl} =====`);
    this.active = true;
    this.joinedAt = Date.now();
    this.meetingUrl = meetingUrl;
    this._tasksCreated = 0;
    this._currentMeetingId = `mtg-${this.joinedAt}`;
    this._currentMeetingName = opts.name || this._deriveMeetingName(meetingUrl);
    this._currentTranscript = [];
    this._currentResponses = [];

    // Ensure voice session exists
    await this._ensureVoiceSession();

    // Create meeting joiner
    const port = this.taskQueue?.config?.web?.port || 3000;
    this.meeting = new MeetingJoiner({
      botName: opts.botName || 'Hive',
      audioBridgeUrl: `ws://127.0.0.1:${port}/voice/audio`,
    });

    // Create transcriber
    this.transcriber = new Transcriber();

    // Wire transcriber to speech-pause buffer + meeting history
    this.transcriber.on('transcript', (entry) => {
      entry._ts = Date.now();
      this._currentTranscript.push(entry);
      this._onTranscript(entry);
      this.emit('transcript', entry);
    });

    try {
      await this.transcriber.start();
      await this.meeting.join(meetingUrl, { passcode: opts.passcode });
      await this._waitForAudioBridge(10000);

      // Prime Claude session with standup data so it's ready when called on
      const shouldReport = opts.reportOnJoin !== undefined ? opts.reportOnJoin : this.reportOnJoin;
      if (shouldReport) {
        log.info('[voice] Priming Claude session with standup data...');
        const reportData = await this.standup.generate(this.taskQueue, this.watcher);
        // Use relay.tell (fire-and-forget) to prime context without waiting for a response
        const node = this.router.getNode('local');
        const cfg = this.config || this.taskQueue?.config;
        if (cfg && node) {
          await relay.tell(cfg, node, VOICE_SESSION, [
            'You just joined a meeting. Here is your standup update — keep it ready.',
            'When someone calls on you (e.g. "Hive, your turn" or "Hive, what\'s your update?"),',
            'deliver this as a concise spoken summary. Do NOT speak until called on.',
            '',
            reportData,
          ].join('\n'));
          log.info('[voice] Standup data primed — waiting to be called on');
        }
      }

      // Max duration timer
      if (this.maxDuration > 0) {
        this._maxDurationTimer = setTimeout(() => {
          log.info('[voice] Max duration reached, leaving meeting');
          this.leaveMeeting();
        }, this.maxDuration);
      }

      this.meeting.on('meeting-ended', () => {
        log.info('[voice] Meeting ended externally');
        this.leaveMeeting();
      });

      this.emit('joined', { meetingUrl });
    } catch (e) {
      log.error(`[voice] Failed to join meeting: ${e.message}`);
      this.active = false;
      await this.leaveMeeting();
      throw e;
    }
  }

  /**
   * Handle a new transcript entry — buffer and detect speech pauses.
   */
  _onTranscript(entry) {
    // Don't process while we're speaking (avoids echo)
    if (this._speaking) return;

    this._transcriptBuffer.push(entry);

    // Reset the silence timer — fires after silence gap of no new transcripts
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => this._onSilence(), this._silenceGap);
  }

  /**
   * Called when there's a pause in speech — send buffered transcript to Claude.
   */
  async _onSilence() {
    if (this._processingTranscript || this._transcriptBuffer.length === 0) return;
    this._processingTranscript = true;

    try {
      // Grab and clear the buffer
      const entries = this._transcriptBuffer.splice(0);
      const transcriptText = entries
        .map(e => {
          const speaker = e.speaker != null ? `Speaker ${e.speaker}` : 'Unknown';
          return `[${speaker}] ${e.text}`;
        })
        .join('\n');

      const message = this._buildContextMessage(transcriptText);
      await this._sendToSession(message, transcriptText);
    } catch (e) {
      log.error(`[voice] Transcript processing error: ${e.message}`);
    } finally {
      this._processingTranscript = false;
    }
  }

  /**
   * Send a message to the Claude voice session, handle the response
   * (action tags, TTS), and return the spoken text (if any).
   *
   * @param {string} message - the message to send to Claude
   * @param {string} [sentTranscript] - original transcript text for response extraction
   */
  async _sendToSession(message, sentTranscript) {
    const config = this.config || this.taskQueue?.config;
    if (!config) {
      log.warn('[voice] No config available, cannot relay to Claude');
      return null;
    }

    log.info(`[voice] Sending to Claude: "${message.substring(0, 200)}"`);

    const node = this.router.getNode('local');
    const result = await relay.ask(config, node, VOICE_SESSION, message, {
      force: true, // always send, don't check idle state
    });

    if (!result.success) {
      log.warn(`[voice] Claude response failed: ${result.error}`);
      return null;
    }

    // Extract Claude's actual response from the pane capture
    const rawResponse = (result.response || '').trim();
    const response = sentTranscript
      ? this._extractClaudeResponse(rawResponse, sentTranscript)
      : rawResponse;
    log.info(`[voice] Claude response: "${response.substring(0, 200)}"`);

    // Check for SILENT — Claude chose not to respond
    if (!response || response === 'SILENT' || response.startsWith('SILENT')) {
      log.info('[voice] Claude: SILENT (not addressed)');
      return null;
    }

    // Process action tags from Claude's response
    this._processActions(response);

    // Strip all action tags before speaking
    const spokenResponse = response
      .replace(/\[CREATE_TASK:[^\]]*\]/gi, '')
      .replace(/\[COMPLETE_TASK:[^\]]*\]/gi, '')
      .replace(/\[CANCEL_TASK:[^\]]*\]/gi, '')
      .replace(/\[DISPATCH_TASK:[^\]]*\]/gi, '')
      .trim();
    if (spokenResponse) {
      this._currentResponses.push({ text: spokenResponse, _ts: Date.now() });
      this.emit('response', spokenResponse);
      await this._speak(spokenResponse);
    }
    return spokenResponse || null;
  }

  /**
   * Process action tags from Claude's response.
   */
  _processActions(response) {
    if (!this.taskQueue) return;

    // [CREATE_TASK: description]
    const createMatches = response.matchAll(/\[CREATE_TASK:\s*(.+?)\]/gi);
    for (const match of createMatches) {
      const taskText = `[voice-meeting] ${match[1]}`;
      const task = this.taskQueue.createTask(taskText, 'auto', null, null, {
        source: `pm:${this.pmName}`,
      });
      this._tasksCreated = (this._tasksCreated || 0) + 1;
      log.info(`[voice] Task created: T:${task.id} — "${match[1]}"`);
      this.emit('task-created', { id: task.id, title: match[1] });
    }

    // [COMPLETE_TASK: id]
    const completeMatches = response.matchAll(/\[COMPLETE_TASK:\s*(\d+)\]/gi);
    for (const match of completeMatches) {
      const task = this.taskQueue.completeTask(match[1], 'Completed via voice meeting');
      if (task) {
        log.info(`[voice] Task completed: T:${match[1]}`);
        this.emit('task-action', { action: 'completed', id: match[1] });
      } else {
        log.warn(`[voice] Could not complete task T:${match[1]} — not found or not dispatched`);
      }
    }

    // [CANCEL_TASK: id]
    const cancelMatches = response.matchAll(/\[CANCEL_TASK:\s*(\d+)\]/gi);
    for (const match of cancelMatches) {
      const task = this.taskQueue.cancelTask(match[1]);
      if (task) {
        log.info(`[voice] Task cancelled: T:${match[1]}`);
        this.emit('task-action', { action: 'cancelled', id: match[1] });
      } else {
        log.warn(`[voice] Could not cancel task T:${match[1]} — not found`);
      }
    }

    // [DISPATCH_TASK: id TO session]
    const dispatchMatches = response.matchAll(/\[DISPATCH_TASK:\s*(\d+)\s+TO\s+(\d+)\]/gi);
    for (const match of dispatchMatches) {
      const taskId = match[1];
      const sessionNum = parseInt(match[2], 10);
      this.taskQueue.dispatchTaskTo(taskId, sessionNum).then(task => {
        if (task) {
          log.info(`[voice] Task dispatched: T:${taskId} → S:${sessionNum}`);
          this.emit('task-action', { action: 'dispatched', id: taskId, session: sessionNum });
        } else {
          log.warn(`[voice] Could not dispatch T:${taskId} to S:${sessionNum}`);
        }
      }).catch(e => {
        log.error(`[voice] Dispatch failed for T:${taskId}: ${e.message}`);
      });
    }
  }

  /**
   * Speak text in the meeting via TTS.
   */
  async _speak(text) {
    this._speaking = true;
    this.emit('speaking', true);
    try {
      const chunks = this.tts.splitText(text);
      for (const chunk of chunks) {
        const audioBuffer = await this.tts.speak(chunk);
        await this._playSystemAudio(audioBuffer);
      }
    } catch (e) {
      log.error(`[voice] TTS error: ${e.message}`);
    } finally {
      this._speaking = false;
      this.emit('speaking', false);
    }
  }

  /**
   * Play TTS audio through BlackHole virtual audio device via sox.
   * Falls back to system speakers if BlackHole is not available.
   */
  async _playSystemAudio(pcmBuffer) {
    const tmpFile = path.join(require('os').tmpdir(), `hive-tts-${Date.now()}.raw`);
    try {
      fs.writeFileSync(tmpFile, pcmBuffer);
      const durationMs = (pcmBuffer.length / (24000 * 2)) * 1000;

      // Pause transcription to avoid hearing ourselves
      if (this.transcriber) this.transcriber._paused = true;

      const useBlackHole = this._hasBlackHole !== false;
      log.info(`[voice] Playing TTS via ${useBlackHole ? 'BlackHole' : 'speakers'} (${(durationMs / 1000).toFixed(1)}s)`);

      await new Promise((resolve, reject) => {
        const args = useBlackHole
          ? ['-t', 'raw', '-r', '24000', '-e', 'signed', '-b', '16', '-c', '1', tmpFile,
             '-t', 'coreaudio', 'BlackHole 2ch']
          : ['-t', 'raw', '-r', '24000', '-e', 'signed', '-b', '16', '-c', '1', tmpFile];
        const proc = spawn('sox', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.on('exit', (code) => {
          if (code !== 0) {
            log.warn(`[voice] sox exited with code ${code}`);
            if (useBlackHole) {
              log.info('[voice] BlackHole failed, will use speakers next time');
              this._hasBlackHole = false;
            }
          }
          resolve();
        });
        proc.on('error', (e) => {
          log.error(`[voice] sox command failed: ${e.message}`);
          reject(e);
        });
        proc.stderr.on('data', () => {});
      });

      // Resume transcription after playback + settle time
      await new Promise(r => setTimeout(r, 500));
      if (this.transcriber) this.transcriber._paused = false;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    }
  }

  _waitForAudioBridge(timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (this.audioBridgeClients.size > 0) return resolve();
      const check = setInterval(() => {
        if (this.audioBridgeClients.size > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 500);
      const timeout = setTimeout(() => {
        clearInterval(check);
        log.warn('[voice] Audio bridge timeout — proceeding without live audio');
        resolve();
      }, timeoutMs);
    });
  }

  async leaveMeeting() {
    if (this._ffmpeg) {
      this._ffmpeg.kill('SIGTERM');
      this._ffmpeg = null;
    }

    if (this._maxDurationTimer) {
      clearTimeout(this._maxDurationTimer);
      this._maxDurationTimer = null;
    }

    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }

    if (this.transcriber) {
      this.transcriber.stop();
      this.transcriber = null;
    }

    if (this.meeting) {
      await this.meeting.leave();
      this.meeting = null;
    }

    this._transcriptBuffer = [];

    // Save meeting to history
    if (this._currentMeetingId) {
      this.meetings.unshift({
        id: this._currentMeetingId,
        name: this._currentMeetingName || 'Meeting',
        url: this.meetingUrl,
        startedAt: this.joinedAt,
        endedAt: Date.now(),
        transcript: this._currentTranscript,
        responses: this._currentResponses,
        tasksCreated: this._tasksCreated || 0,
      });
      if (this.meetings.length > this._maxMeetings) this.meetings.length = this._maxMeetings;
      this._saveMeetings();
      log.info(`[voice] Meeting saved: ${this._currentMeetingId} (${this._currentTranscript.length} entries)`);
    }

    this.active = false;
    this.joinedAt = null;
    this.meetingUrl = null;
    this._currentMeetingId = null;
    this._currentMeetingName = null;
    this._currentTranscript = [];
    this._currentResponses = [];
    this.emit('left');
    log.info('[voice] ===== Voice agent stopped =====');
  }

  getStatus() {
    return {
      active: this.active,
      meetingId: this._currentMeetingId,
      meetingName: this._currentMeetingName,
      joinedAt: this.joinedAt,
      meetingUrl: this.meetingUrl,
      speaking: this._speaking,
      tasksCreated: this._tasksCreated || 0,
      transcriptLength: this._currentTranscript?.length || 0,
      audioBridgeConnected: this.audioBridgeClients?.size > 0,
    };
  }

  async getDebug() {
    const debug = {
      ...this.getStatus(),
      audioChunksReceived: this._audioChunksReceived || 0,
      transcriberRunning: this.transcriber?.running || false,
      meetingJoined: this.meeting?.joined || false,
    };

    if (this.meeting?.page) {
      try {
        debug.browserBridge = await this.meeting.page.evaluate(() => {
          const b = window.__hiveBridge;
          if (!b) return { exists: false };
          return {
            exists: true,
            wsState: b.ws?.readyState,
            audioContextState: b.audioContext?.state,
            capturedTracks: b.capturedTracks?.length || 0,
            chunksSent: b.chunksSent || 0,
            silentChunks: b.silentChunks || 0,
          };
        });
      } catch (e) {
        debug.browserBridge = { error: e.message };
      }
    }

    return debug;
  }
}

module.exports = VoiceAgent;
