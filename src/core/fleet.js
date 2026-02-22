const fs = require('fs');
const path = require('path');
const tmux = require('./tmux');

/**
 * Read the cache file for a session number.
 * Returns { prNum, prAdds, prDels, prFiles, ciResult, ciBuild, review } or null.
 */
function readCache(config, num) {
  const file = `${config.cache.statusPrefix}${num}`;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const prNum = lines[0] || '';
    if (!prNum) return null;
    return {
      prNum,
      prAdds: lines[1] || '0',
      prDels: lines[2] || '0',
      prFiles: lines[3] || '0',
      ciResult: lines[4] || '',
      ciBuild: lines[5] || '',
      review: lines[6] || '',
    };
  } catch {
    return null;
  }
}

/**
 * Read the Claude state file for a session number.
 * Returns 'idle', 'working', 'off', or null.
 */
function readState(config, num) {
  const file = path.join(config.cache.stateDir, String(num));
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Extract session number from session name ("6-DEV-43966-..." → 6).
 */
function sessionNum(name) {
  const m = name.match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Extract JIRA ticket key from branch name.
 */
function ticketFromBranch(branch) {
  const m = (branch || '').match(/(DEV-\d+)/);
  return m ? m[1] : null;
}

/**
 * Get full status for a single session.
 */
function getSession(config, sessionName) {
  const num = sessionNum(sessionName);
  const repoDir = num ? config.sessions.repoDir(num) : null;
  const isRepo = repoDir && fs.existsSync(path.join(repoDir, '.git'));

  // Claude state — prefer cached state file, fall back to live detection
  let state = num ? readState(config, num) : null;
  if (!state) {
    const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
    const paneContent = tmux.capturePane(paneTarget, { lines: 3 });
    state = tmux.detectState(paneContent, config);
  }

  // Git info
  const git = isRepo ? tmux.gitInfo(repoDir) : { branch: '', staged: 0, modified: 0, untracked: 0 };
  const ticket = ticketFromBranch(git.branch);

  // PR/CI from cache
  const cache = num ? readCache(config, num) : null;

  return {
    name: sessionName,
    num,
    state,
    branch: git.branch,
    ticket,
    git,
    pr: cache,
  };
}

/**
 * Get status for all fleet sessions.
 */
function getFleetStatus(config) {
  const sessions = tmux.listSessions();
  return sessions
    .filter(s => config.sessions.pattern.test(s))
    .map(s => getSession(config, s));
}

/**
 * Get Claude's pane content with TUI chrome stripped.
 */
function peekSession(config, sessionName) {
  const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
  const content = tmux.capturePane(paneTarget);
  return tmux.stripTUIChrome(content, config);
}

/**
 * Find a session by number (partial match).
 */
function findSession(config, query) {
  const sessions = tmux.listSessions().filter(s => config.sessions.pattern.test(s));
  // Exact number match
  const num = parseInt(query);
  if (!isNaN(num)) {
    return sessions.find(s => sessionNum(s) === num) || null;
  }
  // Substring match
  return sessions.find(s => s.toLowerCase().includes(query.toLowerCase())) || null;
}

module.exports = {
  readCache,
  readState,
  sessionNum,
  ticketFromBranch,
  getSession,
  getFleetStatus,
  peekSession,
  findSession,
};
