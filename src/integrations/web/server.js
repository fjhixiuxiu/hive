const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');
const fleet = require('../../core/fleet');
const relay = require('../../core/relay');
const git = require('../../core/git');
const RemoteNode = require('../../core/remote-node');
const auth = require('../../core/auth');
const prStatus = require('../../core/pr-status');

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
 * Defaults to 127.0.0.1 + Tailscale IP (if available).
 * Override with WEB_BIND env var (comma-separated).
 */
function getBindHosts() {
  const bindEnv = process.env.WEB_BIND;
  if (bindEnv) return bindEnv.split(',').map(h => h.trim());
  const hosts = ['127.0.0.1'];
  const tsIP = getTailscaleIP();
  if (tsIP) hosts.push(tsIP);
  return hosts;
}

/**
 * Scan a directory for Claude command .md files and parse frontmatter.
 * Returns array of { name, description }.
 */
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
    // Directory doesn't exist or not readable -- that's fine
  }
  return cmds;
}

/**
 * Discover all available Claude slash commands.
 * Checks global ~/.claude/commands/ and project-level .claude/commands/.
 */
function discoverCommands(config) {
  const globalDir = path.join(os.homedir(), '.claude', 'commands');
  const globalCmds = scanCommands(globalDir);

  // Check project-level commands from the first session's repo
  let projectCmds = [];
  if (config.sessions && config.sessions.repoDir) {
    const projectDir = path.join(config.sessions.repoDir(1), '.claude', 'commands');
    projectCmds = scanCommands(projectDir);
  }

  // Merge: project commands override global ones with same name
  const byName = new Map();
  for (const c of globalCmds) byName.set(c.name, c);
  for (const c of projectCmds) byName.set(c.name, c);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Capture pane with ANSI escape sequences preserved.
 * Uses -e flag for raw terminal colors that xterm.js can render.
 * -S -500 captures 500 lines of scrollback history.
 */
async function capturePaneAnsi(node, target) {
  const content = await node.exec(`tmux capture-pane -e -p -S -500 -t "${target}" 2>/dev/null`) || '';
  const colsStr = await node.exec(`tmux display-message -p -t "${target}" "#{pane_width}" 2>/dev/null`);
  const cols = parseInt(colsStr) || 0;
  return { content, cols };
}

/**
 * Create and start the web dashboard server.
 * @param {object} config - hive config
 * @param {Watcher} watcher - core watcher instance
 * @param {TaskQueue} taskQueue - task queue instance
 * @param {ProjectManager} pmManager
 * @param {NodeRouter} router
 * @returns {{ app, servers, wss, close }}
 */
function createWebServer(config, watcher, taskQueue, pmManager, router) {
  const port = parseInt(process.env.WEB_PORT) || 3000;
  const token = process.env.WEB_TOKEN;
  const workerSecret = process.env.HIVE_WORKER_SECRET;

  if (!token && !auth.isOAuthEnabled()) {
    console.warn('Neither WEB_TOKEN nor GitHub OAuth configured -- web dashboard disabled');
    return null;
  }

  const app = express();

  // Wire GitHub OAuth routes (before static files so /auth/* routes take priority)
  auth.wireAuthRoutes(app, taskQueue);

  // Serve dashboard — if OAuth enabled, protect with cookie check
  if (auth.isOAuthEnabled()) {
    app.use((req, res, next) => {
      // Allow auth routes and static assets through
      if (req.path.startsWith('/auth/') || req.path.startsWith('/upload/')) return next();
      // Check for valid JWT cookie
      const cookieToken = auth.parseCookie(req.headers.cookie);
      const user = cookieToken ? auth.verifyToken(cookieToken) : null;
      if (!user) {
        // Redirect to GitHub OAuth login
        return res.redirect('/auth/github');
      }
      next();
    });
  }

  app.use(express.static(path.join(__dirname, 'public')));

  // -- Image upload endpoint -----------------------------------------------
  const uploadDir = path.join(os.tmpdir(), 'hive-uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  app.post('/upload/image', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('image/')) {
      return res.status(400).json({ success: false, error: 'Content-Type must be image/*' });
    }
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };
    const ext = extMap[ct] || 'png';
    const filename = `hive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filepath = path.join(uploadDir, filename);
    fs.writeFileSync(filepath, req.body);
    res.json({ success: true, path: filepath, filename });
  });

  // TTL cleanup: delete uploaded images older than 1 hour, every 10 minutes
  const uploadTtlInterval = setInterval(() => {
    try {
      const now = Date.now();
      const files = fs.readdirSync(uploadDir);
      let cleaned = 0;
      for (const f of files) {
        const fp = path.join(uploadDir, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > 60 * 60 * 1000) {
            fs.unlinkSync(fp);
            cleaned++;
          }
        } catch {}
      }
      if (cleaned > 0) console.log(`[upload] Cleaned ${cleaned} expired file(s)`);
    } catch {}
  }, 10 * 60 * 1000);

  const wss = new WebSocketServer({ noServer: true });

  // Discover available slash commands
  const commands = discoverCommands(config);

  // Track authenticated clients
  const clients = new Set();
  // Per-client terminal subscriptions: ws -> { interval, session }
  const termSubs = new Map();
  // Track worker connections: ws -> RemoteNode
  const workers = new Map();

  // -- WebSocket handling -----------------------------------------------

  // Track user identity per WebSocket connection
  const wsUser = new WeakMap(); // ws → { login, name, avatar } | null

  // Permission check helper. Returns true if allowed, sends error and returns false otherwise.
  // In legacy token mode (no OAuth), all actions are allowed.
  function checkPermission(ws, user, capability) {
    if (!auth.isOAuthEnabled()) return true; // legacy token mode — no enforcement
    if (!user || !user.login) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return false;
    }
    if (!taskQueue) return true; // no task queue = no permission system
    if (taskQueue.hasPermission(user.login, capability)) return true;
    ws.send(JSON.stringify({ type: 'error', message: `Permission denied: requires "${capability}"` }));
    return false;
  }

  function sendInitialState(ws) {
    const user = wsUser.get(ws) || null;
    ws.send(JSON.stringify({ type: 'config', links: config.links || {} }));
    ws.send(JSON.stringify({ type: 'commands:list', commands }));
    // Send user permissions
    if (auth.isOAuthEnabled() && user && user.login && taskQueue) {
      const u = taskQueue.getUser(user.login);
      ws.send(JSON.stringify({ type: 'user:permissions', permissions: u ? u.permissions : ['view', 'comment'] }));
    }
    sendFleetStatus(ws);
    if (taskQueue) {
      ws.send(JSON.stringify({ type: 'tasks:list', tasks: taskQueue.getTasksList() }));
      ws.send(JSON.stringify({ type: 'auto:status', sessions: taskQueue.getAutoSessions() }));
      ws.send(JSON.stringify({ type: 'approvals:list', approvals: taskQueue.getPendingApprovals() }));
      const feedData = taskQueue.getFeed(null, 50);
      ws.send(JSON.stringify({ type: 'feed:entries', entries: feedData.entries, hasMore: feedData.hasMore }));
      ws.send(JSON.stringify({ type: 'rules:list', rules: taskQueue.getRules() }));
      ws.send(JSON.stringify({ type: 'designations:status', designations: taskQueue.getDesignations() }));
      ws.send(JSON.stringify({ type: 'vim:status', enabled: taskQueue.vimMode }));
      ws.send(JSON.stringify({ type: 'designationDefs:list', defs: taskQueue.getDesignationDefs() }));
      ws.send(JSON.stringify({ type: 'agentRoots:list', roots: taskQueue.getAgentRoots() }));
      ws.send(JSON.stringify({ type: 'agentFiles:list', files: taskQueue.agentFilesList }));
      ws.send(JSON.stringify({ type: 'checklistTemplates:list', templates: taskQueue.getChecklistTemplates() }));
      // Send users list to admins
      if (user && user.login && taskQueue.hasPermission(user.login, 'admin')) {
        ws.send(JSON.stringify({ type: 'users:list', users: taskQueue.getUsersList() }));
      }
    }
    if (pmManager) {
      ws.send(JSON.stringify({ type: 'pm:list', pms: pmManager.getAll() }));
    }
    const workerNodes = Array.from(workers.values()).map(n => ({
      id: n.id, type: n.type, connected: n.connected,
    }));
    ws.send(JSON.stringify({ type: 'nodes:list', nodes: workerNodes }));
  }

  function handleWsConnection(ws, request) {
    let authenticated = false;
    let isWorker = false;

    // Try cookie-based auth immediately for OAuth mode
    if (auth.isOAuthEnabled()) {
      const cookieToken = auth.parseCookie(request?.headers?.cookie);
      const user = cookieToken ? auth.verifyToken(cookieToken) : null;
      if (user) {
        authenticated = true;
        const userInfo = { login: user.sub, name: user.name, avatar: user.avatar };
        // Register user in permission system
        if (taskQueue) taskQueue.ensureUser(userInfo.login, userInfo.name, userInfo.avatar);
        wsUser.set(ws, userInfo);
        clients.add(ws);
        const perms = taskQueue ? (taskQueue.getUser(userInfo.login) || {}).permissions || ['view', 'comment'] : [];
        ws.send(JSON.stringify({ type: 'auth', ok: true, user: userInfo, permissions: perms }));
        sendInitialState(ws);
      }
    }

    // Auth timeout -- must authenticate within 5s
    const authTimeout = authenticated ? null : setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auth timeout' }));
        ws.close();
      }
    }, 5000);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // First message must be auth or worker registration
      if (!authenticated) {
        const authResult = auth.authenticateWebSocket(msg, request);
        if (authResult.authenticated) {
          // Dashboard client
          authenticated = true;
          if (authTimeout) clearTimeout(authTimeout);
          // Register user in permission system
          if (authResult.user && authResult.user.login && taskQueue) {
            taskQueue.ensureUser(authResult.user.login, authResult.user.name, authResult.user.avatar);
          }
          wsUser.set(ws, authResult.user);
          clients.add(ws);
          const perms = (authResult.user && authResult.user.login && taskQueue)
            ? (taskQueue.getUser(authResult.user.login) || {}).permissions || ['view', 'comment']
            : [];
          ws.send(JSON.stringify({ type: 'auth', ok: true, user: authResult.user, permissions: perms }));
          sendInitialState(ws);
        } else if (msg.type === 'worker:register' && workerSecret && msg.secret === workerSecret) {
          // Worker node registration
          authenticated = true;
          isWorker = true;
          clearTimeout(authTimeout);
          const node = new RemoteNode(msg.nodeId, ws);
          router.addNode(node);
          workers.set(ws, node);
          ws.send(JSON.stringify({ type: 'worker:registered', nodeId: msg.nodeId }));
          console.log(`Worker "${msg.nodeId}" connected`);
          // Notify dashboard clients about the new node
          broadcast({ type: 'node:connected', nodeId: msg.nodeId });
        } else {
          ws.send(JSON.stringify({ type: 'auth', ok: false }));
          ws.close();
        }
        return;
      }

      // Worker messages: handle RPC responses and heartbeats
      if (isWorker) {
        if (msg.type === 'rpc:response') {
          const node = workers.get(ws);
          if (node) node.handleResponse(msg);
        }
        // Heartbeats are handled implicitly (connection stays alive)
        return;
      }

      // Dashboard client message routing
      const user = wsUser.get(ws) || null;
      handleMessage(ws, msg, user).catch(err => {
        console.error('Message handler error:', err.message);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      });
    });

    ws.on('close', () => {
      authenticated = false;
      clients.delete(ws);
      clearTermSub(ws);
      clearTimeout(authTimeout);
      // Clean up worker
      const node = workers.get(ws);
      if (node) {
        node.disconnect();
        router.removeNode(node.id);
        workers.delete(ws);
        console.log(`Worker "${node.id}" disconnected`);
        broadcast({ type: 'node:disconnected', nodeId: node.id });
      }
    });

    ws.on('error', () => {
      clients.delete(ws);
      clearTermSub(ws);
      const node = workers.get(ws);
      if (node) {
        node.disconnect();
        router.removeNode(node.id);
        workers.delete(ws);
      }
    });
  }

  wss.on('connection', handleWsConnection);

  // -- Message handlers --------------------------------------------------

  async function handleMessage(ws, msg, user) {
    switch (msg.type) {
      case 'fleet:get':
        await sendFleetStatus(ws);
        break;

      case 'peek': {
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const paneTarget = `${name}:.${config.sessions.claudePane}`;
        const { content: peekContent, cols: peekCols } = await capturePaneAnsi(node, paneTarget);
        ws.send(JSON.stringify({ type: 'terminal:data', session: msg.session, content: peekContent, cols: peekCols }));
        break;
      }

      case 'fleet:search': {
        const query = (msg.query || '').trim();
        if (!query) { ws.send(JSON.stringify({ type: 'fleet:search:result', results: [] })); break; }
        const sessions = await fleet.getFleetStatus(config, router);
        const results = [];
        const queryLower = query.toLowerCase();
        await Promise.all(sessions.map(async (s) => {
          const node = router.nodeFor(s.name);
          if (!node) return;
          const paneTarget = `${s.name}:.${config.sessions.claudePane}`;
          try {
            const { content: searchContent } = await capturePaneAnsi(node, paneTarget);
            const plain = searchContent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
            if (plain.toLowerCase().includes(queryLower)) {
              // Extract matching lines for context
              const matchLines = plain.split('\n')
                .filter(l => l.toLowerCase().includes(queryLower))
                .slice(0, 3)
                .map(l => l.trim());
              results.push({ num: s.num, name: s.name, branch: s.branch, state: s.state, matchLines });
            }
          } catch {}
        }));
        ws.send(JSON.stringify({ type: 'fleet:search:result', query, results }));
        break;
      }

      case 'terminal:subscribe': {
        // Unsubscribe from any previous session
        clearTermSub(ws);
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const paneTarget = `${name}:.${config.sessions.claudePane}`;
        // Send immediately
        const { content: subContent, cols: subCols } = await capturePaneAnsi(node, paneTarget);
        ws.send(JSON.stringify({ type: 'terminal:data', session: msg.session, content: subContent, cols: subCols }));
        // Poll every 2s
        const interval = setInterval(async () => {
          if (ws.readyState !== 1) { clearTermSub(ws); return; }
          try {
            const { content: pollContent, cols: pollCols } = await capturePaneAnsi(node, paneTarget);
            ws.send(JSON.stringify({ type: 'terminal:data', session: msg.session, content: pollContent, cols: pollCols }));
          } catch {
            // Node may have disconnected
          }
        }, 2000);
        termSubs.set(ws, { interval, session: msg.session, name, node });
        break;
      }

      case 'terminal:resize': {
        // Note: resize-pane is intentionally NOT used here because sessions have
        // multi-pane layouts (Claude | server | client). Resizing the Claude pane
        // to match browser width would crush the other panes. Instead, xterm.js
        // adapts to the pane's actual width via the cols sent in terminal:data.
        break;
      }

      case 'terminal:unsubscribe':
        clearTermSub(ws);
        break;

      case 'ask': {
        if (!checkPermission(ws, user, 'send-messages')) break;
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        relay.ask(config, node, name, msg.message, {
          force: true, // manual user input — always send, even if Claude is working
          onStream: (content, isFinal) => {
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify({ type: 'ask:stream', session: msg.session, content, final: isFinal }));
          },
          vimMode: taskQueue ? taskQueue.vimMode : false,
        }).then((result) => {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'ask:done',
            session: msg.session,
            success: result.success,
            response: result.response,
            error: result.error,
            duration: result.duration,
          }));
        });
        break;
      }

      case 'tell': {
        if (!checkPermission(ws, user, 'send-messages')) break;
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        relay.tell(config, node, name, msg.message, { vimMode: taskQueue ? taskQueue.vimMode : false }).then((result) => {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'tell:done',
            session: msg.session,
            success: result.success,
            error: result.error,
          }));
        }).catch((err) => {
          console.error('tell error:', err);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'tell:done', session: msg.session, success: false, error: err.message }));
          }
        });
        break;
      }

      case 'keys': {
        if (!checkPermission(ws, user, 'send-messages')) break;
        // Send raw tmux keys (Enter, Up, Down, Escape, Tab, etc.)
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const paneTarget = `${name}:.${config.sessions.claudePane}`;
        // msg.keys is an array of tmux key names, e.g. ["Enter"], ["Up"], ["Escape"]
        // Keys bar buttons always send raw — vim preamble only applies to typed text (ask/tell)
        for (const key of (msg.keys || [])) {
          await node.exec(`tmux send-keys -t "${paneTarget}" ${key}`);
        }
        ws.send(JSON.stringify({ type: 'keys:done', session: msg.session }));
        break;
      }

      case 'restart': {
        if (!checkPermission(ws, user, 'restart')) break;
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const paneTarget = `${name}:.${config.sessions.claudePane}`;
        // Send Escape, then /exit, wait, then claude --resume
        await node.exec(`tmux send-keys -t "${paneTarget}" Escape`);
        setTimeout(async () => {
          await node.exec(`tmux send-keys -t "${paneTarget}" -l '/exit'`);
          await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
          setTimeout(async () => {
            await node.exec(`tmux send-keys -t "${paneTarget}" -l 'claude --resume'`);
            await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'restart:done', session: msg.session }));
            }
          }, 3000);
        }, 500);
        break;
      }

      // -- Git info messages -----------------------------------------------
      case 'git:info': {
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const num = fleet.sessionNum(name);
        const nc = fleet.getNodeConfig(config, nodeId);
        const repoDir = num ? nc.sessions.repoDir(num) : null;
        if (!repoDir) {
          ws.send(JSON.stringify({ type: 'git:info', session: msg.session, log: [], diffStat: [], stagedStat: [], changedFiles: [], branchDiff: null }));
          return;
        }
        const [log, diffStat, stagedStat, changedFiles, branchDiff] = await Promise.all([
          git.getLog(node, repoDir),
          git.getDiffStat(node, repoDir),
          git.getStagedStat(node, repoDir),
          git.getChangedFiles(node, repoDir),
          git.getBranchDiff(node, repoDir),
        ]);
        ws.send(JSON.stringify({ type: 'git:info', session: msg.session, log, diffStat, stagedStat, changedFiles, branchDiff }));
        break;
      }

      case 'git:diff': {
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const num = fleet.sessionNum(name);
        const nc = fleet.getNodeConfig(config, nodeId);
        const repoDir = num ? nc.sessions.repoDir(num) : null;
        let diff = '';
        if (repoDir) {
          if (msg.commit) {
            diff = await git.getCommitFileDiff(node, repoDir, msg.commit, msg.file);
          } else {
            diff = await git.getFileDiff(node, repoDir, msg.file, msg.base);
          }
        }
        ws.send(JSON.stringify({ type: 'git:diff', session: msg.session, file: msg.file, diff }));
        break;
      }

      case 'git:commit': {
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const num = fleet.sessionNum(name);
        const nc = fleet.getNodeConfig(config, nodeId);
        const repoDir = num ? nc.sessions.repoDir(num) : null;
        const files = repoDir ? await git.getCommitFiles(node, repoDir, msg.hash) : [];
        ws.send(JSON.stringify({ type: 'git:commit', session: msg.session, hash: msg.hash, files }));
        break;
      }

      // -- Task queue messages ----------------------------------------------
      case 'task:create': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'create-tasks')) break;
        const task = taskQueue.createTask(msg.text, msg.mode, msg.targetSession, msg.designation, { createdBy: user?.login || null });
        ws.send(JSON.stringify({ type: 'task:created', task }));
        break;
      }

      case 'task:attach': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'create-tasks')) break;
        const task = taskQueue.attachTask(msg.text, msg.session, msg.meta);
        broadcast({ type: 'task:created', task });
        broadcast({ type: 'task:dispatched', task });
        ws.send(JSON.stringify({ type: 'task:attached', task }));
        break;
      }

      case 'task:update': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'create-tasks')) break;
        const updatedTask = taskQueue.updateTask(msg.taskId, msg.updates || {});
        if (updatedTask) broadcast({ type: 'task:updated', task: updatedTask });
        break;
      }

      case 'task:snapshot': {
        if (!taskQueue) break;
        const snapTask = taskQueue.tasks.get(msg.taskId);
        if (snapTask && snapTask.snapshot) {
          ws.send(JSON.stringify({ type: 'task:snapshot', taskId: msg.taskId, content: snapTask.snapshot, cols: snapTask.snapshotCols || 0 }));
        }
        break;
      }

      case 'task:dispatch': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'dispatch')) break;
        taskQueue.dispatchTaskTo(msg.taskId, msg.session).then((task) => {
          if (task) broadcast({ type: 'task:dispatched', task });
          else if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: 'Could not dispatch task — not queued or session unavailable' }));
        }).catch((err) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: err.message }));
        });
        break;
      }

      case 'task:cancel': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'cancel')) break;
        const cancelledTask = taskQueue.cancelTask(msg.taskId);
        if (cancelledTask) broadcast({ type: 'task:cancelled', task: cancelledTask });
        break;
      }

      case 'task:complete': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'cancel')) break;
        const task = taskQueue.completeTask(msg.taskId, msg.result || 'Manually completed');
        if (task) broadcast({ type: 'task:completed', task });
        break;
      }

      case 'auto:toggle': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'dispatch')) break;
        taskQueue.toggleAutoSession(msg.session);
        break;
      }

      case 'auto:set': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'dispatch')) break;
        taskQueue.setAutoSessions(msg.sessions || []);
        break;
      }

      case 'broadcast': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'send-messages')) break;
        taskQueue.broadcast(msg.message, msg.target, msg.sessions).then((result) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'broadcast:done', sent: result.sent, failed: result.failed }));
          }
        });
        break;
      }

      case 'approval:respond': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'send-messages')) break;
        const approval = await taskQueue.resolveApproval(msg.approvalId, msg.approved);
        if (approval) ws.send(JSON.stringify({ type: 'approval:resolved', approval }));
        break;
      }

      case 'feed:get': {
        if (!taskQueue) break;
        const feedData = taskQueue.getFeed(msg.before, msg.limit);
        ws.send(JSON.stringify({ type: 'feed:entries', entries: feedData.entries, hasMore: feedData.hasMore }));
        break;
      }

      case 'rule:toggle': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.toggleRule(msg.ruleId);
        break;
      }

      // -- Designation messages ---------------------------------------------
      case 'designation:set': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.setDesignation(msg.session, msg.designation);
        break;
      }

      case 'designationDef:set': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.setDesignationDef(msg.name, { agentFiles: msg.agentFiles, description: msg.description });
        break;
      }

      case 'designationDef:remove': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.removeDesignationDef(msg.name);
        break;
      }

      case 'designationDefs:get': {
        if (!taskQueue) break;
        ws.send(JSON.stringify({ type: 'designationDefs:list', defs: taskQueue.getDesignationDefs() }));
        break;
      }

      case 'agentRoots:set': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.setAgentRoots(msg.roots);
        taskQueue.scanAgentFiles();
        ws.send(JSON.stringify({ type: 'agentFiles:list', files: taskQueue.agentFilesList }));
        break;
      }

      case 'agentFiles:scan': {
        if (!taskQueue) break;
        const files = taskQueue.scanAgentFiles();
        ws.send(JSON.stringify({ type: 'agentFiles:list', files }));
        break;
      }

      case 'agentFiles:get': {
        if (!taskQueue) break;
        ws.send(JSON.stringify({ type: 'agentFiles:list', files: taskQueue.agentFilesList }));
        break;
      }

      // -- VIM mode messages -------------------------------------------------
      case 'vim:toggle': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.setVimMode(msg.enabled);
        broadcast({ type: 'vim:status', enabled: taskQueue.vimMode });
        break;
      }

      // -- Spawn messages ---------------------------------------------------
      case 'spawn:slots': {
        if (!taskQueue) break;
        const slots = await taskQueue.getAvailableSlots();
        ws.send(JSON.stringify({ type: 'spawn:slots', slots, slotMin: taskQueue.spawnSlotMin, slotMax: taskQueue.spawnSlotMax }));
        break;
      }

      case 'spawn:config': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        if (msg.min !== undefined && msg.max !== undefined) {
          taskQueue.setSpawnSlotRange(msg.min, msg.max);
        }
        ws.send(JSON.stringify({ type: 'spawn:config', min: taskQueue.spawnSlotMin, max: taskQueue.spawnSlotMax }));
        break;
      }

      case 'spawn': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.spawnSession({
          num: msg.num,
          baseDir: msg.baseDir,
          name: msg.name,
          gitUrl: msg.gitUrl,
        }).then((result) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'spawn:done', success: true, num: result.num, repoDir: result.repoDir }));
          }
          // Refresh fleet for all clients after a delay
          setTimeout(() => {
            broadcastFleetStatus().catch(() => {});
          }, 3000);
        }).catch((err) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'spawn:done', success: false, error: err.message }));
          }
        });
        break;
      }

      // -- PM messages -------------------------------------------------------
      case 'pm:create': {
        if (!pmManager) break;
        if (!checkPermission(ws, user, 'admin')) break;
        const pm = pmManager.create(msg.config);
        ws.send(JSON.stringify({ type: 'pm:created', pm }));
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:update': {
        if (!pmManager) break;
        if (!checkPermission(ws, user, 'admin')) break;
        pmManager.update(msg.id, msg.updates);
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:delete': {
        if (!pmManager) break;
        if (!checkPermission(ws, user, 'admin')) break;
        pmManager.remove(msg.id);
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:toggle': {
        if (!pmManager) break;
        if (!checkPermission(ws, user, 'admin')) break;
        pmManager.toggle(msg.id);
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:rescan': {
        if (!pmManager) break;
        if (!checkPermission(ws, user, 'admin')) break;
        pmManager.rescan(msg.id);
        ws.send(JSON.stringify({ type: 'pm:rescan:done', id: msg.id }));
        break;
      }

      case 'pm:list': {
        if (!pmManager) break;
        ws.send(JSON.stringify({ type: 'pm:list', pms: pmManager.getAll() }));
        break;
      }

      // -- Task comment messages ----------------------------------------------
      case 'task:comment:add': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'comment')) break;
        const comment = taskQueue.addComment(msg.taskId, user?.login, user?.name, msg.text);
        if (!comment) {
          ws.send(JSON.stringify({ type: 'error', message: 'Task not found' }));
        }
        // Broadcast handled by event bridge below
        break;
      }

      case 'task:comment:delete': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'comment')) break;
        const deleted = taskQueue.deleteComment(msg.taskId, msg.commentId, user?.login);
        if (!deleted) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot delete comment' }));
        }
        // Broadcast handled by event bridge below
        break;
      }

      // -- Checklist template messages ------------------------------------------
      case 'checklistTemplate:set': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.setChecklistTemplate(msg.name, msg.items);
        break;
      }

      case 'checklistTemplate:delete': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.removeChecklistTemplate(msg.name);
        break;
      }

      // -- Task checklist messages ---------------------------------------------
      case 'task:checklist:toggle': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'create-tasks')) break;
        taskQueue.toggleChecklistItem(msg.taskId, msg.itemId);
        break;
      }

      case 'task:checklist:add': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'create-tasks')) break;
        taskQueue.addChecklistItem(msg.taskId, msg.text);
        break;
      }

      case 'task:checklist:remove': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'create-tasks')) break;
        taskQueue.removeChecklistItem(msg.taskId, msg.itemId);
        break;
      }

      case 'task:checklist:seed': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'create-tasks')) break;
        const tpl = taskQueue.checklistTemplates.get(msg.templateName);
        if (tpl) {
          const checklist = tpl.items.map(text => ({ text, checked: false }));
          taskQueue.setTaskChecklist(msg.taskId, checklist);
        }
        break;
      }

      // -- User permission messages -------------------------------------------
      case 'users:list': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        ws.send(JSON.stringify({ type: 'users:list', users: taskQueue.getUsersList() }));
        break;
      }

      case 'users:setPermissions': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        // Self-demotion prevention: can't remove own admin
        if (msg.login === user?.login && !(msg.permissions || []).includes('admin')) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot remove your own admin permission' }));
          break;
        }
        const updated = taskQueue.setUserPermissions(msg.login, msg.permissions || []);
        if (updated) {
          // Broadcast updated permissions to all clients
          broadcast({ type: 'users:updated', user: updated });
          // Send updated permissions to the affected user's connections
          for (const client of clients) {
            const clientUser = wsUser.get(client);
            if (clientUser && clientUser.login === msg.login && client.readyState === 1) {
              client.send(JSON.stringify({ type: 'user:permissions', permissions: updated.permissions }));
            }
          }
        }
        break;
      }

      case 'users:add': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        const login = (msg.login || '').trim();
        if (!login) {
          ws.send(JSON.stringify({ type: 'error', message: 'GitHub username is required' }));
          break;
        }
        taskQueue.addUser(login, msg.permissions);
        break;
      }

      case 'users:remove': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        const login = (msg.login || '').trim().toLowerCase();
        if (!login) break;
        // Can't remove yourself
        if (login === user?.login?.toLowerCase()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot remove yourself' }));
          break;
        }
        taskQueue.removeUser(login);
        break;
      }
    }
  }

  function clearTermSub(ws) {
    const sub = termSubs.get(ws);
    if (sub) {
      clearInterval(sub.interval);
      termSubs.delete(ws);
    }
  }

  // -- Fleet status broadcast --------------------------------------------

  // Noise patterns to strip from previews (already shown in badges or not useful)
  const PREVIEW_NOISE = [
    /^https?:\/\//i,
    /^PR[:#]\s*\d/i,
    /^CI\s/i,
    /^Jenkins/i,
    /^Slack:/i,
    /^Commit\s+[a-f0-9]/i,
    /^Branch:/i,
    /^merge\s+PR\s/i,
    /^\s*no JIRA/i,
    /^\s*In Review$/i,
    /^\s*PASS|FAIL|SUCCESS|FAILURE$/i,
    /^Try\s+"/,
    /^Press Ctrl/i,
    /^No conversations found/i,
    /^claude\s+--resume/i,
    /default interactive shell/i,
    /support\.apple\.com/i,
  ];

  function cleanPreview(content) {
    if (!content) return '';
    const lines = content.split('\n')
      .map(l => l.trimEnd())
      .filter(l => {
        const t = l.trim();
        if (!t) return false;
        for (const pat of PREVIEW_NOISE) {
          if (pat.test(t)) return false;
        }
        return true;
      });
    return lines.slice(-5).join('\n');
  }

  // Cache for full fleet with previews (same pattern as getFleetStatus)
  let _previewCache = { result: null, ts: 0, pending: null };
  const PREVIEW_CACHE_TTL = 10000; // 10s

  async function getFleetWithPreviews() {
    const now = Date.now();
    if (_previewCache.result && now - _previewCache.ts < PREVIEW_CACHE_TTL) {
      return _previewCache.result;
    }
    if (_previewCache.pending) return _previewCache.pending;

    _previewCache.pending = (async () => {
      const t0 = Date.now();
      const sessions = await fleet.getFleetStatus(config, router);
      for (const s of sessions) {
        // Prefer watcher-tracked activity (state transitions), fall back to tmux window_activity
        const watcherActivity = watcher.sessionActivity.get(s.num);
        if (watcherActivity) s.lastActivity = watcherActivity;
        try {
          const node = router.nodeFor(s.name);
          if (node) {
            const content = await fleet.peekSession(config, node, s.name);
            s.preview = cleanPreview(content);
          } else {
            s.preview = '';
          }
        } catch {
          s.preview = '';
        }
        // Git summary from already-fetched data (no extra shell calls)
        s.gitSummary = {
          lastCommit: '',
          lastCommitTime: '',
          totalChanges: s.git ? s.git.staged + s.git.modified + s.git.untracked : 0,
        };
      }
      console.log(`[perf] getFleetWithPreviews: ${Date.now() - t0}ms`);
      _previewCache.result = sessions;
      _previewCache.ts = Date.now();
      _previewCache.pending = null;
      return sessions;
    })();
    return _previewCache.pending;
  }

  async function sendFleetStatus(ws) {
    // Send basic status immediately so the UI renders fast
    const t0 = Date.now();
    const sessions = await fleet.getFleetStatus(config, router);
    console.log(`[perf] getFleetStatus: ${Date.now() - t0}ms`);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'fleet:status', sessions }));
    }
    // Then fill in previews/git summaries and send again
    const t1 = Date.now();
    const full = await getFleetWithPreviews();
    console.log(`[perf] getFleetWithPreviews: ${Date.now() - t1}ms`);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'fleet:status', sessions: full }));
    }
  }

  async function broadcastFleetStatus() {
    const sessions = await getFleetWithPreviews();
    const msg = JSON.stringify({ type: 'fleet:status', sessions });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  // Broadcast fleet status every 15s
  const fleetInterval = setInterval(() => {
    broadcastFleetStatus().catch(err => console.error('Fleet broadcast error:', err.message));
  }, 15000);

  // Background PR/CI status refresh — runs every 5 min, fetches one branch at a time
  async function refreshPRStatus() {
    try {
      const sessions = await fleet.getFleetStatus(config, router);
      const branches = [...new Set(sessions.map(s => s.branch).filter(b => b && b !== 'master' && b !== 'main'))];
      for (const branch of branches) {
        await prStatus.fetch(branch, config);
      }
      // Broadcast updated fleet so badges refresh
      broadcastFleetStatus().catch(() => {});
    } catch (err) {
      console.error('PR status refresh error:', err.message);
    }
  }
  // Initial fetch after 10s (let fleet cache warm up first), then every 5 min
  setTimeout(() => {
    refreshPRStatus();
    setInterval(refreshPRStatus, 300000);
  }, 10000);

  // -- Watcher event bridge -----------------------------------------------

  function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  watcher.on('session:idle', ({ session, name, num }) => {
    broadcast({ type: 'notify', event: 'session:idle', session: num, name });
    broadcastFleetStatus().catch(() => {});
  });

  watcher.on('session:working', ({ session, name, num }) => {
    broadcast({ type: 'notify', event: 'session:working', session: num, name });
  });

  watcher.on('ci:changed', ({ name, num, from, to, pr }) => {
    broadcast({ type: 'notify', event: 'ci:changed', session: num, name, from, to, pr });
    broadcastFleetStatus().catch(() => {});
  });

  // -- TaskQueue event bridge ---------------------------------------------

  if (taskQueue) {
    taskQueue.on('task:created', (task) => broadcast({ type: 'task:created', task }));
    taskQueue.on('task:dispatched', (task) => broadcast({ type: 'task:dispatched', task }));
    taskQueue.on('task:completed', (task) => broadcast({ type: 'task:completed', task }));
    taskQueue.on('task:failed', (task) => broadcast({ type: 'task:failed', task }));
    taskQueue.on('task:cancelled', (task) => broadcast({ type: 'task:cancelled', task }));
    taskQueue.on('task:updated', (task) => broadcast({ type: 'task:updated', task }));
    taskQueue.on('auto:changed', (sessions) => broadcast({ type: 'auto:status', sessions }));
    taskQueue.on('feed:new', (entry) => broadcast({ type: 'feed:new', entry }));
    taskQueue.on('approval:new', (approval) => broadcast({ type: 'approval:new', approval }));
    taskQueue.on('approval:resolved', (approval) => broadcast({ type: 'approval:resolved', approval }));
    taskQueue.on('rules:changed', (rules) => broadcast({ type: 'rules:list', rules }));
    taskQueue.on('designations:changed', (designations) => broadcast({ type: 'designations:status', designations }));
    taskQueue.on('designationDefs:changed', (defs) => broadcast({ type: 'designationDefs:list', defs }));
    taskQueue.on('agentRoots:changed', (roots) => broadcast({ type: 'agentRoots:list', roots }));
    taskQueue.on('agentFiles:scanned', (files) => broadcast({ type: 'agentFiles:list', files }));
    taskQueue.on('vim:changed', (enabled) => broadcast({ type: 'vim:status', enabled }));
    taskQueue.on('spawnSlotRange:changed', (range) => broadcast({ type: 'spawn:config', min: range.min, max: range.max }));
    taskQueue.on('task:comment:added', (data) => broadcast({ type: 'task:comment:added', taskId: data.taskId, comment: data.comment }));
    taskQueue.on('task:comment:deleted', (data) => broadcast({ type: 'task:comment:deleted', taskId: data.taskId, commentId: data.commentId }));
    taskQueue.on('checklistTemplates:changed', (templates) => broadcast({ type: 'checklistTemplates:list', templates }));
    taskQueue.on('users:changed', (users) => {
      // Only send full users list to admins
      for (const client of clients) {
        const clientUser = wsUser.get(client);
        if (clientUser && clientUser.login && taskQueue.hasPermission(clientUser.login, 'admin') && client.readyState === 1) {
          client.send(JSON.stringify({ type: 'users:list', users }));
        }
      }
    });
  }

  if (pmManager) {
    pmManager.on('pm:error', (data) => broadcast({ type: 'pm:error', id: data.id, error: data.error }));
    pmManager.on('pm:changed', () => broadcast({ type: 'pm:list', pms: pmManager.getAll() }));
  }

  // -- Start servers (localhost + Tailscale only) ---------------------------

  const bindHosts = getBindHosts();
  const servers = [];

  for (const host of bindHosts) {
    const httpServer = http.createServer(app);
    httpServer.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
    httpServer.listen(port, host, () => {
      console.log(`Web dashboard: http://${host}:${port}`);
    });
    servers.push(httpServer);
  }

  if (workerSecret) {
    console.log(`Worker registration enabled on port ${port}`);
  }

  // Initial agent file scan on startup
  if (taskQueue && taskQueue.agentRoots.length > 0) {
    taskQueue.scanAgentFiles();
    console.log(`Scanned ${taskQueue.agentFilesList.length} agent files from ${taskQueue.agentRoots.length} root(s)`);
  }

  const tsIP = getTailscaleIP();
  if (tsIP) {
    console.log(`Tailscale access enabled (${tsIP})`);
  } else if (!process.env.WEB_BIND) {
    console.log('No Tailscale interface found — dashboard is localhost-only');
  }

  // Cleanup
  function close() {
    clearInterval(fleetInterval);
    clearInterval(uploadTtlInterval);
    for (const ws of clients) {
      clearTermSub(ws);
      ws.close();
    }
    clients.clear();
    for (const [ws, node] of workers) {
      node.disconnect();
      router.removeNode(node.id);
      ws.close();
    }
    workers.clear();
    for (const s of servers) s.close();
  }

  return { app, servers, wss, close };
}

module.exports = { createWebServer };
