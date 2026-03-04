const fs = require('fs');
const path = require('path');
const tmux = require('./tmux');
const log = require('./log');

/**
 * Parse a width spec like '50%' into absolute columns.
 * @param {string|number} spec - e.g. '50%' or 100
 * @param {number} totalCols - total columns of the session
 * @returns {number}
 */
function parseWidth(spec, totalCols) {
  if (typeof spec === 'number') return spec;
  const str = String(spec).trim();
  if (str.endsWith('%')) {
    return Math.round((parseInt(str, 10) / 100) * totalCols);
  }
  return parseInt(str, 10) || totalCols;
}

/**
 * Check if tmux is available.
 * @returns {Promise<boolean>}
 */
async function isTmuxAvailable() {
  const out = await tmux.exec('tmux -V');
  return out !== null;
}

/**
 * Apply global tmux options needed by hive before creating sessions.
 * @param {object} [tmuxConfig] - config.tmux section (optional)
 */
async function applyGlobalOptions(tmuxConfig = {}) {
  const defaultCommand = tmuxConfig.defaultCommand || 'env -u CLAUDECODE bash --login';
  const cmds = [
    `tmux set-option -g default-command "${defaultCommand}"`,
    'tmux set-option -g pane-base-index 1',
    'tmux set-option -g base-index 1',
    'tmux set-option -g mouse on',
    'tmux set-option -g history-limit 50000',
  ];
  for (const cmd of cmds) {
    await tmux.exec(cmd);
  }
}

/**
 * Create a single tmux session with the correct dimensions and pane layout.
 *
 * @param {string|number} name - session name (e.g. "1")
 * @param {string} repoDir - working directory for panes
 * @param {object} layout - layout options
 * @param {number} [layout.panes=3] - number of panes (1, 2, or 3)
 * @param {string} [layout.tmuxLayout='main-vertical'] - tmux layout name
 * @param {string|number} [layout.claudePaneWidth='50%'] - width of the Claude pane
 * @param {object} size - session dimensions
 * @param {number} [size.cols=200] - columns
 * @param {number} [size.rows=50] - rows
 * @returns {Promise<{created: boolean, skipped: boolean}>}
 */
async function createSession(name, repoDir, layout = {}, size = {}) {
  const sessionName = String(name);
  const cols = size.cols || 200;
  const rows = size.rows || 50;
  const panes = layout.panes || 3;
  const tmuxLayout = layout.tmuxLayout || 'main-vertical';
  const claudePaneWidth = layout.claudePaneWidth || '50%';

  // Skip if session already exists
  if (await tmux.hasSession(sessionName)) {
    log.info(`[session-manager] session "${sessionName}" already exists, skipping`);
    return { created: false, skipped: true };
  }

  // Ensure repo directory exists so tmux doesn't fall back to $HOME
  try { fs.mkdirSync(repoDir, { recursive: true }); } catch {}

  // 1. Create session at explicit size
  await tmux.exec(`tmux new-session -d -s "${sessionName}" -x ${cols} -y ${rows} -c "${repoDir}"`);

  // 2. Split panes
  if (panes >= 2) {
    await tmux.exec(`tmux split-window -h -t "${sessionName}" -c "${repoDir}"`);
  }
  if (panes >= 3) {
    await tmux.exec(`tmux split-window -v -t "${sessionName}:.2" -c "${repoDir}"`);
  }

  // 3. Apply layout
  if (panes >= 2) {
    await tmux.exec(`tmux select-layout -t "${sessionName}" ${tmuxLayout}`);
  }

  // 4. Resize Claude pane (pane .1) to desired width
  if (panes >= 2) {
    const absWidth = parseWidth(claudePaneWidth, cols);
    await tmux.exec(`tmux resize-pane -t "${sessionName}:.1" -x ${absWidth}`);
  }

  // 5. cd into repoDir in all panes (default-command "bash --login" resets cwd to $HOME)
  for (let p = 1; p <= panes; p++) {
    await tmux.exec(`tmux send-keys -t "${sessionName}:.${p}" "cd ${repoDir}" Enter`);
  }

  log.info(`[session-manager] created session "${sessionName}" (${cols}x${rows}, ${panes} panes)`);
  return { created: true, skipped: false };
}

/**
 * Start Claude Code in the Claude pane of a session.
 * @param {string|number} name - session name
 * @param {number} [claudePane=1] - pane index for Claude
 * @param {string} [claudeCmd='claude --continue'] - command to run
 */
async function startClaude(name, claudePane = 1, claudeCmd = 'claude --continue') {
  const target = `${name}:.${claudePane}`;
  await tmux.exec(`tmux send-keys -t "${target}" "${claudeCmd}" Enter`);
  log.info(`[session-manager] started Claude in ${target}`);
}

/**
 * Create all fleet sessions from config.
 *
 * Supports two config shapes:
 * - Legacy: uses config.sessions.roles + config.sessions.repoDir(n)
 * - New: uses config.tmux.repos (deferred — falls back to legacy for now)
 *
 * @param {object} config - hive config
 * @returns {Promise<{created: number[], skipped: number[], failed: Array<{num: number, error: string}>}>}
 */
async function createAllSessions(config) {
  const results = { created: [], skipped: [], failed: [] };
  const size = config.tmux?.defaultSize || { cols: 200, rows: 50 };
  const defaultLayout = {
    panes: 3,
    tmuxLayout: 'main-vertical',
    claudePaneWidth: '50%',
  };

  // Determine session list from config
  let sessions;
  if (config.tmux?.repos) {
    // New config: per-repo agents
    sessions = [];
    for (const repo of config.tmux.repos) {
      const count = repo.agents || 1;
      for (let i = 0; i < count; i++) {
        const num = repo.startSlot + i;
        sessions.push({
          num,
          repoDir: repo.dir,
          layout: repo.layout || defaultLayout,
        });
      }
    }
  } else {
    // Legacy: derive from sessions.roles
    const roles = config.sessions?.roles || {};
    sessions = Object.keys(roles).map(k => ({
      num: parseInt(k, 10),
      repoDir: config.sessions.repoDir(parseInt(k, 10)),
      layout: defaultLayout,
    }));
  }

  const prefix = config.sessions?.namePrefix || '';
  for (const sess of sessions) {
    try {
      const sessionName = `${prefix}${sess.num}`;
      const result = await createSession(sessionName, sess.repoDir, sess.layout, size);
      if (result.created) {
        results.created.push(sess.num);
      } else {
        results.skipped.push(sess.num);
      }
    } catch (err) {
      log.error(`[session-manager] failed to create session ${sess.num}: ${err.message}`);
      results.failed.push({ num: sess.num, error: err.message });
    }
  }

  return results;
}

/**
 * Destroy all fleet sessions matching the config pattern.
 *
 * @param {object} config - hive config
 * @returns {Promise<{killed: string[], failed: Array<{name: string, error: string}>}>}
 */
async function destroyAllSessions(config) {
  const results = { killed: [], failed: [] };
  const repoBase = config.sessions?.repoBase;
  const pattern = config.sessions?.pattern || /^\d+/;

  const sessions = await tmux.listSessions();
  for (const sess of sessions) {
    if (repoBase && sess.path) {
      if (!sess.path.startsWith(repoBase)) continue;
    } else {
      if (!pattern.test(sess.name)) continue;
    }
    try {
      const ok = await tmux.killSession(sess.name);
      if (ok) {
        results.killed.push(sess.name);
      } else {
        results.failed.push({ name: sess.name, error: 'killSession returned false' });
      }
    } catch (err) {
      results.failed.push({ name: sess.name, error: err.message });
    }
  }

  return results;
}

/**
 * Write .mcp.json to a repo directory, adding/updating the hive MCP server entry.
 * Merges with any existing .mcp.json content (preserves other MCP servers).
 *
 * @param {string} repoDir - repo directory path
 * @param {string} hiveUrl - hive WS URL
 * @param {string} token - auth token
 * @param {string|number} session - session number
 * @param {string[]} [tools] - optional list of enabled tool names
 */
function writeMcpConfig(repoDir, hiveUrl, token, session, tools) {
  const mcpPath = path.join(repoDir, '.mcp.json');
  const mcpArgs = [
    path.join(__dirname, '..', 'mcp-server', 'index.mjs'),
    '--hive-url', hiveUrl,
    '--session', String(session),
    '--token', token,
  ];
  if (tools && tools.length > 0) {
    mcpArgs.push('--tools', tools.join(','));
  }
  const hiveEntry = { command: 'node', args: mcpArgs };

  let existing = { mcpServers: {} };
  try {
    existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (!existing.mcpServers) existing.mcpServers = {};
  } catch {}

  existing.mcpServers.hive = hiveEntry;
  fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Remove the hive entry from .mcp.json in a repo directory.
 * Deletes the file entirely if no other MCP servers remain.
 *
 * @param {string} repoDir - repo directory path
 */
function removeMcpConfig(repoDir) {
  const mcpPath = path.join(repoDir, '.mcp.json');
  try {
    const existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (existing.mcpServers && existing.mcpServers.hive) {
      delete existing.mcpServers.hive;
      if (Object.keys(existing.mcpServers).length === 0) {
        fs.unlinkSync(mcpPath);
      } else {
        fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
      }
    }
  } catch {}
}

module.exports = {
  parseWidth,
  isTmuxAvailable,
  applyGlobalOptions,
  createSession,
  startClaude,
  createAllSessions,
  destroyAllSessions,
  writeMcpConfig,
  removeMcpConfig,
};
