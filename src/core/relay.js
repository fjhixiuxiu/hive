const tmux = require('./tmux');

/**
 * Send a message to Claude in a session and wait for the response.
 *
 * @param {object} config - hive config
 * @param {string} sessionName - tmux session name
 * @param {string} message - message to send to Claude
 * @param {function} onProgress - called with status updates (optional)
 * @returns {Promise<{ success: boolean, response?: string, error?: string, duration?: number }>}
 */
async function ask(config, sessionName, message, onProgress) {
  const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
  const { pollInterval, cooldown, timeout } = config.relay;

  // Check if session is idle first
  const beforeContent = tmux.capturePane(paneTarget, { lines: 3 });
  const currentState = tmux.detectState(beforeContent, config);
  if (currentState === 'working') {
    return { success: false, error: 'Session is busy. Use /peek to see what it\'s doing.' };
  }
  if (currentState === 'off') {
    return { success: false, error: 'Claude is not running in this session.' };
  }

  // Snapshot before: capture full visible pane as baseline
  const before = tmux.capturePane(paneTarget, { lines: 200 });
  const beforeLines = before.split('\n').length;

  // Send the message
  tmux.sendKeys(paneTarget, message, true);
  const startTime = Date.now();

  if (onProgress) onProgress('Message sent, waiting for response...');

  // Poll for idle
  return new Promise((resolve) => {
    let idleDetectedAt = null;

    const timer = setInterval(() => {
      const elapsed = Date.now() - startTime;

      // Timeout
      if (elapsed > timeout) {
        clearInterval(timer);
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

      if (state === 'idle') {
        if (!idleDetectedAt) {
          // First idle detection — start cooldown to make sure Claude is really done
          // (Claude can go briefly idle between tool calls)
          idleDetectedAt = Date.now();
          return;
        }

        // Check if cooldown has passed
        if (Date.now() - idleDetectedAt >= cooldown) {
          clearInterval(timer);

          // Capture the response
          const after = tmux.capturePane(paneTarget, { lines: 200 });
          const afterLines = after.split('\n');

          // Extract new content (everything after baseline)
          const newContent = afterLines
            .slice(Math.max(0, beforeLines - 5)) // overlap a bit for safety
            .map(l => l.replace(/[^\x20-\x7E]/g, '').trimEnd())
            .filter(l => l)
            .join('\n');

          // Trim to just Claude's response (remove the echoed input and idle prompt)
          const response = cleanResponse(newContent, message, config);

          resolve({
            success: true,
            response: response || '(empty response)',
            duration: Date.now() - startTime,
          });
        }
      } else {
        // Reset cooldown if Claude starts working again
        idleDetectedAt = null;
      }
    }, pollInterval);
  });
}

/**
 * Send a message to Claude without waiting for response (fire-and-forget).
 */
function tell(config, sessionName, message) {
  const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
  const beforeContent = tmux.capturePane(paneTarget, { lines: 3 });
  const state = tmux.detectState(beforeContent, config);

  if (state === 'off') {
    return { success: false, error: 'Claude is not running in this session.' };
  }

  tmux.sendKeys(paneTarget, message, true);
  return { success: true };
}

/**
 * Clean up the response: remove echoed input, prompt artifacts, status lines.
 */
function cleanResponse(raw, sentMessage, config) {
  const lines = raw.split('\n');

  // Remove lines that are just the echoed input
  const filtered = lines.filter(l => {
    const clean = l.trim();
    if (clean === sentMessage.trim()) return false;
    // Remove idle prompt indicators
    for (const pat of config.idlePatterns) {
      if (pat.test(clean)) return false;
    }
    // Remove status line artifacts
    if (/^(CI|PR|JIRA)\s/.test(clean)) return false;
    if (/bypass permissions/.test(clean)) return false;
    if (/-- INSERT --/.test(clean)) return false;
    return true;
  });

  return filtered.join('\n').trim();
}

module.exports = { ask, tell };
