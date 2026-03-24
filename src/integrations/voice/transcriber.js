'use strict';

const { DeepgramClient } = require('@deepgram/sdk');
const { EventEmitter } = require('events');
const log = require('../../core/log');

/**
 * Transcriber — streams audio to Deepgram for real-time STT.
 * Emits 'transcript' events with speaker-labeled text.
 *
 * Uses Deepgram SDK v5 API:
 *   const socket = await client.listen.v1.connect(opts);
 *   socket.on('open', cb);       // connected
 *   socket.on('message', cb);    // parsed JSON with transcript results
 *   socket.on('error', cb);
 *   socket.on('close', cb);
 *   socket.connect();            // actually initiates the WS connection
 *   socket.sendMedia(buffer);    // send audio data
 */
class Transcriber extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.DEEPGRAM_API_KEY;
    if (!this.apiKey) log.warn('[transcriber] DEEPGRAM_API_KEY not set — transcription will not work');
    // SDK v5: must set env var for WebSocket auth — constructor arg doesn't propagate to WS headers
    if (this.apiKey && !process.env.DEEPGRAM_API_KEY) {
      process.env.DEEPGRAM_API_KEY = this.apiKey;
    }
    this.client = this.apiKey ? new DeepgramClient() : null;
    this.connection = null;
    this.running = false;
    this.transcript = []; // rolling transcript buffer
    this.maxTranscriptEntries = opts.maxEntries || 500;
  }

  /**
   * Start the Deepgram live transcription connection.
   */
  async start() {
    if (this.running) return;
    if (!this.client) { log.error('[transcriber] No Deepgram client — cannot start'); return; }
    log.info('[transcriber] Starting Deepgram live transcription');

    this.connection = await this.client.listen.v1.connect({
      model: 'nova-2',
      language: 'en',
      smart_format: true,
      diarize: true,
      interim_results: false,
      sample_rate: 16000,
      channels: 1,
      encoding: 'linear16',
    });

    // SDK v5: .on() registers single handler per event via eventHandlers map
    this.connection.on('open', () => {
      log.info('[transcriber] Deepgram connection open');
      this.running = true;
      this.emit('ready');
    });

    this.connection.on('message', (data) => {
      // SDK v5 delivers parsed JSON — check for transcript results
      if (!data) return;

      // Deepgram sends different message types: Results, Metadata, UtteranceEnd, etc.
      // Results have channel.alternatives
      const alt = data.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      const entry = {
        text: alt.transcript.trim(),
        speaker: alt.words?.[0]?.speaker ?? null,
        confidence: alt.confidence,
        timestamp: Date.now(),
        isFinal: data.is_final,
      };

      if (entry.text && data.is_final) {
        this.transcript.push(entry);
        if (this.transcript.length > this.maxTranscriptEntries) {
          this.transcript.shift();
        }
        this.emit('transcript', entry);
        log.info(`[transcriber] [Speaker ${entry.speaker ?? '?'}] ${entry.text}`);
      }
    });

    this.connection.on('error', (err) => {
      log.error(`[transcriber] Deepgram error: ${err.message || err}`);
      // Don't re-emit as 'error' — unhandled 'error' events crash the process.
      // Listeners can subscribe to 'deepgram-error' if they need it.
      this.emit('deepgram-error', err);
    });

    this.connection.on('close', () => {
      log.info('[transcriber] Deepgram connection closed');
      this.running = false;
      this.emit('closed');
    });

    // SDK v5: must call .connect() to actually initiate the WebSocket
    this.connection.connect();
    log.info('[transcriber] Deepgram connect() called, waiting for open...');

    // Wait for the connection to open (up to 10s)
    await new Promise((resolve, reject) => {
      if (this.running) return resolve(); // already open
      const timeout = setTimeout(() => {
        if (!this.running) {
          log.warn('[transcriber] Deepgram open timeout after 10s');
        }
        resolve(); // resolve anyway, don't block
      }, 10000);
      this.once('ready', () => { clearTimeout(timeout); resolve(); });
    });
  }

  /**
   * Send raw PCM audio data to Deepgram.
   * @param {Buffer|ArrayBuffer} audioData - 16-bit 16kHz mono PCM
   */
  send(audioData) {
    if (!this.running || !this.connection || this._paused) return;
    try {
      this.connection.sendMedia(audioData);
    } catch (e) {
      log.error(`[transcriber] Send error: ${e.message}`);
    }
  }

  /**
   * Get recent transcript (last N seconds).
   */
  getRecentTranscript(seconds = 60) {
    const cutoff = Date.now() - (seconds * 1000);
    return this.transcript
      .filter(e => e.timestamp >= cutoff)
      .map(e => {
        const speaker = e.speaker != null ? `Speaker ${e.speaker}` : 'Unknown';
        return `[${speaker}] ${e.text}`;
      })
      .join('\n');
  }

  /**
   * Get full transcript as text.
   */
  getFullTranscript() {
    return this.transcript
      .map(e => {
        const speaker = e.speaker != null ? `Speaker ${e.speaker}` : 'Unknown';
        return `[${speaker}] ${e.text}`;
      })
      .join('\n');
  }

  /**
   * Stop transcription.
   */
  stop() {
    if (this.connection) {
      // Attach a no-op error handler to the underlying WS to prevent unhandled 'error' crashes
      // during async teardown (e.g. Deepgram SDK timeout closing a not-yet-open socket)
      try {
        const ws = this.connection._socket || this.connection.ws;
        if (ws && typeof ws.on === 'function') ws.on('error', () => {});
      } catch (_) { /* ignore */ }
      try { this.connection.close(); } catch (e) { /* ignore */ }
      this.connection = null;
    }
    this.running = false;
    log.info('[transcriber] Stopped');
  }
}

module.exports = Transcriber;
