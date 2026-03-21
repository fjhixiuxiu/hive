'use strict';

const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const MeetingJoiner = require('./meeting');
const TTS = require('./tts');
const StandupReport = require('./standup');
const Transcriber = require('./transcriber');
const MeetingListener = require('./listener');
const log = require('../../core/log');

/**
 * Voice Agent — orchestrates meeting joining, standup reporting,
 * audio capture/playback, transcription, and task extraction.
 *
 * This is initialized from pm.js when a voice-meeting PM is enabled.
 */
class VoiceAgent extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.taskQueue = opts.taskQueue;
    this.watcher = opts.watcher;
    this.pmName = opts.pmName || 'Voice Meeting';
    this.knowledgeBase = opts.knowledgeBase; // function to add KB entries

    // Sub-components (created on join)
    this.meeting = null;
    this.tts = new TTS({
      voice: opts.voice || 'aura-orion-en',
    });
    this.standup = new StandupReport();
    this.transcriber = null;
    this.listener = null;

    // Config
    this.reportOnJoin = opts.reportOnJoin !== false;
    this.listenForTasks = opts.listenForTasks !== false;
    this.extractLearnings = opts.extractLearnings !== false;
    this.answerQuestions = opts.answerQuestions !== false;
    this.triggerPhrases = opts.triggerPhrases || ['hive', 'hey hive'];
    this.maxDuration = opts.maxDuration || 600000; // 10 min

    // State
    this.active = false;
    this.audioBridgeWss = null;
    this.audioBridgeClients = new Set();
    this._maxDurationTimer = null;
  }

  /**
   * Set up the WebSocket audio bridge endpoint.
   * Called once during server setup with the HTTP server instance.
   */
  setupAudioBridge(server) {
    this.audioBridgeWss = new WebSocketServer({ noServer: true });

    this.audioBridgeWss.on('connection', (ws) => {
      log.info('[voice] Audio bridge client connected');
      this.audioBridgeClients.add(ws);

      ws.on('message', (data) => {
        // Incoming audio from the meeting (PCM 16-bit, 16kHz, mono)
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
   * Join a meeting, deliver standup, and start listening.
   * @param {string} meetingUrl - Zoom meeting URL
   * @param {object} opts - { passcode, reportOnJoin, botName }
   */
  async joinMeeting(meetingUrl, opts = {}) {
    if (this.active) {
      log.warn('[voice] Already in a meeting');
      return;
    }

    log.info(`[voice] ===== Starting voice agent for: ${meetingUrl} =====`);
    this.active = true;

    // Create meeting joiner
    const port = this.taskQueue?.config?.web?.port || 3000;
    this.meeting = new MeetingJoiner({
      botName: opts.botName || 'Hive',
      audioBridgeUrl: `ws://127.0.0.1:${port}/voice/audio`,
    });

    // Create transcriber
    this.transcriber = new Transcriber();

    // Create listener
    this.listener = new MeetingListener({
      triggerPhrases: this.triggerPhrases,
    });

    // Wire up listener events
    this.listener.on('task', async (taskData) => {
      if (!this.taskQueue) return;
      const text = `[voice-meeting] ${taskData.text}`;
      const task = this.taskQueue.createTask(text, 'auto', null, null, {
        source: `pm:${this.pmName}`,
      });
      log.info(`[voice] Task created: T:${task.id} — "${taskData.text}"`);
      this.emit('task-created', task);

      // Confirm audibly
      await this._speak("Got it. I've queued that up.");
    });

    this.listener.on('question', async (qData) => {
      if (!this.answerQuestions) return;
      const answer = await this._answerQuestion(qData.question);
      if (answer) {
        await this._speak(answer);
      }
    });

    this.listener.on('learnings', (learnings) => {
      if (this.knowledgeBase) {
        for (const l of learnings) {
          this.knowledgeBase({
            insight: l.insight,
            domain: l.domain,
            sourcePm: this.pmName,
          });
        }
        log.info(`[voice] Added ${learnings.length} learnings to knowledge base`);
      }
    });

    // Wire transcriber to listener
    this.transcriber.on('transcript', (entry) => {
      this.listener.processTranscript(entry, this.transcriber);
      this.emit('transcript', entry);
    });

    try {
      // Start transcriber first
      await this.transcriber.start();

      // Join meeting
      await this.meeting.join(meetingUrl, { passcode: opts.passcode });

      // Wait for browser audio bridge (for TTS playback + tab audio capture)
      await this._waitForAudioBridge(10000);

      // Deliver standup report if configured
      if (this.reportOnJoin !== false) {
        log.info('[voice] Generating standup report...');
        const reportText = await this.standup.generate(this.taskQueue, this.watcher);
        log.info(`[voice] Report: ${reportText.substring(0, 200)}...`);

        // Small delay to let audio settle
        await new Promise(r => setTimeout(r, 3000));
        await this._speak(reportText);
      }

      // Set max duration timer
      if (this.maxDuration > 0) {
        this._maxDurationTimer = setTimeout(() => {
          log.info('[voice] Max duration reached, leaving meeting');
          this.leaveMeeting();
        }, this.maxDuration);
      }

      // Watch for meeting end
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
   * Speak text in the meeting via TTS.
   */
  async _speak(text) {
    try {
      const chunks = this.tts.splitText(text);
      for (const chunk of chunks) {
        const audioBuffer = await this.tts.speak(chunk);
        await this._playSystemAudio(audioBuffer);
      }
    } catch (e) {
      log.error(`[voice] TTS error: ${e.message}`);
    }
  }

  /**
   * Play TTS audio through BlackHole virtual audio device via sox.
   * Chrome's mic is set to BlackHole, so TTS goes directly into Zoom's mic channel.
   * No speakers involved — clean digital audio path.
   * Falls back to system speakers if BlackHole is not available.
   */
  async _playSystemAudio(pcmBuffer) {
    const tmpFile = path.join(require('os').tmpdir(), `hive-tts-${Date.now()}.raw`);
    try {
      fs.writeFileSync(tmpFile, pcmBuffer);
      const durationMs = (pcmBuffer.length / (24000 * 2)) * 1000;

      // Pause transcription to avoid hearing ourselves
      if (this.transcriber) this.transcriber._paused = true;

      // Try BlackHole first, fall back to default speakers
      const useBlackHole = this._hasBlackHole !== false;
      if (useBlackHole) {
        log.info(`[voice] Playing TTS via BlackHole (${(durationMs / 1000).toFixed(1)}s)`);
      } else {
        log.info(`[voice] Playing TTS via speakers (${(durationMs / 1000).toFixed(1)}s)`);
      }

      // sox: -t raw input, output to coreaudio device
      // BlackHole: clean digital loopback, no speakers
      // Speakers: fallback, mic picks it up
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
        proc.stderr.on('data', () => {}); // suppress sox progress output
      });

      // Resume transcription after playback + brief settle time
      await new Promise(r => setTimeout(r, 500));
      if (this.transcriber) this.transcriber._paused = false;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Answer a question about fleet status using template matching.
   * No LLM needed — matches common question patterns against live data.
   */
  _answerQuestion(question) {
    try {
      if (!this.taskQueue) return "I don't have access to the task queue right now.";

      const tasks = [...this.taskQueue.tasks.values()];
      const since = Date.now() - 86400000;
      const completed = tasks.filter(t => t.status === 'completed' && t.completedAt >= since);
      const active = tasks.filter(t => t.status === 'dispatched');
      const queued = tasks.filter(t => t.status === 'queued');
      const lower = question.toLowerCase();

      // Status / how are things going
      if (/status|how.*(things|going|doing|look)|what.*(happening|going on)|overview/i.test(lower)) {
        return `We have ${active.length} tasks actively being worked on, ${queued.length} in the queue, and ${completed.length} completed in the last 24 hours.`;
      }

      // What's active / being worked on
      if (/active|working on|in progress|current/i.test(lower)) {
        if (active.length === 0) return 'Nothing is actively being worked on right now.';
        const summaries = active.slice(0, 3).map(t => this.standup._summarize(t.text));
        return `We have ${active.length} active tasks. ${summaries.join('. ')}.`;
      }

      // What's queued / next / upcoming
      if (/queue|next|upcoming|backlog|waiting/i.test(lower)) {
        if (queued.length === 0) return 'The queue is empty right now.';
        return `There are ${queued.length} tasks queued up next.`;
      }

      // Completed / done / finished
      if (/completed|done|finished|shipped/i.test(lower)) {
        if (completed.length === 0) return 'No tasks have been completed in the last 24 hours.';
        const summaries = completed.slice(0, 3).map(t => this.standup._summarize(t.text));
        return `We completed ${completed.length} tasks in the last 24 hours. Including: ${summaries.join('. ')}.`;
      }

      // Blocked / stuck
      if (/blocked|stuck|waiting|issue|problem/i.test(lower)) {
        let blockedCount = 0;
        if (this.watcher?.lastState) {
          for (const [, state] of this.watcher.lastState) {
            if (state === 'waiting') blockedCount++;
          }
        }
        if (blockedCount === 0) return 'No sessions are currently blocked.';
        return `${blockedCount} sessions are currently blocked and waiting for input.`;
      }

      // How many / count
      if (/how many|count|total|number of/i.test(lower)) {
        return `We have ${active.length} active, ${queued.length} queued, and ${completed.length} completed in the last 24 hours. ${tasks.length} total tasks.`;
      }

      // Fallback
      return `I have ${active.length} tasks in progress, ${queued.length} queued, and ${completed.length} completed today. Could you be more specific?`;
    } catch (e) {
      log.error(`[voice] Answer question error: ${e.message}`);
      return "Sorry, I couldn't process that question right now.";
    }
  }

  /**
   * Wait for the audio bridge client (injected page script) to connect.
   */
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

  /**
   * Start capturing audio from ZoomAudioDevice via ffmpeg.
   * This captures all meeting audio at the OS level — works regardless
   * of how Zoom renders audio internally (WebRTC, WASM, etc.).
   */
  _startSystemAudioCapture() {
    // ffmpeg captures from ZoomAudioDevice (avfoundation audio device 1)
    // and outputs raw PCM: 16-bit signed, 16kHz, mono
    const args = [
      '-f', 'avfoundation',
      '-i', ':1',  // ZoomAudioDevice (audio device index 1)
      '-ac', '1',
      '-ar', '16000',
      '-acodec', 'pcm_s16le',
      '-f', 's16le',
      'pipe:1',    // output to stdout
    ];

    log.info('[voice] Starting system audio capture from ZoomAudioDevice');
    this._ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    this._ffmpeg.stdout.on('data', (chunk) => {
      this._audioChunksReceived = (this._audioChunksReceived || 0) + 1;
      if (this._audioChunksReceived === 1) {
        log.info(`[voice] First system audio chunk (${chunk.length} bytes)`);
      }
      if (this._audioChunksReceived % 200 === 0) {
        log.info(`[voice] System audio: ${this._audioChunksReceived} chunks`);
      }
      if (this.transcriber) {
        this.transcriber.send(chunk);
      }
    });

    this._ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      // Only log meaningful messages, not progress
      if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
        log.error(`[voice] ffmpeg: ${msg.trim()}`);
      }
    });

    this._ffmpeg.on('exit', (code) => {
      log.info(`[voice] ffmpeg exited with code ${code}`);
      this._ffmpeg = null;
    });
  }

  /**
   * Leave the meeting and clean up.
   */
  async leaveMeeting() {
    // Stop ffmpeg audio capture
    if (this._ffmpeg) {
      this._ffmpeg.kill('SIGTERM');
      this._ffmpeg = null;
      log.info('[voice] Stopped system audio capture');
    }

    if (this._maxDurationTimer) {
      clearTimeout(this._maxDurationTimer);
      this._maxDurationTimer = null;
    }

    if (this.listener) {
      this.listener.stop();
      this.listener = null;
    }

    if (this.transcriber) {
      this.transcriber.stop();
      this.transcriber = null;
    }

    if (this.meeting) {
      await this.meeting.leave();
      this.meeting = null;
    }

    this.active = false;
    this.emit('left');
    log.info('[voice] ===== Voice agent stopped =====');
  }

  /**
   * Get current status for dashboard.
   */
  getStatus() {
    return {
      active: this.active,
      transcriptLength: this.transcriber?.transcript?.length || 0,
      audioBridgeConnected: this.audioBridgeClients?.size > 0,
    };
  }

  /**
   * Get detailed debug info — queries the browser for audio bridge state.
   */
  async getDebug() {
    const debug = {
      ...this.getStatus(),
      audioChunksReceived: this._audioChunksReceived || 0,
      transcriberRunning: this.transcriber?.running || false,
      meetingJoined: this.meeting?.joined || false,
    };

    // Query in-browser bridge state
    if (this.meeting?.page) {
      try {
        debug.browserBridge = await this.meeting.page.evaluate(() => {
          const b = window.__hiveBridge;
          if (!b) return { exists: false };
          const audioEls = document.querySelectorAll('audio');
          const videoEls = document.querySelectorAll('video');
          return {
            exists: true,
            wsState: b.ws?.readyState,
            audioContextState: b.audioContext?.state,
            audioContextSampleRate: b.audioContext?.sampleRate,
            capturedTracks: b.capturedTracks?.length || 0,
            micStreamTracks: b.micStream?.getAudioTracks()?.length || 0,
            chunksSent: b.chunksSent || 0,
            silentChunks: b.silentChunks || 0,
            audioElements: audioEls.length,
            videoElements: videoEls.length,
            mediaCaptured: [...audioEls, ...videoEls].filter(e => e.__hiveCaptured).length,
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
