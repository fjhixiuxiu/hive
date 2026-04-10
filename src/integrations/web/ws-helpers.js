const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ── Constants ───────────────────────────────────────────

const HIVE_CONSOLE_SESSION = 'hive-console';
const HIVE_CONSOLE_DIR = path.join(__dirname, '..', '..', '..');

// Env for gh CLI — ensure /opt/homebrew/bin is in PATH for hivebot
const ghExecEnv = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ''}` };

// Setup wizard detection
const setupPath = path.join(__dirname, '..', '..', '..', '.hive-setup.json');
function isSetupComplete() { return fs.existsSync(setupPath); }

// ── Contextual action definitions ───────────────────────

const ACTION_DEFS = {
  'github-pr': [
    { id: 'approve', label: 'Approve', color: 'var(--green)', confirm: false },
    { id: 'request-changes', label: 'Request Changes', color: 'var(--red)', confirm: true },
    { id: 'merge', label: 'Merge (Squash)', color: 'var(--purple)', confirm: true },
    { id: 'merge-commit', label: 'Merge (Merge Commit)', color: 'var(--purple)', confirm: true },
    { id: 'admin-merge', label: 'Admin Merge (Override)', color: 'var(--orange)', confirm: true },
    { id: 'close-pr', label: 'Close PR', color: 'var(--red)', confirm: true },
  ],
};

function decorateTaskActions(task, pmManager) {
  if (!task.actionContext || !task.actionContext.type) return task;
  let defs = ACTION_DEFS[task.actionContext.type];
  if (!defs) return task;
  // Look up PM's allowed actions at render time (not baked into task)
  if (pmManager && task.source) {
    const pmName = task.source.replace(/^pm:/, '');
    const pm = pmManager.getAll().find(p => p.name === pmName);
    if (pm && pm.actions && pm.actions.length) {
      const allowed = new Set(pm.actions);
      defs = defs.filter(d => allowed.has(d.id));
    }
  }
  return { ...task, actions: defs };
}

async function executeGithubPrAction(ctx, actionId, pmManager) {
  const { repo, prNumber } = ctx;
  const headers = pmManager._githubHeaders();

  switch (actionId) {
    case 'approve': {
      await pmManager._httpMethod('POST', `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, headers, { event: 'APPROVE' });
      return { message: `Approved PR #${prNumber}`, closeTask: false };
    }
    case 'request-changes': {
      await pmManager._httpMethod('POST', `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, headers, { event: 'REQUEST_CHANGES', body: 'Changes requested via Hive' });
      return { message: `Requested changes on PR #${prNumber}`, closeTask: false };
    }
    case 'merge': {
      await pmManager._httpMethod('PUT', `https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, headers, { merge_method: 'squash' });
      return { message: `Merged PR #${prNumber} (squash)`, closeTask: false };
    }
    case 'merge-commit': {
      await pmManager._httpMethod('PUT', `https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, headers, { merge_method: 'merge' });
      return { message: `Merged PR #${prNumber} (merge commit)`, closeTask: false };
    }
    case 'admin-merge': {
      await pmManager._httpMethod('PUT', `https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, headers, { merge_method: 'squash', bypass_branch_protection: true });
      return { message: `Admin merged PR #${prNumber} (override)`, closeTask: false };
    }
    case 'close-pr': {
      await pmManager._httpMethod('PATCH', `https://api.github.com/repos/${repo}/pulls/${prNumber}`, headers, { state: 'closed' });
      return { message: `Closed PR #${prNumber}`, closeTask: false };
    }
    case 'approve-close': {
      // Legacy: kept for backwards compat with any in-flight tasks
      await pmManager._httpMethod('POST', `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, headers, { event: 'APPROVE' });
      return { message: `Approved PR #${prNumber}`, closeTask: true };
    }
    default:
      throw new Error(`Unknown action: ${actionId}`);
  }
}

async function executeTaskAction(task, actionId, pmManager) {
  const ctx = task.actionContext;
  if (ctx.type === 'github-pr') return executeGithubPrAction(ctx, actionId, pmManager);
  throw new Error(`Unknown action context type: ${ctx.type}`);
}

// ── Network helpers ─────────────────────────────────────

/**
 * Detect the Tailscale interface IP address.
 * Tailscale uses the CGNAT range: 100.64.0.0/10
 */
function getTailscaleIP() {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const octets = addr.address.split('.').map(Number);
        if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
          return addr.address;
        }
      }
    }
  }
  return null;
}

/**
 * Determine which hosts to bind the web server to.
 */
function getBindHosts() {
  const bindEnv = process.env.WEB_BIND;
  if (bindEnv) return bindEnv.split(',').map(h => h.trim());
  const hosts = ['127.0.0.1'];
  const tsIP = getTailscaleIP();
  if (tsIP) hosts.push(tsIP);
  return hosts;
}

// ── Command discovery ───────────────────────────────────

function scanCommands(dir) {
  const cmds = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const m = content.match(/^---\n([\s\S]*?)\n---/);
      if (m) {
        const nameMatch = m[1].match(/^name:\s*(.+)/m);
        const descMatch = m[1].match(/^description:\s*(.+)/m);
        cmds.push({
          name: nameMatch ? nameMatch[1].trim() : file.replace('.md', ''),
          description: descMatch ? descMatch[1].trim() : '',
        });
      } else {
        cmds.push({ name: file.replace('.md', ''), description: '' });
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }
  return cmds;
}

function discoverCommands(config) {
  const globalDir = path.join(os.homedir(), '.claude', 'commands');
  const globalCmds = scanCommands(globalDir);
  let projectCmds = [];
  if (config.sessions && config.sessions.repoDir) {
    const projectDir = path.join(config.sessions.repoDir(1), '.claude', 'commands');
    projectCmds = scanCommands(projectDir);
  }
  const byName = new Map();
  for (const c of globalCmds) byName.set(c.name, c);
  for (const c of projectCmds) byName.set(c.name, c);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Terminal capture ────────────────────────────────────

async function capturePaneAnsi(node, target) {
  const content = await node.exec(`tmux capture-pane -e -p -S -500 -t "${target}" 2>/dev/null`) || '';
  const colsStr = await node.exec(`tmux display-message -p -t "${target}" "#{pane_width}" 2>/dev/null`);
  const cols = parseInt(colsStr) || 0;
  return { content, cols };
}

/**
 * Build the initial `config` WebSocket payload sent to clients on connect.
 * Pure function for testability — reads env and config, returns the message object.
 */
function buildConfigMessage(config) {
  return {
    type: 'config',
    links: config.links || {},
    spawnBaseDir: config.sessions.repoBase || process.env.HIVE_REPO_DIR || '~/ai-dev',
    hiveName: config.sessions?.hiveName || '',
    title: process.env.HIVE_TITLE || '',
  };
}

module.exports = {
  HIVE_CONSOLE_SESSION,
  HIVE_CONSOLE_DIR,
  ghExecEnv,
  setupPath,
  isSetupComplete,
  ACTION_DEFS,
  decorateTaskActions,
  executeGithubPrAction,
  executeTaskAction,
  getTailscaleIP,
  getBindHosts,
  scanCommands,
  discoverCommands,
  capturePaneAnsi,
  buildConfigMessage,
};
