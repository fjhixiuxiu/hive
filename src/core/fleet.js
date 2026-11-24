const path = require('path');
const tmux = require('./tmux');
const prStatus = require('./pr-status');
const log = require('./log');

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
 * When namePrefix is provided, strips it first (e.g. "dev-6-DEV-123" with prefix "dev-" -> 6).
 */
function sessionNum(name, namePrefix) {
  let s = name;
  if (namePrefix && s.startsWith(namePrefix)) s = s.slice(namePrefix.length);
  const m = s.match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Extract JIRA ticket key from branch name.
 */
function ticketFromBranch(branch) {
  const m = (branch || '').match(/(DEV-\d+)/);
  return m ? m[1] : null;
}

// `git status` across a 23-repo fleet takes ~5s per round (one repo alone took
// 2.8s, measured 2026-10-07), so it doesn't run on every 10s poll. The watcher
// refreshes a session's entry when it goes idle, which is when its branch and
// changes have most likely moved; anything else shows within the TTL.
const GIT_INFO_TTL = 60000; // 60s
const _gitCache = new Map(); // `${nodeId}:${repoDir}` -> { info, ts } | { pending }

function gitInfoFor(node, nodeId, repoDir, { fresh = false } = {}) {
  const key = `${nodeId || 'local'}:${repoDir}`;
  const hit = _gitCache.get(key);
  if (hit && hit.pending) return hit.pending;
  if (!fresh && hit && Date.now() - hit.ts < GIT_INFO_TTL) return Promise.resolve(hit.info);
  const pending = node.gitInfo(repoDir).then(
    (info) => {
      _gitCache.set(key, { info, ts: Date.now() });
      return info;
    },
    (err) => {
      if (hit) _gitCache.set(key, hit);
      else _gitCache.delete(key);
      throw err;
    },
  );
  _gitCache.set(key, { pending });
  return pending;
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
  const num = sessionNum(sessionName, nc.sessions.namePrefix);
  const repoDir = num ? nc.sessions.repoDir(num) : null;
  const isRepo = repoDir ? await node.fileExists(path.join(repoDir, '.git')) : false;

  // Claude state -- prefer cached state file, fall back to live detection
  let state = num ? await readState(nc.cache, node, num) : null;
  if (!state) {
    const paneTarget = tmux.paneTarget(sessionName, nc.sessions.claudePane);
    const paneContent = await node.capturePane(paneTarget, { lines: 3 });
    state = tmux.detectState(paneContent, config);
  }

  // Git info
  const git = isRepo
    ? await gitInfoFor(node, nodeId, repoDir)
    : { branch: '', staged: 0, modified: 0, untracked: 0 };
  const ticket = ticketFromBranch(git.branch);

  return {
    name: sessionName,
    num,
    state,
    branch: git.branch,
    ticket,
    git,
    pr: git.branch ? prStatus.getCached(git.branch) : null,
  };
}

// Cache: { result, timestamp, pending, lastGood, lastGoodTs }
let _fleetCache = { result: null, ts: 0, pending: null, lastGood: null, lastGoodTs: 0 };
const FLEET_CACHE_TTL = 10000; // 10s
// An empty session list almost always means a transient tmux listing failure (the
// list-windows exec timed out under load), not that every session vanished. Returning
// empty makes the watcher skip all sessions and makes auto-create think every slot is
// free (so it can spawn onto an occupied slot). Fall back to the last-known non-empty
// fleet while it's still fresh; past this window, accept the empty as real.
const FLEET_EMPTY_FALLBACK_MS = 60000; // 60s

/**
 * Get status for all fleet sessions (cached for 5s to avoid hammering tmux/git/API).
 * @param {object} config - hive config
 * @param {NodeRouter} router
 */
async function getFleetStatus(config, router) {
  const now = Date.now();
  if (_fleetCache.result && now - _fleetCache.ts < FLEET_CACHE_TTL) {
    return _fleetCache.result;
  }
  if (_fleetCache.pending) return _fleetCache.pending;

  _fleetCache.pending = (async () => {
    const all = await router.listAllSessions();
    const matching = all.filter(({ name, path, nodeId }) => {
      const nc = getNodeConfig(config, nodeId);
      if (nc.sessions.repoBase && path) {
        // Path must match AND session name must yield a valid number
        return (
          path.startsWith(nc.sessions.repoBase) && sessionNum(name, nc.sessions.namePrefix) !== null
        );
      }
      return nc.sessions.pattern.test(name);
    });
    const all_sessions = await Promise.all(
      matching.map(async ({ name, nodeId, lastActivity }) => {
        const node = router.getNode(nodeId);
        const session = await getSession(config, node, name, nodeId);
        return { ...session, nodeId, lastActivity };
      }),
    );
    // Deduplicate by session num — keep the most recently active session
    // (stale renamed tmux sessions like "5-old-branch" can linger alongside "5")
    const byNum = new Map();
    for (const s of all_sessions) {
      const prev = byNum.get(s.num);
      if (!prev || (s.lastActivity || 0) > (prev.lastActivity || 0)) {
        byNum.set(s.num, s);
      }
    }
    const result = Array.from(byNum.values()).sort((a, b) => a.num - b.num);

    // Guard against a transient empty listing: if we got nothing but recently had a
    // real fleet, serve the last-known one instead of letting consumers act on "no
    // sessions". Don't refresh lastGood from the empty result, so the fallback window
    // is measured from the last GOOD poll.
    if (
      result.length === 0 &&
      _fleetCache.lastGood &&
      _fleetCache.lastGood.length &&
      Date.now() - _fleetCache.lastGoodTs < FLEET_EMPTY_FALLBACK_MS
    ) {
      log.warn(
        `[fleet] empty session list (likely a transient tmux timeout) — serving last-known fleet of ${_fleetCache.lastGood.length}`,
      );
      _fleetCache.result = _fleetCache.lastGood;
      _fleetCache.ts = Date.now();
      _fleetCache.pending = null;
      return _fleetCache.lastGood;
    }

    _fleetCache.result = result;
    _fleetCache.ts = Date.now();
    if (result.length) {
      _fleetCache.lastGood = result;
      _fleetCache.lastGoodTs = Date.now();
    }
    _fleetCache.pending = null;
    return result;
  })();
  return _fleetCache.pending;
}

function invalidateCache() {
  _fleetCache.result = null;
  _fleetCache.ts = 0;
  _gitCache.clear();
}

/**
 * Re-read one session's git info now instead of waiting out the TTL. The
 * watcher calls this when a session goes idle and once at startup.
 */
async function refreshGitInfo(config, node, sessionName, nodeId) {
  const nc = getNodeConfig(config, nodeId);
  const num = sessionNum(sessionName, nc.sessions.namePrefix);
  if (!num) return;
  const repoDir = nc.sessions.repoDir(num);
  if (!(await node.fileExists(path.join(repoDir, '.git')))) return;
  await gitInfoFor(node, nodeId, repoDir, { fresh: true });
  // Drop the 10s fleet snapshot so the next poll shows the new branch.
  _fleetCache.result = null;
  _fleetCache.ts = 0;
}

/**
 * Get Claude's pane content with TUI chrome stripped.
 * @param {object} config
 * @param {Node} node
 * @param {string} sessionName
 */
async function peekSession(config, node, sessionName) {
  const paneTarget = tmux.paneTarget(sessionName, config.sessions.claudePane);
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
  const sessions = all.filter(({ name, path }) => {
    if (config.sessions.repoBase && path) {
      return (
        path.startsWith(config.sessions.repoBase) &&
        sessionNum(name, config.sessions.namePrefix) !== null
      );
    }
    return config.sessions.pattern.test(name);
  });

  // Exact number match
  const num = parseInt(query);
  if (!isNaN(num)) {
    return (
      sessions.find(({ name }) => sessionNum(name, config.sessions.namePrefix) === num) || null
    );
  }
  // Substring match
  return (
    sessions.find(({ name }) => name.toLowerCase().includes(String(query).toLowerCase())) || null
  );
}

module.exports = {
  getNodeConfig,
  readState,
  sessionNum,
  ticketFromBranch,
  getSession,
  getFleetStatus,
  invalidateCache,
  refreshGitInfo,
  peekSession,
  findSession,
};
