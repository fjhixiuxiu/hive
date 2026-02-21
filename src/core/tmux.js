const { execSync } = require('child_process');

/**
 * Execute a command and return trimmed stdout, or null on failure.
 */
function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, ...opts }).trim();
  } catch {
    return null;
  }
}

/**
 * List all tmux sessions, returns array of session name strings.
 */
function listSessions() {
  const out = exec("tmux list-sessions -F '#S' 2>/dev/null");
  if (!out) return [];
  return out.split('\n').filter(Boolean).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}

/**
 * Capture pane content.
 * @param {string} target - tmux target (e.g. "6-branch:.1")
 * @param {object} opts
 * @param {number} opts.lines - number of scrollback lines (default: visible only)
 */
function capturePane(target, { lines } = {}) {
  const scrollback = lines ? `-S -${lines}` : '';
  const out = exec(`tmux capture-pane -t "${target}" -p ${scrollback} 2>/dev/null`);
  return out || '';
}

/**
 * Send keys to a tmux pane.
 * @param {string} target - tmux target
 * @param {string} keys - text to send
 * @param {boolean} enter - whether to press Enter after
 */
function sendKeys(target, keys, enter = true) {
  // Escape single quotes in the message
  const escaped = keys.replace(/'/g, "'\\''");
  const enterKey = enter ? ' Enter' : '';
  exec(`tmux send-keys -t "${target}" '${escaped}'${enterKey}`);
}

/**
 * Check if a tmux session exists.
 */
function hasSession(name) {
  return exec(`tmux has-session -t "${name}" 2>/dev/null`) !== null;
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
function gitInfo(repoDir) {
  const branch = exec(`git -C "${repoDir}" branch --show-current 2>/dev/null`) || '';
  const staged = parseInt(exec(`git -C "${repoDir}" diff --cached --shortstat 2>/dev/null | sed -E 's/^ *([0-9]+) file.*/\\1/'`) || '0') || 0;
  const modified = parseInt(exec(`git -C "${repoDir}" diff --shortstat 2>/dev/null | sed -E 's/^ *([0-9]+) file.*/\\1/'`) || '0') || 0;
  const untracked = parseInt(exec(`git -C "${repoDir}" ls-files --others --exclude-standard 2>/dev/null | wc -l`) || '0') || 0;
  return { branch, staged, modified, untracked };
}

/**
 * Kill a tmux session.
 */
function killSession(name) {
  return exec(`tmux kill-session -t "${name}:" 2>/dev/null`) !== null;
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
};
