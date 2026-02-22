const tmux = require('./tmux');

/**
 * Capture the visible pane and extract Claude's response content,
 * stripping TUI chrome (status bars, prompts, etc).
 */
function captureResponse(paneTarget, config) {
  const content = tmux.capturePane(paneTarget);
  return tmux.stripTUIChrome(content, config);
}

/**
 * Send a message to Claude in a session and wait for the response.
 *
 * @param {object} config - hive config
 * @param {string} sessionName - tmux session name
 * @param {string} message - message to send to Claude
 * @param {object} callbacks
 * @param {function} callbacks.onProgress - called with status strings
 * @param {function} callbacks.onStream - called with current response content periodically
 * @returns {Promise<{ success: boolean, response?: string, error?: string, duration?: number }>}
 */
async function ask(config, sessionName, message, callbacks = {}) {
  const { onProgress, onStream } = typeof callbacks === 'function'
    ? { onProgress: callbacks } // backward compat: single function = onProgress
    : callbacks;

  const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
  const { pollInterval, cooldown, timeout } = config.relay;
  const streamInterval = config.relay.streamInterval || 3000;

  // Check if session is idle first
  const beforeContent = tmux.capturePane(paneTarget, { lines: 3 });
  const currentState = tmux.detectState(beforeContent, config);
  if (currentState === 'working') {
    return { success: false, error: 'Session is busy. Use /peek to see what it\'s doing.' };
  }
  if (currentState === 'off') {
    return { success: false, error: 'Claude is not running in this session.' };
  }

  // Ensure Claude's TUI is in INSERT mode:
  // 1. Escape clears any partial input / exits current mode
  // 2. 'i' re-enters INSERT mode so keystrokes become text input
  tmux.exec(`tmux send-keys -t "${paneTarget}" Escape`);
  await new Promise(r => setTimeout(r, 150));
  tmux.exec(`tmux send-keys -t "${paneTarget}" i`);
  await new Promise(r => setTimeout(r, 100));

  // Send the message
  tmux.sendKeys(paneTarget, message, true);
  const startTime = Date.now();

  if (onProgress) onProgress('Message sent, waiting for response...');

  // Poll for idle + stream updates
  return new Promise((resolve) => {
    let idleDetectedAt = null;
    let lastStreamAt = 0;
    let lastStreamContent = '';

    const timer = setInterval(() => {
      const elapsed = Date.now() - startTime;

      // Timeout
      if (elapsed > timeout) {
        clearInterval(timer);
        if (onStream) {
          const content = captureResponse(paneTarget, config);
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
      const tail = tmux.capturePane(paneTarget, { lines: 3 });
      const state = tmux.detectState(tail, config);

      // Stream update if enough time has passed
      if (onStream && state === 'working' && (Date.now() - lastStreamAt >= streamInterval)) {
        const content = captureResponse(paneTarget, config);
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

          const response = captureResponse(paneTarget, config);

          resolve({
            success: true,
            response: response || '(empty response)',
            duration: Date.now() - startTime,
          });
        }
      } else {
        idleDetectedAt = null;
      }
    }, pollInterval);
  });
}

/**
 * Send a message to Claude without waiting for response (fire-and-forget).
 */
async function tell(config, sessionName, message) {
  const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
  const beforeContent = tmux.capturePane(paneTarget, { lines: 3 });
  const state = tmux.detectState(beforeContent, config);

  if (state === 'off') {
    return { success: false, error: 'Claude is not running in this session.' };
  }

  // Ensure Claude's TUI is in INSERT mode
  tmux.exec(`tmux send-keys -t "${paneTarget}" Escape`);
  await new Promise(r => setTimeout(r, 150));
  tmux.exec(`tmux send-keys -t "${paneTarget}" i`);
  await new Promise(r => setTimeout(r, 100));

  tmux.sendKeys(paneTarget, message, true);
  return { success: true };
}

module.exports = { ask, tell };
