'use strict';

const path = require('path');
const { chromium } = require('playwright');
const { EventEmitter } = require('events');
const log = require('../../core/log');

/**
 * Meeting Joiner — uses Playwright to join a Zoom meeting via web client.
 * Injects audio hooks to capture meeting audio and inject TTS.
 */
class MeetingJoiner extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.joined = false;
    this.botName = opts.botName || 'Hive';
    this.audioBridgeUrl = opts.audioBridgeUrl || 'ws://127.0.0.1:3000/voice/audio';
  }

  /**
   * Join a Zoom meeting via the web client.
   * @param {string} meetingUrl - Full Zoom URL (e.g. https://us02web.zoom.us/j/83837092844)
   * @param {object} opts - { passcode }
   */
  async join(meetingUrl, opts = {}) {
    const meetingId = this._extractMeetingId(meetingUrl);
    if (!meetingId) throw new Error(`Cannot extract meeting ID from: ${meetingUrl}`);

    // Determine the web client URL from the original URL
    const urlObj = new URL(meetingUrl);
    const webUrl = `${urlObj.protocol}//${urlObj.host}/wc/join/${meetingId}`;

    log.info(`[voice] Launching browser to join meeting ${meetingId}`);

    const extPath = path.join(__dirname, 'chrome-ext');
    const userDataDir = path.join(require('os').tmpdir(), 'hive-chrome-' + Date.now());

    // Must use launchPersistentContext for Chrome extension support
    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        '--use-fake-ui-for-media-stream',      // auto-accept mic/camera
        // Use BlackHole as audio input — TTS plays to BlackHole, Chrome reads it as mic
        '--disable-web-security',               // for audio context
        '--autoplay-policy=no-user-gesture-required',
        '--auto-select-desktop-capture-source=Zoom',  // auto-select tab for getDisplayMedia
        '--enable-usermedia-screen-capturing',
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
      permissions: ['microphone', 'camera'],
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    this.browser = this.context.browser();

    this.page = this.context.pages()[0] || await this.context.newPage();

    // Forward browser console to server logs
    this.page.on('console', msg => {
      const text = msg.text();
      if (text.includes('[hive-bridge]')) {
        log.info(`[voice:browser] ${text}`);
      }
    });

    // Inject audio bridge BEFORE page loads
    await this.page.addInitScript(this._getAudioBridgeScript());

    log.info(`[voice] Navigating to ${webUrl}`);
    await this.page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Handle Zoom web join flow
    await this._handleZoomJoinFlow(opts.passcode);

    this.joined = true;
    this.emit('joined', { meetingId });
    log.info(`[voice] Successfully joined meeting ${meetingId} as "${this.botName}"`);

    // Start CDP-based audio capture as fallback
    await this._startCDPAudioCapture();

    // Monitor for meeting end
    this._watchForMeetingEnd();
  }

  /**
   * Handle the Zoom web client join sequence.
   */
  async _handleZoomJoinFlow(passcode) {
    // Wait for page to settle (Zoom redirects from us02web → app.zoom.us)
    await this.page.waitForTimeout(3000);

    // Step 1: Accept cookies/terms if present
    try {
      const acceptBtn = this.page.locator('button:has-text("Accept"), #onetrust-accept-btn-handler');
      if (await acceptBtn.isVisible({ timeout: 2000 })) {
        await acceptBtn.click();
        log.info('[voice] Accepted cookies/terms');
      }
    } catch (e) { /* no cookie banner */ }

    // Step 2: Stop video in preview (before joining)
    try {
      const videoBtn = this.page.locator('#preview-video-control-button, button[aria-label="Stop Video"]');
      if (await videoBtn.isVisible({ timeout: 2000 })) {
        const text = await videoBtn.textContent();
        if (text && text.includes('Stop Video')) {
          await videoBtn.click();
          log.info('[voice] Stopped video in preview');
        }
      }
    } catch (e) { /* no video button */ }

    // Step 3: Enter name (Zoom web client uses #input-for-name)
    try {
      const nameInput = this.page.locator('#input-for-name, #inputname, input[placeholder*="name" i]');
      await nameInput.waitFor({ state: 'visible', timeout: 10000 });
      await nameInput.clear();
      await nameInput.fill(this.botName);
      log.info(`[voice] Entered name: ${this.botName}`);
    } catch (e) {
      log.warn(`[voice] Could not find name input: ${e.message}`);
    }

    // Step 4: Enter passcode if needed
    if (passcode) {
      try {
        const passInput = this.page.locator('#inputpasscode, input[placeholder*="passcode" i], input[type="password"]');
        if (await passInput.isVisible({ timeout: 3000 })) {
          await passInput.fill(passcode);
          log.info('[voice] Entered passcode');
        }
      } catch (e) { /* no passcode needed */ }
    }

    // Step 5: Click Join
    try {
      const joinBtn = this.page.locator('button:has-text("Join")').first();
      await joinBtn.waitFor({ state: 'visible', timeout: 5000 });
      await joinBtn.click();
      log.info('[voice] Clicked Join');
    } catch (e) {
      log.warn(`[voice] Could not find Join button: ${e.message}`);
    }

    // Step 6: Wait for meeting to load — detect waiting room or actual meeting UI
    const meetingReady = await this._waitForMeetingReady(60000);
    if (!meetingReady) {
      log.warn('[voice] Meeting did not become ready within timeout');
      await this.page.screenshot({ path: '/tmp/zoom-debug-joinstate.png' });
    }

    // Step 7: Join audio if prompted (separate from preview)
    try {
      const joinAudioBtn = this.page.locator('button:has-text("Join Audio by Computer"), button:has-text("Join Audio")');
      if (await joinAudioBtn.isVisible({ timeout: 5000 })) {
        await joinAudioBtn.click();
        log.info('[voice] Joined audio by computer');
      }
    } catch (e) { /* no audio prompt */ }

    await this.page.waitForTimeout(2000);
    await this.page.screenshot({ path: '/tmp/zoom-joined.png' });
    log.info('[voice] Join flow complete — screenshot saved to /tmp/zoom-joined.png');
  }

  /**
   * Send TTS audio to the meeting via the injected audio bridge.
   * @param {Buffer} audioBuffer - Raw PCM audio (16-bit, 24kHz, mono)
   */
  async sendAudio(audioBuffer) {
    if (!this.page || !this.joined) return;
    try {
      // Ensure unmuted before sending TTS
      await this._ensureUnmuted();
      const b64 = audioBuffer.toString('base64');
      log.info(`[voice] Sending TTS audio to browser (${audioBuffer.length} bytes)`);
      await this.page.evaluate((data) => {
        if (window.__hiveBridge) window.__hiveBridge.playAudio(data);
      }, b64);
    } catch (e) {
      log.error(`[voice] Failed to send audio: ${e.message}`);
    }
  }

  /**
   * Ensure Hive's mic is unmuted in Zoom.
   */
  async _ensureUnmuted() {
    if (!this.page) return;
    try {
      const muteBtn = this.page.locator('button[aria-label="Unmute"], button[aria-label="unmute"]');
      if (await muteBtn.isVisible({ timeout: 1000 })) {
        await muteBtn.click();
        log.info('[voice] Clicked Unmute');
      }
    } catch (e) { /* already unmuted or button not found */ }
  }

  /**
   * Leave the meeting and close browser.
   */
  async leave() {
    log.info('[voice] Leaving meeting');
    this.joined = false;
    try {
      if (this.page) {
        // Try clicking Leave button
        const leaveBtn = this.page.locator('button:has-text("Leave"), button[aria-label*="leave" i]');
        if (await leaveBtn.isVisible({ timeout: 2000 })) {
          await leaveBtn.click();
          const confirmBtn = this.page.locator('button:has-text("Leave Meeting")');
          if (await confirmBtn.isVisible({ timeout: 2000 })) {
            await confirmBtn.click();
          }
        }
      }
    } catch (e) { /* best effort */ }

    try {
      if (this.context) await this.context.close();
    } catch (e) { /* ignore */ }

    this.browser = null;
    this.context = null;
    this.page = null;
    this.emit('left');
    log.info('[voice] Left meeting and closed browser');
  }

  /**
   * Watch for meeting end (host ended, kicked, etc).
   */
  _watchForMeetingEnd() {
    if (!this.page) return;
    const check = async () => {
      if (!this.joined || !this.page) return;
      try {
        const ended = await this.page.locator(
          'div:has-text("This meeting has been ended"), div:has-text("The host has ended"), div:has-text("removed from this meeting")'
        ).isVisible({ timeout: 1000 });
        if (ended) {
          log.info('[voice] Meeting has ended');
          this.emit('meeting-ended');
          await this.leave();
          return;
        }
      } catch (e) { /* page may be closed */ return; }
      setTimeout(check, 5000);
    };
    setTimeout(check, 10000);
  }

  /**
   * Start audio capture using Chrome's tab self-capture API.
   * getDisplayMedia with preferCurrentTab captures the tab's own audio
   * output, including WASM-rendered audio that bypasses Web Audio API.
   */
  async _startCDPAudioCapture() {
    if (!this.page) return;
    log.info('[voice] Starting tab audio self-capture');

    try {
      const result = await this.page.evaluate(() => {
        const bridge = window.__hiveBridge;
        if (!bridge) return 'no bridge';

        // Use getDisplayMedia with preferCurrentTab to capture THIS tab's audio
        // Chrome auto-selects due to --auto-select-desktop-capture-source flag
        return navigator.mediaDevices.getDisplayMedia({
          audio: {
            suppressLocalAudioPlayback: false,  // keep playing audio normally
          },
          video: true,  // Chrome requires video for getDisplayMedia, we'll ignore it
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
        }).then(stream => {
          // Stop video track immediately — we only want audio
          stream.getVideoTracks().forEach(t => t.stop());

          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) return 'no audio tracks in tab capture';

          console.log('[hive-bridge] Tab self-capture audio: ' + audioTracks.length + ' tracks');
          console.log('[hive-bridge] Audio track settings: ' + JSON.stringify(audioTracks[0].getSettings()));
          bridge.startCapture(audioTracks[0]);
          return 'capturing tab audio (' + audioTracks.length + ' tracks)';
        }).catch(err => {
          console.log('[hive-bridge] Tab self-capture failed: ' + err.message);
          return 'tab capture failed: ' + err.message;
        });
      });

      log.info(`[voice] Audio capture result: ${result}`);
    } catch (e) {
      log.warn(`[voice] Tab audio capture setup failed: ${e.message}`);
    }
  }

  /**
   * Wait for meeting to be fully ready (past waiting room, into the meeting).
   * Polls every 3s until meeting toolbar appears or timeout.
   */
  async _waitForMeetingReady(timeoutMs = 60000) {
    const start = Date.now();
    const meetingSelectors = 'button[aria-label*="Mute"], button[aria-label*="unmute" i], [class*="footer__inner"], [class*="meeting-app"]';
    const waitingRoomSelectors = 'div:has-text("Please wait"), div:has-text("waiting room"), div:has-text("will let you in")';

    while (Date.now() - start < timeoutMs) {
      try {
        // Check if we're in the actual meeting
        const inMeeting = await this.page.locator(meetingSelectors).first().isVisible({ timeout: 1000 });
        if (inMeeting) {
          log.info('[voice] Meeting UI loaded — in the meeting');
          return true;
        }

        // Check if we're in a waiting room
        const inWaitingRoom = await this.page.locator(waitingRoomSelectors).first().isVisible({ timeout: 500 });
        if (inWaitingRoom) {
          log.info('[voice] In waiting room — waiting for host to admit...');
        }
      } catch (e) { /* selectors not found, keep waiting */ }

      await this.page.waitForTimeout(3000);
    }
    return false;
  }

  _extractMeetingId(url) {
    const match = url.match(/\/j\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Returns the init script injected into the page before any JS runs.
   * Intercepts getUserMedia, RTCPeerConnection, AND AudioContext.destination
   * to capture all meeting audio output.
   */
  _getAudioBridgeScript() {
    const bridgeUrl = this.audioBridgeUrl;
    return `
      (function() {
        window.__hiveBridge = {
          ws: null,
          audioContext: null,
          micStream: null,
          capturedTracks: [],
          chunksSent: 0,
          silentChunks: 0,

          init() {
            // Use default sample rate (48kHz) — downsample to 16kHz when sending
            this.audioContext = new AudioContext();
            this.ws = new WebSocket('${bridgeUrl}');
            this.ws.binaryType = 'arraybuffer';
            this.ws.onopen = () => console.log('[hive-bridge] Connected to audio bridge');
            this.ws.onclose = () => console.log('[hive-bridge] Audio bridge disconnected');
            this.ws.onerror = (e) => console.log('[hive-bridge] Audio bridge error');

            // Track all mic destinations and RTC senders for TTS playback
            this.micDests = [];     // all MediaStreamDestination nodes we've created
            this.audioSenders = []; // RTCPeerConnection audio senders (for replaceTrack)
            this._keepAlive = [];   // prevent GC of nodes

            console.log('[hive-bridge] Audio bridge initialized');
          },

          // Create a fresh mic stream for each getUserMedia call
          createMicStream() {
            const dest = this.audioContext.createMediaStreamDestination();
            // Keep alive with inaudible tone
            const osc = this.audioContext.createOscillator();
            osc.frequency.value = 0;
            const gain = this.audioContext.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            gain.connect(dest);
            osc.start();
            this.micDests.push(dest);
            this._keepAlive.push(osc, gain, dest);

            const track = dest.stream.getAudioTracks()[0];
            track.addEventListener('ended', () => {
              console.log('[hive-bridge] Mic track ended (dest #' + this.micDests.indexOf(dest) + ')');
            });
            console.log('[hive-bridge] Created mic stream #' + this.micDests.length + ' (track: ' + track.id + ')');
            return dest.stream;
          },

          // Play TTS audio into the mic stream (base64 PCM 16-bit 24kHz mono)
          async playAudio(b64Data) {
            if (!this.audioContext) {
              console.log('[hive-bridge] playAudio: no audioContext');
              return;
            }
            try {
              // Ensure AudioContext is running
              if (this.audioContext.state !== 'running') {
                await this.audioContext.resume();
              }

              const raw = atob(b64Data);
              const buffer = new Float32Array(raw.length / 2);
              for (let i = 0; i < buffer.length; i++) {
                const lo = raw.charCodeAt(i * 2);
                const hi = raw.charCodeAt(i * 2 + 1);
                let sample = (hi << 8) | lo;
                if (sample >= 0x8000) sample -= 0x10000;
                buffer[i] = sample / 32768.0;
              }
              const audioBuffer = this.audioContext.createBuffer(1, buffer.length, 24000);
              audioBuffer.getChannelData(0).set(buffer);
              const source = this.audioContext.createBufferSource();
              source.buffer = audioBuffer;

              // Route to ALL mic destinations (live or ended)
              let liveDests = 0;
              for (const dest of this.micDests) {
                const track = dest.stream.getAudioTracks()[0];
                if (track && track.readyState === 'live') {
                  source.connect(dest);
                  liveDests++;
                }
              }

              // Also connect to speakers — tab self-capture will pick this up
              source.connect(this.audioContext.destination);

              // If we have RTC audio senders, create a fresh track and replaceTrack
              if (this.audioSenders.length > 0 && liveDests === 0) {
                const ttsDest = this.audioContext.createMediaStreamDestination();
                source.connect(ttsDest);
                const ttsTrack = ttsDest.stream.getAudioTracks()[0];
                for (const sender of this.audioSenders) {
                  try {
                    await sender.replaceTrack(ttsTrack);
                    console.log('[hive-bridge] Replaced RTC sender track with TTS');
                  } catch(e) { console.log('[hive-bridge] replaceTrack failed: ' + e.message); }
                }
              }

              source.start();
              console.log('[hive-bridge] Playing TTS (' + buffer.length + ' samples, ' + (buffer.length / 24000).toFixed(1) + 's) — live mic dests: ' + liveDests + ', RTC senders: ' + this.audioSenders.length);
            } catch (e) {
              console.error('[hive-bridge] playAudio error:', e.message);
            }
          },

          // Capture audio from a processor node, downsample to 16kHz, send to WS bridge
          captureFromProcessor(processor, label) {
            const ctxRate = this.audioContext.sampleRate; // likely 48000
            const targetRate = 16000;
            const ratio = Math.round(ctxRate / targetRate); // 3 for 48k->16k
            console.log('[hive-bridge] Capture: ' + ctxRate + 'Hz -> ' + targetRate + 'Hz (ratio ' + ratio + ')');

            processor.onaudioprocess = (e) => {
              if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
              const data = e.inputBuffer.getChannelData(0);
              let maxAmp = 0;
              for (let i = 0; i < data.length; i++) {
                const abs = Math.abs(data[i]);
                if (abs > maxAmp) maxAmp = abs;
              }
              if (maxAmp < 0.001) {
                this.silentChunks++;
                return;
              }

              // Downsample by picking every Nth sample
              const outLen = Math.floor(data.length / ratio);
              const pcm16 = new Int16Array(outLen);
              for (let i = 0; i < outLen; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, data[i * ratio] * 32768));
              }
              this.ws.send(pcm16.buffer);
              this.chunksSent++;
              if (this.chunksSent === 1) console.log('[hive-bridge] First audio from ' + label + ' (amp: ' + maxAmp.toFixed(4) + ', samples: ' + outLen + ')');
              if (this.chunksSent % 200 === 0) console.log('[hive-bridge] Audio: ' + this.chunksSent + ' chunks, ' + this.silentChunks + ' silent');
            };
          },

          // Start capturing from an RTCPeerConnection remote track
          startCapture(track) {
            if (!this.audioContext || !this.ws) return;
            try {
              if (this.audioContext.state === 'suspended') {
                this.audioContext.resume().then(() => console.log('[hive-bridge] AudioContext resumed'));
              }
              const stream = new MediaStream([track]);
              const source = this.audioContext.createMediaStreamSource(stream);
              const processor = this.audioContext.createScriptProcessor(4096, 1, 1);
              this.captureFromProcessor(processor, 'rtc-track');
              source.connect(processor);
              processor.connect(this.audioContext.destination);
              this.capturedTracks.push({ track, source, processor });
              console.log('[hive-bridge] Capturing RTC audio track');
            } catch (e) {
              console.error('[hive-bridge] startCapture error:', e);
            }
          }
        };

        // Initialize bridge
        window.__hiveBridge.init();

        // --- Strategy 1: Intercept getUserMedia to route mic through BlackHole ---
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia.__original = origGetUserMedia;
        navigator.mediaDevices.getUserMedia = async function(constraints) {
          console.log('[hive-bridge] getUserMedia called:', JSON.stringify(constraints));

          // If requesting audio, try to use BlackHole as input device
          if (constraints && constraints.audio) {
            try {
              const devices = await navigator.mediaDevices.enumerateDevices();
              const blackhole = devices.find(d => d.kind === 'audioinput' && d.label.includes('BlackHole'));
              if (blackhole) {
                console.log('[hive-bridge] Found BlackHole: ' + blackhole.label + ' (id: ' + blackhole.deviceId + ')');
                // Override audio constraints to use BlackHole
                const audioConstraints = typeof constraints.audio === 'object' ? { ...constraints.audio } : {};
                audioConstraints.deviceId = { exact: blackhole.deviceId };
                // Disable echo cancellation and noise suppression for clean passthrough
                audioConstraints.echoCancellation = false;
                audioConstraints.noiseSuppression = false;
                audioConstraints.autoGainControl = false;
                constraints = { ...constraints, audio: audioConstraints };
                console.log('[hive-bridge] Using BlackHole for mic input');
              } else {
                console.log('[hive-bridge] BlackHole not found, using default mic');
              }
            } catch (e) {
              console.log('[hive-bridge] Device enumeration failed: ' + e.message);
            }
          }

          const stream = await origGetUserMedia(constraints);
          if (constraints && constraints.audio) {
            const tracks = stream.getAudioTracks();
            console.log('[hive-bridge] Mic stream: ' + tracks.length + ' tracks, label: ' + (tracks[0]?.label || 'none'));
          }
          return stream;
        };

        // --- Strategy 2: Intercept RTCPeerConnection for remote tracks AND local senders ---
        const OrigRTC = window.RTCPeerConnection;
        const origAddTrack = OrigRTC.prototype.addTrack;
        const origAddStream = OrigRTC.prototype.addStream;

        window.RTCPeerConnection = function(...args) {
          const pc = new OrigRTC(...args);
          console.log('[hive-bridge] RTCPeerConnection created');

          // Intercept remote tracks (for audio capture)
          pc.addEventListener('track', (event) => {
            console.log('[hive-bridge] RTC track event: kind=' + event.track.kind);
            if (event.track.kind === 'audio') {
              window.__hiveBridge.startCapture(event.track);
            }
          });

          // Intercept addTrack to capture audio senders
          const origPcAddTrack = pc.addTrack.bind(pc);
          pc.addTrack = function(track, ...streams) {
            const sender = origPcAddTrack(track, ...streams);
            console.log('[hive-bridge] RTC addTrack: kind=' + track.kind + ' readyState=' + track.readyState);
            if (track.kind === 'audio') {
              window.__hiveBridge.audioSenders.push(sender);
              console.log('[hive-bridge] Stored audio sender (total: ' + window.__hiveBridge.audioSenders.length + ')');
            }
            return sender;
          };

          return pc;
        };
        Object.keys(OrigRTC).forEach(k => { window.RTCPeerConnection[k] = OrigRTC[k]; });
        window.RTCPeerConnection.prototype = OrigRTC.prototype;

        // --- Strategy 3: Intercept AudioContext to tap all audio output ---
        // This catches audio regardless of whether it comes via WebRTC or WASM
        const OrigAudioContext = window.AudioContext;
        const OrigWebkitAudioContext = window.webkitAudioContext;
        function PatchedAudioContext(...args) {
          const ctx = new OrigAudioContext(...args);
          console.log('[hive-bridge] AudioContext created (sampleRate: ' + ctx.sampleRate + ')');

          // Monkey-patch the destination: intercept anything connecting to speakers
          const origConnect = AudioNode.prototype.connect;
          const destNode = ctx.destination;
          const bridge = window.__hiveBridge;

          // Create a capture node on this context
          let captureProcessor = null;
          try {
            captureProcessor = ctx.createScriptProcessor(4096, 1, 1);
            bridge.captureFromProcessor(captureProcessor, 'audio-dest');
            captureProcessor.connect(destNode);
          } catch(e) {
            console.log('[hive-bridge] Could not create capture processor:', e.message);
          }

          // Patch connect() to also route to our capture node
          AudioNode.prototype.connect = function(dest, ...rest) {
            const result = origConnect.call(this, dest, ...rest);
            // If connecting to speakers, also connect to our capture
            if (dest === destNode && captureProcessor && this !== captureProcessor) {
              try {
                origConnect.call(this, captureProcessor);
                console.log('[hive-bridge] Tapped audio node -> destination');
              } catch(e) { /* may fail for some node types */ }
            }
            return result;
          };

          return ctx;
        }
        PatchedAudioContext.prototype = OrigAudioContext.prototype;
        Object.keys(OrigAudioContext).forEach(k => { PatchedAudioContext[k] = OrigAudioContext[k]; });
        window.AudioContext = PatchedAudioContext;
        if (OrigWebkitAudioContext) window.webkitAudioContext = PatchedAudioContext;

        console.log('[hive-bridge] Audio hooks installed (3 strategies)');
      })();
    `;
  }
}

module.exports = MeetingJoiner;
