const tmux = require('./tmux');
const log = require('./log');

/**
 * Capture the visible pane and extract Claude's response content,
 * stripping TUI chrome (status bars, prompts, etc).
 */
async function captureResponse(node, paneTarget, config) {
  const content = await node.capturePane(paneTarget);
  return tmux.stripTUIChrome(content, config);
}

/**
 * Vim-safe clear of the Claude Code TUI input box.
 * Escape → gg dG → i  (delete entire buffer, return to insert mode).
 *
 * Necessary because we cannot trust "session idle" to mean "input box empty":
 * a previous paste may have failed mid-Enter and left text in the input,
 * or the user may have typed something via the dashboard and walked away.
 * Pasting on top of stale content concatenates and submits garbage.
 */
async function clearInputVim(node, paneTarget) {
  await node.exec(`tmux send-keys -t "${paneTarget}" Escape`);
  await new Promise(r => setTimeout(r, 250));
  await node.exec(`tmux send-keys -t "${paneTarget}" g g d G`);
  await new Promise(r => setTimeout(r, 150));
  await node.exec(`tmux send-keys -t "${paneTarget}" i`);
  await new Promise(r => setTimeout(r, 250));
}

/**
 * Non-vim (readline) clear: home + kill-to-eol. Only handles single-line
 * input, which is all the non-vim Claude Code TUI exposes today.
 */
async function clearInputReadline(node, paneTarget) {
  await node.exec(`tmux send-keys -t "${paneTarget}" C-a`);
  await node.exec(`tmux send-keys -t "${paneTarget}" C-k`);
}

async function clearInput(node, paneTarget, vimMode) {
  if (vimMode) await clearInputVim(node, paneTarget);
  else await clearInputReadline(node, paneTarget);
}

/**
 * After a paste, verify the message actually landed in the input box.
 * Claude Code's TUI condenses large/multi-line pastes to "[Pasted text #N +M lines]"
 * — short single-line pastes appear verbatim. Returns true if either pattern
 * is present in the visible pane.
 */
async function verifyPasteLanded(node, paneTarget, message) {
  const cleaned = (message || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return true;
  const visible = await node.capturePane(paneTarget, { lines: 30 });
  if (!visible) return false;
  const isShortSingleLine = !cleaned.includes('\n') && cleaned.length <= 120;
  if (isShortSingleLine) {
    return visible.includes(cleaned);
  }
  // Long or multi-line: prefer placeholder match (TUI usually condenses).
  if (/\[Pasted text #\d+/.test(visible)) return true;
  // Suffix fallback for the cases where the TUI didn't condense.
  return visible.includes(cleaned.slice(-40));
}

/**
 * Clear → paste → verify (retry once if it looks missed) → return.
 *
 * Verification is ADVISORY: capturing the pane right after a paste-buffer
 * flush often races the TUI's repaint, so a "miss" doesn't mean the paste
 * failed — only that we couldn't see it yet. We log on miss and retry once,
 * but the caller MUST still send Enter regardless. Skipping Enter on a
 * false-positive miss was a regression worse than the original race
 * (Slack messages never reached agents because Enter was withheld).
 *
 * Hard failure is reserved for sendKeys errors (genuine tmux failure).
 */
async function pasteWithVerify(node, paneTarget, message, vimMode) {
  // Generous post-paste dwell. The TUI needs to render either the inline
  // text or the "[Pasted text #N +M lines]" placeholder before our capture
  // can see it. Under load this can take 600-900ms.
  const POST_PASTE_DWELL_MS = vimMode ? 800 : 500;

  try {
    await node.sendKeys(paneTarget, message, false);
  } catch (err) {
    return { ok: false, error: `Failed to send message: ${err.message}` };
  }
  await new Promise(r => setTimeout(r, POST_PASTE_DWELL_MS));

  if (await verifyPasteLanded(node, paneTarget, message)) {
    return { ok: true };
  }

  // Possible miss — re-clear and re-paste once. If the original paste
  // actually succeeded, the re-clear wipes it and the second paste is the
  // one that lands. Either way the Enter the caller sends will submit
  // exactly one message.
  log.warn(`[relay] paste verification missed on ${paneTarget}, retrying once`);
  await clearInput(node, paneTarget, vimMode);
  try {
    await node.sendKeys(paneTarget, message, false);
  } catch (err) {
    return { ok: false, error: `Failed to send message on retry: ${err.message}` };
  }
  await new Promise(r => setTimeout(r, POST_PASTE_DWELL_MS));

  if (!await verifyPasteLanded(node, paneTarget, message)) {
    log.warn(`[relay] paste verification still missing on ${paneTarget} after retry — sending Enter anyway (advisory)`);
  }
  return { ok: true };
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

  await clearInput(node, paneTarget, vimMode);

  const paste = await pasteWithVerify(node, paneTarget, message, vimMode);
  if (!paste.ok) {
    return { success: false, error: paste.error };
  }

  await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
  if (message && message.includes('\n')) {
    // Safety second Enter for multi-line — TUI sometimes swallows the first
    // while still rendering pasted content.
    await new Promise(r => setTimeout(r, 300));
    await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
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

  await clearInput(node, paneTarget, vimMode);

  const paste = await pasteWithVerify(node, paneTarget, message, vimMode);
  if (!paste.ok) {
    return { success: false, error: paste.error };
  }

  await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
  if (message && message.includes('\n')) {
    await new Promise(r => setTimeout(r, 300));
    await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
  }
  return { success: true };
}

module.exports = { ask, tell };
