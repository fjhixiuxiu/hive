const tmux = require('./tmux');
const log = require('./log');
const { SessionState } = require('./vocab');

const BLOCKED_ERROR =
  'Claude Code is waiting on a startup dialog (folder trust or permissions mode) that only a ' +
  'person may answer. hive sends it nothing — open the session and choose.';

/** argv[0] basename, with a login shell's leading "-" removed. */
function argv0(args) {
  return String(args || '')
    .trim()
    .split(/\s+/)[0]
    .split('/')
    .pop()
    .replace(/^-/, '');
}

/**
 * Whether a `ps -o args=` line is Claude Code itself.
 *
 * Matched on argv, not on `comm`, and that is the whole point. `comm` for
 * Claude Code is its own version string — measured on this fleet:
 *
 *   tmux display-message '#{pane_current_command}'  →  2.1.270 / 2.1.274
 *   …and 2.1.278 on 2026-09-22, two releases later.
 *
 * A value that changes every release cannot be allowlisted — it moved twice
 * while this guard was in review. Worse, a Claude
 * launched through node reports `comm` as "node", which is byte-identical to a
 * bare `node` REPL — and a REPL evaluates pasted text as JavaScript, the same
 * hole in a different interpreter. argv separates them: Claude carries its
 * entry point, a REPL carries nothing.
 *
 * Two launch shapes are accepted: the wrapper on PATH (`claude`,
 * `/usr/local/bin/claude --continue`) and a JS runtime running Claude's own
 * entry point (`node …/@anthropic-ai/claude-code/cli.js`). A runtime with no
 * Claude path in its arguments is refused on purpose.
 */
function isClaudeArgv(args) {
  const argv = String(args || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!argv.length) return false;
  if (argv0(argv[0]) === 'claude') return true;
  if (!/^(node|bun|deno)$/.test(argv0(argv[0]))) return false;
  return argv.slice(1).some((a) => /(^|\/)(@anthropic-ai\/)?claude(-code)?(\/|$)/.test(a));
}

/**
 * Name what the pane is running when it is NOT Claude Code, or null when it is
 * safe to type.
 *
 * detectState reads pixels, and pixels lie: a Claude that exited leaves its
 * last screen behind, and that screen can look idle. Pasting task text into a
 * shell runs it — bash 3.2 has no bracketed paste, so every newline executes
 * as it arrives, and backticks or $(...) in the text run too. This asks the OS
 * what owns the keyboard instead of what the pane looks like.
 *
 * ⚠️ This is an allowlist, and it has to be. The first version of this guard
 * asked "is the foreground program one of 13 known shells?", which trusts
 * everything it failed to predict. Two holes were measured on a real tmux:
 *
 *   1. A shell running a job does not report as a shell. `pane_current_command`
 *      is the foreground process-GROUP leader, so `zsh` running `sleep 30 | cat`
 *      reports "sleep". Not in the shell list → the paste was allowed, and it
 *      lands in the shell's stdin to run when the job exits.
 *   2. A bare `node` REPL reports exactly "node", which is what Claude reported
 *      too. Indistinguishable, and pasted text is evaluated as JavaScript.
 *
 * Neither needed a new list entry to fix, because "is this Claude?" has one
 * right answer and "is this dangerous?" has an open-ended list of wrong ones.
 * The same inversion covers ssh (types into a REMOTE shell), vim and less
 * (`:!`, `!`), python/psql/irb, and shells nobody listed (ash, oksh, yash).
 *
 * Claude must be PRESENT in the foreground group, not alone in it: MCP servers
 * share that group. Measured on a live session —
 *
 *   Ss   zsh --login              ← not foreground
 *   S+   claude                   ← Claude
 *   S+   node …/mcp-server/index.mjs --hive-url … --session 13
 *   S+   npm exec @playwright/mcp@0.0.55
 *
 * Silence is not consent. When tmux names the pane but `ps` yields no argv,
 * Claude cannot be confirmed, and "unknown" is not a yes — the pane is refused
 * and named as unidentified. An earlier revision fell back to "is the name one
 * of 13 known shells?" here, which reintroduced the denylist this function
 * exists to replace, in the one spot where evidence is weakest.
 *
 * The cost of that strictness was measured before it was chosen — 2026-09-22,
 * across all 42 panes of the live fleet, `ps -o stat=,args= -t <tty>` returned
 * foreground rows for every one. Nothing reaches this branch today, so the
 * choice only governs the day `ps` breaks, and a dispatch that stops with a
 * named reason beats one that types into a program nobody identified.
 *
 * The one thing still trusted is an unanswered `display-message`: no reply at
 * all means tmux itself is unreachable, which is a node-level fault rather
 * than evidence about this pane.
 */
async function nonClaudeProgram(node, paneTarget) {
  const out = await node.exec(
    `tmux display-message -p -t "${paneTarget}" '#{pane_current_command}|#{pane_tty}' 2>/dev/null`,
  );
  if (!out) return null;
  const [command, tty] = String(out).trim().split('|');
  // No tty, or a `ps` that answered nothing: argv is unavailable, so Claude
  // cannot be confirmed and the pane is refused under whatever name we have.
  const unconfirmed = () => String(command).trim() || 'an unidentified program';
  if (!tty) return unconfirmed();
  const ps = await node.exec(`ps -o stat=,args= -t ${tty.replace(/^\/dev\//, '')} 2>/dev/null`);
  const foreground = String(ps || '')
    .split('\n')
    .map((line) => line.trim().match(/^(\S+)\s+(.+)$/))
    .filter((m) => m && m[1].includes('+'))
    .map((m) => m[2]);
  if (!foreground.length) return unconfirmed();
  if (foreground.some(isClaudeArgv)) return null;
  // Prefer tmux's own name for the pane; fall back to the first foreground argv.
  return String(command).trim() || argv0(foreground[0]);
}

/**
 * Refuse to type into a pane that is not safely Claude's prompt. Returns the
 * failure result, or null when it is safe to send keys.
 */
async function refusal(node, paneTarget, state) {
  if (state === SessionState.BLOCKED) {
    log.warn(`[relay] refusing to type into ${paneTarget}: Claude Code startup dialog`);
    return { success: false, refused: 'blocked', error: BLOCKED_ERROR };
  }
  const program = await nonClaudeProgram(node, paneTarget);
  if (program) {
    log.warn(`[relay] refusing to paste into ${paneTarget}: foreground process is ${program}`);
    return {
      success: false,
      refused: 'not-claude',
      // Deliberately does not predict what the text would DO. Saying "it would
      // run as shell commands" requires knowing the program is a shell, which
      // is the question this guard refuses to ask.
      error:
        `Refusing to paste: the Claude pane is running ${program}, not Claude Code. ` +
        'Open the session to see what is there.',
    };
  }
  return null;
}

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
  await new Promise((r) => setTimeout(r, 250));
  await node.exec(`tmux send-keys -t "${paneTarget}" g g d G`);
  await new Promise((r) => setTimeout(r, 150));
  await node.exec(`tmux send-keys -t "${paneTarget}" i`);
  await new Promise((r) => setTimeout(r, 250));
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
 * Paste → poll-verify (no retry) → return.
 *
 * Verification is ADVISORY: capturing the pane right after a paste-buffer
 * flush often races the TUI's repaint, so a "miss" doesn't mean the paste
 * failed — only that we couldn't see it yet. We poll the pane up to
 * VERIFY_DEADLINE_MS to give the repaint time to catch up; if we never see
 * the message, we log and send Enter anyway. Skipping Enter on a
 * false-positive miss is strictly worse than the visible-paste race
 * (Slack messages never reached agents because Enter was withheld).
 *
 * No retry path: the prior re-clear+re-paste retry deterministically
 * doubled multi-line content when clearInputReadline (used outside vim
 * mode) couldn't wipe a multi-line buffer — the retry paste appended
 * onto leftover lines. Observed on dashboard manual input, Slack
 * auto-relay, slack-poll fallback, and task-dispatch paths alike.
 *
 * Hard failure is reserved for sendKeys errors (genuine tmux failure).
 */
async function pasteWithVerify(node, paneTarget, message, vimMode) {
  // Initial dwell then poll-verify. Under load the TUI can take 600-900ms
  // to render the inline text or "[Pasted text #N +M lines]" placeholder.
  const INITIAL_DWELL_MS = vimMode ? 800 : 500;
  const VERIFY_DEADLINE_MS = 2000;
  const VERIFY_POLL_MS = 200;

  try {
    await node.sendKeys(paneTarget, message, false);
  } catch (err) {
    return { ok: false, error: `Failed to send message: ${err.message}` };
  }
  await new Promise((r) => setTimeout(r, INITIAL_DWELL_MS));

  if (await verifyPasteLanded(node, paneTarget, message)) {
    return { ok: true };
  }

  const pollStart = Date.now();
  while (Date.now() - pollStart < VERIFY_DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
    if (await verifyPasteLanded(node, paneTarget, message)) {
      return { ok: true };
    }
  }

  log.warn(
    `[relay] paste verification missed on ${paneTarget} after ${INITIAL_DWELL_MS + VERIFY_DEADLINE_MS}ms — sending Enter anyway (advisory, no retry)`,
  );
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
  const { onProgress, onStream, vimMode, force } =
    typeof callbacks === 'function'
      ? { onProgress: callbacks } // backward compat: single function = onProgress
      : callbacks;

  const paneTarget = tmux.paneTarget(sessionName, config.sessions.claudePane);
  const { pollInterval, cooldown, timeout } = config.relay;
  const streamInterval = config.relay.streamInterval || 3000;

  // Always reject when Claude isn't running. force=true is meant to bypass the
  // "session is busy" guard (manual input that wants to interrupt a working
  // turn), NOT the "no TUI" guard. Skipping the 'off' check let the vim-mode
  // clear sequence (Escape → gg dG → i) land in a bash prompt as literal
  // "gdGi" before whatever the user typed next.
  const beforeContent = await node.capturePane(paneTarget, { lines: 3 });
  const currentState = tmux.detectState(beforeContent, config);
  if (currentState === SessionState.OFF) {
    return { success: false, error: 'Claude is not running in this session.' };
  }
  if (currentState === SessionState.WORKING && !force) {
    return { success: false, error: "Session is busy. Use /peek to see what it's doing." };
  }
  // Like 'off', neither guard is bypassed by force: a keystroke into a startup
  // dialog or a shell is never what manual input meant.
  const refused = await refusal(node, paneTarget, currentState);
  if (refused) return refused;

  await clearInput(node, paneTarget, vimMode);

  const paste = await pasteWithVerify(node, paneTarget, message, vimMode);
  if (!paste.ok) {
    return { success: false, error: paste.error };
  }

  await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
  if (message && message.includes('\n')) {
    // Safety second Enter for multi-line — TUI sometimes swallows the first
    // while still rendering pasted content.
    await new Promise((r) => setTimeout(r, 300));
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
          // Past the Enter: the message is in the session, only the reply is
          // missing. Every failure returned before the Enter never reached it.
          resolve({
            success: false,
            delivered: true,
            error: `Timed out after ${Math.round(timeout / 1000)}s. Claude may still be working. Use /peek to check.`,
            duration: elapsed,
          });
          return;
        }

        // Check state
        const tail = await node.capturePane(paneTarget, { lines: 3 });
        const state = tmux.detectState(tail, config);

        // Stream update if enough time has passed
        if (
          onStream &&
          state === SessionState.WORKING &&
          Date.now() - lastStreamAt >= streamInterval
        ) {
          const content = await captureResponse(node, paneTarget, config);
          if (content && content !== lastStreamContent) {
            lastStreamContent = content;
            lastStreamAt = Date.now();
            onStream(content, false);
          }
        }

        if (state === SessionState.IDLE) {
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
  const paneTarget = tmux.paneTarget(sessionName, config.sessions.claudePane);

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
    if (state === SessionState.OFF) {
      return { success: false, error: 'Claude is not running in this session.' };
    }
    // A startup dialog does not settle on its own. Waiting out the budget and
    // pasting anyway would answer it with the message's Enter.
    if (state === SessionState.BLOCKED) return refusal(node, paneTarget, state);
    if (state === SessionState.IDLE) {
      if (!sawWorking) break; // idle from the start → no settle needed
      if (++consecutiveIdle >= 2) break; // 2 consecutive idle reads → settled
    } else {
      sawWorking = true;
      consecutiveIdle = 0;
    }
    if (Date.now() - startedAt >= TELL_IDLE_BUDGET_MS) break; // budget out, paste anyway
    await new Promise((r) => setTimeout(r, TELL_IDLE_POLL_MS));
  }

  // Checked after the settle loop, immediately before the first keystroke, so
  // a Claude that exited while we waited is caught.
  const refused = await refusal(node, paneTarget, null);
  if (refused) return refused;

  await clearInput(node, paneTarget, vimMode);

  const paste = await pasteWithVerify(node, paneTarget, message, vimMode);
  if (!paste.ok) {
    return { success: false, error: paste.error };
  }

  await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
  if (message && message.includes('\n')) {
    await new Promise((r) => setTimeout(r, 300));
    await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
  }
  return { success: true };
}

module.exports = { ask, tell, nonClaudeProgram, isClaudeArgv };
