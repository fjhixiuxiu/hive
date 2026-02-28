const { exec: cpExec } = require('child_process');
const { promisify } = require('util');
const { writeFileSync, unlinkSync } = require('fs');
const execAsync = promisify(cpExec);

/**
 * Execute a command asynchronously and return trimmed stdout, or null on failure.
 */
async function exec(cmd, opts = {}) {
  try {
    const { stdout } = await execAsync(cmd, { encoding: 'utf8', timeout: 10000, ...opts });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * List all tmux sessions, returns array of session name strings.
 */
async function listSessions() {
  // Use list-windows to get window_activity (last output time), which is more
  // accurate than session_activity (last input time)
  const out = await exec("tmux list-windows -a -F '#{session_name}|#{window_activity}' 2>/dev/null");
  if (!out) return [];
  // Sessions with multiple windows: take the most recent window_activity
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, ts] = line.split('|');
    const ms = ts ? parseInt(ts) * 1000 : null;
    const prev = map.get(name);
    if (!prev || (ms && (!prev.lastActivity || ms > prev.lastActivity))) {
      map.set(name, { name, lastActivity: ms });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const na = parseInt(a.name), nb = parseInt(b.name);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Capture pane content.
 * @param {string} target - tmux target (e.g. "6-branch:.1")
 * @param {object} opts
 * @param {number} opts.lines - number of scrollback lines (default: visible only)
 */
async function capturePane(target, { lines } = {}) {
  const scrollback = lines ? `-S -${lines}` : '';
  const out = await exec(`tmux capture-pane -t "${target}" -p ${scrollback} 2>/dev/null`);
  return out || '';
}

/**
 * Send keys to a tmux pane.
 * @param {string} target - tmux target
 * @param {string} keys - text to send
 * @param {boolean} enter - whether to press Enter after
 */
async function sendKeys(target, keys, enter = true) {
  // Normalize line endings, preserve newlines (paste-buffer handles them natively)
  const cleaned = keys.replace(/\r\n/g, '\n').trim();
  if (!cleaned && !enter) return;

  if (cleaned) {
    // Write to temp file + tmux load-buffer/paste-buffer to avoid all shell
    // escaping issues with quotes, backticks, $, !, etc.
    const tmpFile = `/tmp/hive-sendkeys-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpFile, cleaned, 'utf8');
      const r = await exec(`tmux load-buffer "${tmpFile}" && tmux paste-buffer -t "${target}" -d`);
      if (r === null) {
        throw new Error(`tmux paste failed for target=${target}, len=${cleaned.length}`);
      }
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }
  if (enter) {
    await exec(`tmux send-keys -t "${target}" Enter`);
  }
}

/**
 * Check if a tmux session exists.
 */
async function hasSession(name) {
  return (await exec(`tmux has-session -t "${name}" 2>/dev/null`)) !== null;
}

/**
 * Check if a line is a Claude Code TUI separator (─ repeated across the pane).
 */
function isSeparator(line) {
  const trimmed = line.trim();
  return trimmed.length >= 10 && /^[─━]+$/.test(trimmed);
}

/**
 * Detect Claude's state from a pane capture.
 *
 * Uses the Claude Code TUI structure: the bottom-most separator line (────)
 * divides content/prompt from the status bar below. We find that separator,
 * then check the lines above it for idle/off patterns.
 *
 * TUI layout when idle (prompt between separators):
 *   [content]
 *   ──────────────    ← 2nd separator (prompt top)
 *   ❯ [input]        ← prompt line (may have typed text)
 *   ──────────────    ← 1st separator from bottom (prompt bottom / status bar top)
 *   Model: ...        ← status bar (ignored)
 *   cwd: ...
 *
 * TUI layout when idle (permission/choice prompt below separator):
 *   [content]
 *   ──────────────    ← separator
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *   2. No
 *   Esc to cancel
 *
 * TUI layout when working:
 *   [tool output]
 *   ──────────────    ← 1st separator from bottom
 *   Model: ...        ← status bar (ignored)
 *
 * @param {string} paneContent - raw pane capture text
 * @param {object} config - hive config with idlePatterns/offPatterns
 * @returns {'idle'|'working'|'off'}
 */
// Interactive prompt patterns safe to check below the separator.
// These only appear in permission/choice prompts, never in the status bar.
// (Note: shift+tab appears in the status bar so is intentionally excluded.)
const INTERACTIVE_PATTERNS = [/Do you want to proceed/, /Esc to cancel/, /Enter to select/, /^\s*❯/];

// Active Claude status indicators — the ❯ prompt is visible but not usable.
// Active lines use ellipsis (Doodling…, Doing...), completed lines don't (Sautéed for 14m).
const ACTIVE_STATUS_RE = /[⏺✢✳✻☵⚡]\s+\S+(?:…|\.{3})/;

function detectState(paneContent, config) {
  const lines = paneContent.split('\n');

  // Find the bottom-most separator — everything below it is the status bar.
  let separatorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isSeparator(lines[i])) {
      separatorIdx = i;
      break;
    }
  }

  // Check below separator for interactive prompts (permission/choice menus).
  // Newer Claude Code renders these below the separator instead of above it.
  if (separatorIdx >= 0) {
    for (let i = separatorIdx + 1; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      for (const pat of INTERACTIVE_PATTERNS) {
        if (pat.test(raw)) return 'idle';
      }
    }
  }

  // Determine which lines to check: above the separator, or all lines as fallback
  const checkLines = separatorIdx >= 0
    ? lines.slice(Math.max(0, separatorIdx - 5), separatorIdx)
    : lines;

  // Check for active Claude status (Doodling…, Doing…, Churning...) before idle.
  // When Claude is working, the ❯ prompt is visible but not interactive.
  for (const line of checkLines) {
    if (ACTIVE_STATUS_RE.test(line)) return 'working';
  }

  // Scan upward from the bottom of the check region
  let checked = 0;
  for (let i = checkLines.length - 1; i >= 0 && checked < 6; i--) {
    const raw = checkLines[i];
    if (!raw.trim()) continue;
    if (isSeparator(raw)) continue; // skip 2nd separator (above prompt)
    checked++;

    // Check raw line (catches Unicode like ❯)
    for (const pat of config.idlePatterns) {
      if (pat.test(raw)) return 'idle';
    }
    for (const pat of config.offPatterns) {
      if (pat.test(raw)) return 'off';
    }

    // Strip non-printable for ASCII-based checks
    const clean = raw.replace(/[^\x20-\x7E]/g, '').trim();
    if (!clean) continue; // Unicode-only non-separator line

    for (const pat of config.idlePatterns) {
      if (pat.test(clean)) return 'idle';
    }
    for (const pat of config.offPatterns) {
      if (pat.test(clean)) return 'off';
    }

    // Real content that isn't idle/off → working
    return 'working';
  }

  return 'off';
}

/**
 * Get git info for a repo directory.
 * @returns {{ branch, staged, modified, untracked }}
 */
async function gitInfo(repoDir) {
  // Single shell command instead of 4 separate process spawns
  const out = await exec(`cd "${repoDir}" 2>/dev/null && echo "$(git branch --show-current 2>/dev/null)" && echo "$(git diff --cached --shortstat 2>/dev/null | sed -E 's/^ *([0-9]+) file.*/\\1/')" && echo "$(git diff --shortstat 2>/dev/null | sed -E 's/^ *([0-9]+) file.*/\\1/')" && echo "$(git ls-files --others --exclude-standard 2>/dev/null | wc -l)"`);
  if (!out) return { branch: '', staged: 0, modified: 0, untracked: 0 };
  const lines = out.split('\n');
  return {
    branch: (lines[0] || '').trim(),
    staged: parseInt(lines[1]) || 0,
    modified: parseInt(lines[2]) || 0,
    untracked: parseInt(lines[3]) || 0,
  };
}

/**
 * Kill a tmux session.
 */
async function killSession(name) {
  return (await exec(`tmux kill-session -t "${name}:" 2>/dev/null`)) !== null;
}

// Claude Code TUI chrome patterns (status bars, prompt, UI elements)
const TUI_CHROME = [
  /\$[\d.]+/,                    // cost: $186.73
  /bypass permissions/,
  /shift\+tab/,
  /ctrl-g to edit/,
  /ctrl\+o to expand/,
  /no JIRA ticket/i,
  /^\s*>\s*$/,                   // bare prompt ">"
  /^\s*copy\s*$/,                // TUI "copy" button
  /-- INSERT --/,
  /Cogitated for/,               // "Cogitated for 1m 19s"
  /Baked for/,                   // "Baked for 3m 23s"
  /^\s*\d+\s*tokens/,            // token count
  /^\s*CI\s+(no build|PASS|FAIL)/i, // CI status line
  /^\s*approve,?\s*(next|merge)/i,  // "approve, next"
  /^Waiting/,                    // "Waitingpr diff..." tool calls
  /^Explore\(/,                  // "Explore(..." tool calls
  /^Reading\(/,                  // "Reading(..." tool calls
];

/**
 * Strip Claude Code TUI chrome from pane content.
 * Removes status bars, prompts, and UI elements from top and bottom.
 * Returns cleaned content string.
 */
function stripTUIChrome(content, config) {
  if (!content) return '';
  const lines = content.split('\n');

  function isChrome(line) {
    const clean = line.replace(/[^\x20-\x7E]/g, '').trim();
    if (!clean) return true;
    // Config patterns
    if (config) {
      for (const pat of (config.idlePatterns || [])) {
        if (pat.test(clean)) return true;
      }
      for (const pat of (config.offPatterns || [])) {
        if (pat.test(clean)) return true;
      }
    }
    // Built-in patterns
    for (const pat of TUI_CHROME) {
      if (pat.test(clean)) return true;
    }
    return false;
  }

  // Strip from bottom
  let end = lines.length;
  while (end > 0 && isChrome(lines[end - 1])) end--;

  // Strip from top
  let start = 0;
  while (start < end && isChrome(lines[start])) start++;

  return lines.slice(start, end)
    .map(l => l.replace(/[^\x20-\x7E]/g, '').trimEnd())
    .join('\n')
    .trim();
}

module.exports = {
  exec,
  listSessions,
  capturePane,
  sendKeys,
  hasSession,
  detectState,
  gitInfo,
  killSession,
  stripTUIChrome,
};
