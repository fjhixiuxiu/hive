const path = require('path');
const tmux = require('./tmux');

/**
 * Get node-specific config, merging overrides from config.nodes[nodeId].
 * Falls back to default config if no node-specific config exists.
 */
function getNodeConfig(config, nodeId) {
  if (!nodeId || nodeId === 'local' || !config.nodes || !config.nodes[nodeId]) {
    return config;
  }
  const nc = config.nodes[nodeId];
  return {
    ...config,
    sessions: { ...config.sessions, ...(nc.sessions || {}) },
    cache: { ...config.cache, ...(nc.cache || {}) },
  };
}

/**
 * Read the cache file for a session number.
 * Returns { prNum, prAdds, prDels, prFiles, ciResult, ciBuild, review } or null.
 */
async function readCache(cacheConfig, node, num) {
  const file = `${cacheConfig.statusPrefix}${num}`;
  try {
    const content = await node.readFile(file);
    if (!content) return null;
    const lines = content.split('\n');
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
async function readState(cacheConfig, node, num) {
  const file = path.join(cacheConfig.stateDir, String(num));
  try {
    const content = await node.readFile(file);
    return content ? content.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Extract session number from session name ("6-DEV-43966-..." -> 6).
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
 * @param {object} config - hive config
 * @param {Node} node - execution node
 * @param {string} sessionName - tmux session name
 * @param {string} nodeId - node identifier (for per-node config)
 */
async function getSession(config, node, sessionName, nodeId) {
  const nc = getNodeConfig(config, nodeId);
  const num = sessionNum(sessionName);
  const repoDir = num ? nc.sessions.repoDir(num) : null;
  const isRepo = repoDir ? await node.fileExists(path.join(repoDir, '.git')) : false;

  // Claude state -- prefer cached state file, fall back to live detection
  let state = num ? await readState(nc.cache, node, num) : null;
  if (!state) {
    const paneTarget = `${sessionName}:.${nc.sessions.claudePane}`;
    const paneContent = await node.capturePane(paneTarget, { lines: 3 });
    state = tmux.detectState(paneContent, config);
  }

  // Git info
  const git = isRepo ? await node.gitInfo(repoDir) : { branch: '', staged: 0, modified: 0, untracked: 0 };
  const ticket = ticketFromBranch(git.branch);

  // PR/CI from cache
  const cache = num ? await readCache(nc.cache, node, num) : null;

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

// Cache: { result, timestamp, pending }
let _fleetCache = { result: null, ts: 0, pending: null };
const FLEET_CACHE_TTL = 5000; // 5s

/**
 * Get status for all fleet sessions.
 * @param {object} config - hive config
 * @param {NodeRouter} router
 */
async function getFleetStatus(config, router) {
  const all = await router.listAllSessions();
  const matching = all.filter(({ name, nodeId }) => {
    const nc = getNodeConfig(config, nodeId);
    return nc.sessions.pattern.test(name);
  });
  return Promise.all(matching.map(async ({ name, nodeId }) => {
    const node = router.getNode(nodeId);
    const session = await getSession(config, node, name, nodeId);
    return { ...session, nodeId };
  }));
}

/**
 * Get Claude's pane content with TUI chrome stripped.
 * @param {object} config
 * @param {Node} node
 * @param {string} sessionName
 */
async function peekSession(config, node, sessionName) {
  const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
  const content = await node.capturePane(paneTarget);
  return tmux.stripTUIChrome(content, config);
}

/**
 * Find a session by number or substring match.
 * @param {object} config
 * @param {NodeRouter} router
 * @param {string|number} query
 * @returns {Promise<{name, nodeId}|null>}
 */
async function findSession(config, router, query) {
  const all = await router.listAllSessions();
  const sessions = all.filter(({ name }) => config.sessions.pattern.test(name));

  // Exact number match
  const num = parseInt(query);
  if (!isNaN(num)) {
    return sessions.find(({ name }) => sessionNum(name) === num) || null;
  }
  // Substring match
  return sessions.find(({ name }) =>
    name.toLowerCase().includes(String(query).toLowerCase())
  ) || null;
}

module.exports = {
  getNodeConfig,
  readCache,
  readState,
  sessionNum,
  ticketFromBranch,
  getSession,
  getFleetStatus,
  peekSession,
  findSession,
};
