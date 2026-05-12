const tmux = require('./tmux');

/**
 * Capture the visible pane and extract Claude's response content,
 * stripping TUI chrome (status bars, prompts, etc).
 */
async function captureResponse(node, paneTarget, config) {
  const content = await node.capturePane(paneTarget);
  return tmux.stripTUIChrome(content, config);
}

/**
 * Send a message to Claude in a session and wait for the response.
 *
 * @param {object} config - hive config
 * @param {Node} node - execution node
 * @param {string} sessionName - tmux session name
 * @param {string} message - message to send to Claude
 * @param {object} callbacks
 * @param {function} callbacks.onProgress - called with status strings
 * @param {function} callbacks.onStream - called with current response content periodically
 * @returns {Promise<{ success: boolean, response?: string, error?: string, duration?: number }>}
 */
async function ask(config, node, sessionName, message, callbacks = {}) {
  const { onProgress, onStream, vimMode, force } = typeof callbacks === 'function'
    ? { onProgress: callbacks } // backward compat: single function = onProgress
    : callbacks;

  const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
  const { pollInterval, cooldown, timeout } = config.relay;
  const streamInterval = config.relay.streamInterval || 3000;

  // Check if session is idle first (skip entirely for manual user input via force=true,
  // since the user can see the session state in the UI and chose to send anyway)
  if (!force) {
    const beforeContent = await node.capturePane(paneTarget, { lines: 3 });
    const currentState = tmux.detectState(beforeContent, config);
    if (currentState === 'working') {
      return { success: false, error: 'Session is busy. Use /peek to see what it\'s doing.' };
    }
    if (currentState === 'off') {
      return { success: false, error: 'Claude is not running in this session.' };
    }
  }

  // Ensure Claude's TUI is in INSERT mode (only needed for vim-mode terminals).
  // Dwells must be generous: under TUI render load the mode switch can take
  // 150-300ms, and if `i` lands in normal mode the subsequent paste is
  // interpreted as motion keys → empty submit. 300ms each side is the floor
  // we've seen reliable.
  if (vimMode) {
    await node.exec(`tmux send-keys -t "${paneTarget}" Escape`);
    await new Promise(r => setTimeout(r, 300));
    await node.exec(`tmux send-keys -t "${paneTarget}" i`);
    await new Promise(r => setTimeout(r, 300));
  } else {
    // Clear any existing input before pasting (readline: home, kill-to-eol).
    // NOT safe in vim insert mode: C-a re-inserts last text, C-k starts a
    // digraph. We skip it under vimMode and rely on the prior idle wait
    // having left the input box empty.
    await node.exec(`tmux send-keys -t "${paneTarget}" C-a`);
    await node.exec(`tmux send-keys -t "${paneTarget}" C-k`);
  }

  // Send the message. In vim mode, decouple paste from Enter so we can dwell
  // between them — paste-buffer returns when tmux hands bytes to the pane,
  // not when the TUI has parsed them, so a too-fast Enter can submit empty.
  try {
    if (vimMode) {
      await node.sendKeys(paneTarget, message, false);
      await new Promise(r => setTimeout(r, 200));
      await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
      if (message && message.includes('\n')) {
        await new Promise(r => setTimeout(r, 300));
        await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
      }
    } else {
      await node.sendKeys(paneTarget, message, true);
    }
  } catch (err) {
    return { success: false, error: `Failed to send message: ${err.message}` };
  }
  const startTime = Date.now();

  if (onProgress) onProgress('Message sent, waiting for response...');

  // Poll for idle + stream updates
  return new Promise((resolve) => {
    let idleDetectedAt = null;
    let lastStreamAt = 0;
    let lastStreamContent = '';
    let polling = false;

    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;

      try {
        const elapsed = Date.now() - startTime;

        // Timeout
        if (elapsed > timeout) {
          clearInterval(timer);
          if (onStream) {
            const content = await captureResponse(node, paneTarget, config);
            if (content) onStream(content, true);
          }
          resolve({
            success: false,
            error: `Timed out after ${Math.round(timeout / 1000)}s. Claude may still be working. Use /peek to check.`,
            duration: elapsed,
          });
          return;
        }

        // Check state
        const tail = await node.capturePane(paneTarget, { lines: 3 });
        const state = tmux.detectState(tail, config);

        // Stream update if enough time has passed
        if (onStream && state === 'working' && (Date.now() - lastStreamAt >= streamInterval)) {
          const content = await captureResponse(node, paneTarget, config);
          if (content && content !== lastStreamContent) {
            lastStreamContent = content;
            lastStreamAt = Date.now();
            onStream(content, false);
          }
        }

        if (state === 'idle') {
          if (!idleDetectedAt) {
            idleDetectedAt = Date.now();
            return;
          }

          if (Date.now() - idleDetectedAt >= cooldown) {
            clearInterval(timer);

            const response = await captureResponse(node, paneTarget, config);

            resolve({
              success: true,
              response: response || '(empty response)',
              duration: Date.now() - startTime,
            });
          }
        } else {
          idleDetectedAt = null;
        }
      } finally {
        polling = false;
      }
    }, pollInterval);
  });
}

/**
 * Send a message to Claude without waiting for response (fire-and-forget).
 * @param {object} config
 * @param {Node} node - execution node
 * @param {string} sessionName
 * @param {string} message
 */
async function tell(config, node, sessionName, message, { vimMode } = {}) {
  const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;

  // Wait for the session to settle before pasting. Avoids the race where the
  // session is mid-turn (e.g. processing /clear) and our paste lands in the
  // input that gets submitted right after the turn finishes. detectState can
  // be wrong/unreliable, so after a 30s budget we paste anyway rather than
  // drop the message — late delivery beats silent loss.
  const TELL_IDLE_BUDGET_MS = 30000;
  const TELL_IDLE_POLL_MS = 2000;
  const startedAt = Date.now();
  let sawWorking = false;
  let consecutiveIdle = 0;
  while (true) {
    const tail = await node.capturePane(paneTarget, { lines: 3 });
    const state = tmux.detectState(tail, config);
    if (state === 'off') {
      return { success: false, error: 'Claude is not running in this session.' };
    }
    if (state === 'idle') {
      if (!sawWorking) break;             // idle from the start → no settle needed
      if (++consecutiveIdle >= 2) break;  // 2 consecutive idle reads → settled
    } else {
      sawWorking = true;
      consecutiveIdle = 0;
    }
    if (Date.now() - startedAt >= TELL_IDLE_BUDGET_MS) break; // budget out, paste anyway
    await new Promise(r => setTimeout(r, TELL_IDLE_POLL_MS));
  }

  // Ensure Claude's TUI is in INSERT mode (only needed for vim-mode terminals).
  // See ask() for full reasoning on dwell sizing.
  if (vimMode) {
    await node.exec(`tmux send-keys -t "${paneTarget}" Escape`);
    await new Promise(r => setTimeout(r, 300));
    await node.exec(`tmux send-keys -t "${paneTarget}" i`);
    await new Promise(r => setTimeout(r, 300));
  } else {
    // Readline-style clear; not safe in vim insert mode (see ask()).
    await node.exec(`tmux send-keys -t "${paneTarget}" C-a`);
    await node.exec(`tmux send-keys -t "${paneTarget}" C-k`);
  }

  try {
    await node.sendKeys(paneTarget, message, false);
  } catch (err) {
    return { success: false, error: `Failed to send message: ${err.message}` };
  }
  const isMultiLine = message && message.includes('\n');
  // Pre-Enter dwell: TUI parse latency is ~150-200ms after a paste-buffer flush.
  // Vim-mode single-line needs the dwell too — paste-buffer return ≠ parse done.
  await new Promise(r => setTimeout(r, isMultiLine ? 250 : (vimMode ? 200 : 100)));
  await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
  // Safety: second Enter for multi-line pastes (TUI can swallow the first)
  if (isMultiLine) {
    await new Promise(r => setTimeout(r, 300));
    await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
  }
  return { success: true };
}

module.exports = { ask, tell };
