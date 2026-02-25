const { exec: cpExec } = require('child_process');
const { promisify } = require('util');
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
  // Replace newlines with " — " so the entire message is sent as one line
  const oneLine = keys.replace(/\r?\n+/g, ' — ');
  // Escape single quotes in the message
  const escaped = oneLine.replace(/'/g, "'\\''");
  // Use -l for literal text (prevents key name interpretation)
  await exec(`tmux send-keys -t "${target}" -l '${escaped}'`);
  if (enter) await exec(`tmux send-keys -t "${target}" Enter`);
}

/**
 * Check if a tmux session exists.
 */
async function hasSession(name) {
  return (await exec(`tmux has-session -t "${name}" 2>/dev/null`)) !== null;
}

/**
 * Detect Claude's state from a pane capture.
 * @param {string} paneContent - raw pane capture text
 * @param {object} config - hive config with idlePatterns/offPatterns
 * @returns {'idle'|'working'|'off'}
 */
function detectState(paneContent, config) {
  const lines = paneContent.split('\n').filter(l => l.trim());
  if (lines.length === 0) return 'off';

  const lastLine = lines[lines.length - 1]
    .replace(/[^\x20-\x7E]/g, ''); // strip non-printable

  for (const pat of config.idlePatterns) {
    if (pat.test(lastLine)) return 'idle';
  }
  for (const pat of config.offPatterns) {
    if (pat.test(lastLine)) return 'off';
  }
  return 'working';
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
