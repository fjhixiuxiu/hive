const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execSync, spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const fleet = require('../../core/fleet');
const relay = require('../../core/relay');
const git = require('../../core/git');
const tmux = require('../../core/tmux');
const RemoteNode = require('../../core/remote-node');
const auth = require('../../core/auth');
const prStatus = require('../../core/pr-status');
const log = require('../../core/log');
const {
  HIVE_CONSOLE_SESSION, HIVE_CONSOLE_DIR, ghExecEnv, setupPath,
  isSetupComplete, decorateTaskActions, executeTaskAction,
  getTailscaleIP, getBindHosts, scanCommands, discoverCommands,
  capturePaneAnsi,
} = require('./ws-helpers');
const createMessageHandler = require('./ws-handlers');
const VoiceAgent = require('../voice');

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
  const sessionManager = require('../../core/session-manager');
  const port = parseInt(process.env.WEB_PORT) || 3000;
  const token = process.env.WEB_TOKEN;
  const workerSecret = process.env.HIVE_WORKER_SECRET;

  if (!token && !auth.isOAuthEnabled()) {
    log.warn('Neither WEB_TOKEN nor GitHub OAuth configured -- web dashboard disabled');
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

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      // Prevent browser caching of HTML/JS/CSS during development
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));

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
      if (cleaned > 0) log.info(`[upload] Cleaned ${cleaned} expired file(s)`);
    } catch {}
  }, 10 * 60 * 1000);

  // -- REST API for session context (MCP tool integration) -------------------
  app.use('/api/context', express.json());

  app.get('/api/context/:session', (req, res) => {
    if (!taskQueue) return res.status(503).json({ error: 'Not ready' });
    const ctx = taskQueue.getSessionContext(req.params.session);
    res.json({ session: Number(req.params.session), context: ctx });
  });

  app.put('/api/context/:session', (req, res) => {
    if (!taskQueue) return res.status(503).json({ error: 'Not ready' });
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object of key-value pairs' });
    }
    const num = Number(req.params.session);
    const updated = taskQueue.setSessionContext(num, updates);
    broadcast({ type: 'context:updated', session: num, context: updated });
    res.json({ session: num, context: updated });
  });

  app.delete('/api/context/:session', (req, res) => {
    if (!taskQueue) return res.status(503).json({ error: 'Not ready' });
    const num = Number(req.params.session);
    taskQueue.clearSessionContext(num);
    broadcast({ type: 'context:updated', session: num, context: {} });
    res.json({ session: num, context: {} });
  });

  // -- Plan file reading (for session plan pane) ----------------------------
  // WS handler reads plan file from the session's node; exposed as a message type
  // so the dashboard can poll it. No REST needed — file is on the tmux host.

  const wss = new WebSocketServer({ noServer: true });

  // Discover available slash commands
  const commands = discoverCommands(config);

  // Track authenticated clients
  const clients = new Set();
  // Per-client terminal subscriptions: ws -> { interval, session }
  const termSubs = new Map();
  // Per-client console (session 0) subscriptions: ws -> { interval, cancelled }
  const consoleSubs = new Map();
  // Per-client card terminal subscriptions: ws -> Map<"session:pane", sub>
  const cardTermSubs = new Map();
  // Track worker connections: ws -> RemoteNode
  const workers = new Map();
  // Track MCP service connections: ws -> { session }
  const mcpClients = new Map();
  // Fleet preview cache (used by handleMessage and broadcastFleetStatus)
  let _previewCache = { result: null, ts: 0, pending: null };

  // -- WebSocket handling -----------------------------------------------

  // Track user identity per WebSocket connection
  const wsUser = new WeakMap(); // ws → { login, name, avatar } | null

  // Permission check helper. Returns true if allowed, sends error and returns false otherwise.
  // In legacy token mode (no OAuth), all actions are allowed.
  function checkPermission(ws, user, capability) {
    if (!auth.isOAuthEnabled()) return true; // legacy token mode — no enforcement
    if (user && user.login === '__service__') return true; // WEB_TOKEN service accounts have full access
    if (!user || !user.login) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return false;
    }
    if (!taskQueue) return true; // no task queue = no permission system
    if (taskQueue.hasPermission(user.login, capability)) return true;
    ws.send(JSON.stringify({ type: 'error', message: `Permission denied: requires "${capability}"` }));
    return false;
  }

  async function sendInitialState(ws) {
    // If setup wizard hasn't run, send setup:required instead of fleet data
    if (!isSetupComplete()) {
      const statePath = path.join(__dirname, '..', '..', '..', '.hive-state.json');
      let existingState = null;
      try {
        if (fs.existsSync(statePath)) {
          const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          const tasks = (raw.tasks || []).length;
          const sessions = (raw.autoSessions || []).length;
          const designations = Object.keys(raw.designations || {}).length;
          if (tasks || sessions || designations) {
            existingState = { tasks, sessions, designations };
          }
        }
      } catch {}
      ws.send(JSON.stringify({ type: 'setup:required', existingState }));
      return;
    }

    const user = wsUser.get(ws) || null;
    ws.send(JSON.stringify({ type: 'config', links: config.links || {}, spawnBaseDir: process.env.HIVE_REPO_DIR || '~/ai-dev', hiveName: config.sessions?.hiveName || '' }));
    ws.send(JSON.stringify({ type: 'commands:list', commands }));
    // Send user permissions
    if (auth.isOAuthEnabled() && user && user.login && taskQueue) {
      const u = taskQueue.getUser(user.login);
      ws.send(JSON.stringify({ type: 'user:permissions', permissions: u ? u.permissions : ['view', 'comment'] }));
    }
    await sendFleetStatus(ws);
    if (taskQueue) {
      ws.send(JSON.stringify({ type: 'workStates:list', states: taskQueue.getWorkStates() }));
      ws.send(JSON.stringify({ type: 'tasks:list', tasks: taskQueue.getTasksList().map(t => decorateTaskActions(t, pmManager)) }));
      ws.send(JSON.stringify({ type: 'auto:status', sessions: taskQueue.getAutoSessions() }));
      ws.send(JSON.stringify({ type: 'approvals:list', approvals: taskQueue.getPendingApprovals() }));
      const feedData = taskQueue.getFeed(null, 50);
      ws.send(JSON.stringify({ type: 'feed:entries', entries: feedData.entries, hasMore: feedData.hasMore }));
      ws.send(JSON.stringify({ type: 'rules:list', rules: taskQueue.getRules() }));
      ws.send(JSON.stringify({ type: 'designations:status', designations: taskQueue.getDesignations() }));
      ws.send(JSON.stringify({ type: 'vim:status', enabled: taskQueue.vimMode }));
      ws.send(JSON.stringify({ type: 'taskAutoComplete:status', enabled: taskQueue.taskAutoComplete }));
      ws.send(JSON.stringify({ type: 'designationDefs:list', defs: taskQueue.getDesignationDefs() }));
      ws.send(JSON.stringify({ type: 'agentRoots:list', roots: taskQueue.getAgentRoots() }));
      ws.send(JSON.stringify({ type: 'agentFiles:list', files: taskQueue.agentFilesList }));
      ws.send(JSON.stringify({ type: 'checklistTemplates:list', templates: taskQueue.getChecklistTemplates() }));
      ws.send(JSON.stringify({ type: 'spawnedAgents:list', agents: taskQueue.getSpawnedAgentsList() }));
      ws.send(JSON.stringify({ type: 'context:all', contexts: taskQueue.getAllSessionContexts() }));
      // Send users list to admins (legacy token mode = no user, send to all)
      if (!user || (user.login && taskQueue.hasPermission(user.login, 'admin'))) {
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
    // Session 0 (hive console) status
    tmux.hasSession(HIVE_CONSOLE_SESSION).then(exists => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'console:status', available: exists }));
    }).catch(() => {});
    // Integration status (configured or not, without revealing tokens)
    ws.send(JSON.stringify({
      type: 'integration:status',
      integrations: {
        github: { configured: !!process.env.GITHUB_TOKEN },
        jenkins: { configured: !!(process.env.JENKINS_URL && process.env.JENKINS_USER && process.env.JENKINS_API_TOKEN) },
        slack: { configured: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) },
        jira: { configured: !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) },
      }
    }));
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
          log.info(`Worker "${msg.nodeId}" connected`);
          // Notify dashboard clients about the new node
          broadcast({ type: 'node:connected', nodeId: msg.nodeId });
        } else if (msg.type === 'auth' && msg.token && msg.token === process.env.WEB_TOKEN) {
          // MCP service auth — accept WEB_TOKEN even in OAuth mode
          authenticated = true;
          if (authTimeout) clearTimeout(authTimeout);
          // Set service identity so permission checks (admin, etc.) pass
          const serviceUser = { login: '__service__', name: 'Service', avatar: null };
          wsUser.set(ws, serviceUser);
          clients.add(ws);
          // Track as MCP client if session param present in URL
          const urlParams = new URL(request.url, 'http://localhost').searchParams;
          const mcpSession = urlParams.get('session');
          if (mcpSession != null) {
            mcpClients.set(ws, { session: Number(mcpSession) });
            log.info(`MCP client connected for session ${mcpSession}`);
          }
          ws.send(JSON.stringify({ type: 'auth', ok: true, user: serviceUser }));
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
        log.error('Message handler error:', err.message);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      });
    });

    ws.on('close', () => {
      authenticated = false;
      clients.delete(ws);
      mcpClients.delete(ws);
      clearTermSub(ws);
      clearConsoleSub(ws);
      clearAllCardSubs(ws);
      clearTimeout(authTimeout);
      // Clean up worker
      const node = workers.get(ws);
      if (node) {
        node.disconnect();
        router.removeNode(node.id);
        workers.delete(ws);
        log.info(`Worker "${node.id}" disconnected`);
        broadcast({ type: 'node:disconnected', nodeId: node.id });
      }
    });

    ws.on('error', () => {
      clients.delete(ws);
      mcpClients.delete(ws);
      clearTermSub(ws);
      clearConsoleSub(ws);
      clearAllCardSubs(ws);
      const node = workers.get(ws);
      if (node) {
        node.disconnect();
        router.removeNode(node.id);
        workers.delete(ws);
      }
    });
  }

  wss.on('connection', handleWsConnection);

  // -- Voice agent setup ---------------------------------------------------
  const voiceAgent = new VoiceAgent({
    taskQueue, watcher, router, config,
    knowledgeBase: pmManager ? (entry) => pmManager.addKnowledge(entry) : null,
  });
  const voiceAudioWss = voiceAgent.setupAudioBridge();

  // Broadcast voice events to dashboard clients
  voiceAgent.on('transcript', (entry) => {
    broadcast({ type: 'voice:transcript:entry', entry });
  });
  voiceAgent.on('response', (text) => {
    broadcast({ type: 'voice:response', text });
  });
  voiceAgent.on('joined', () => {
    const status = voiceAgent.getStatus();
    broadcast({ type: 'voice:status', status });
    broadcast({ type: 'voice:meetings', meetings: voiceAgent.getMeetings(), status });
  });
  voiceAgent.on('left', () => {
    const status = voiceAgent.getStatus();
    broadcast({ type: 'voice:status', status });
    broadcast({ type: 'voice:meetings', meetings: voiceAgent.getMeetings(), status });
  });
  voiceAgent.on('speaking', (isSpeaking) => {
    broadcast({ type: 'voice:speaking', speaking: isSpeaking });
  });
  voiceAgent.on('task-created', (task) => {
    broadcast({ type: 'voice:task-created', task });
  });
  voiceAgent.on('task-action', (action) => {
    broadcast({ type: 'voice:task-action', ...action });
  });

  // -- Message handlers (extracted to ws-handlers.js) ----------------------

  const handleMessage = createMessageHandler({
    config, taskQueue, pmManager, router,
    broadcast, checkPermission, resolveSession,
    clearTermSub, clearConsoleSub, termSubs, consoleSubs,
    clearCardSub, clearAllCardSubs, cardTermSubs,
    sendFleetStatus, broadcastFleetStatus, sendInitialState, _previewCache,
    commands, clients, wsUser, workers, mcpClients, voiceAgent,
  });

  // ── Session 0 helper: resolve session (fleet or hive-console) ──
  async function resolveSession(msg) {
    if (String(msg.session) === 'hive-console') {
      const exists = await tmux.hasSession(HIVE_CONSOLE_SESSION);
      if (!exists) return null;
      return { name: HIVE_CONSOLE_SESSION, nodeId: 'local' };
    }
    if (String(msg.session) === 'hive-voice') {
      const exists = await tmux.hasSession('hive-voice');
      if (!exists) return null;
      return { name: 'hive-voice', nodeId: 'local' };
    }
    return fleet.findSession(config, router, msg.session);
  }

  function clearTermSub(ws) {
    const sub = termSubs.get(ws);
    if (sub) {
      sub.cancelled = true;
      clearInterval(sub.interval);
      termSubs.delete(ws);
    }
  }

  function clearConsoleSub(ws) {
    const sub = consoleSubs.get(ws);
    if (sub) {
      sub.cancelled = true;
      clearInterval(sub.interval);
      consoleSubs.delete(ws);
    }
  }

  function clearCardSub(ws, subKey) {
    const subs = cardTermSubs.get(ws);
    if (!subs) return;
    const sub = subs.get(subKey);
    if (sub) {
      sub.cancelled = true;
      clearInterval(sub.interval);
      subs.delete(subKey);
    }
    if (subs.size === 0) cardTermSubs.delete(ws);
  }

  function clearAllCardSubs(ws) {
    const subs = cardTermSubs.get(ws);
    if (!subs) return;
    for (const sub of subs.values()) {
      sub.cancelled = true;
      clearInterval(sub.interval);
    }
    cardTermSubs.delete(ws);
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

  // _previewCache is declared earlier (line ~152) and shared with ws-handlers
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
          const node = s._node || router.nodeFor(s.name);
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
      const withPreview = sessions.filter(s => s.preview).length;
      log.info(`[perf] getFleetWithPreviews: ${Date.now() - t0}ms (${withPreview}/${sessions.length} have previews)`);
      _previewCache.result = sessions;
      _previewCache.ts = Date.now();
      _previewCache.pending = null;

      // Write session label map for tmux tabs.sh (non-blocking)
      const FIXED_NAMES = { 1: 'Reviews', 2: 'Ideas', 3: 'Urgent', 4: 'Tests' };
      const labels = {};
      for (const s of sessions) {
        if (s.num == null) continue;
        if (FIXED_NAMES[s.num]) {
          labels[s.num] = FIXED_NAMES[s.num];
        } else if (s.branch && s.branch !== 'master' && s.branch !== 'main') {
          labels[s.num] = s.branch.replace(/^[^/]+\//, '');
        }
      }
      fs.writeFile('/tmp/hive-session-labels.json', JSON.stringify(labels), () => {});

      return sessions;
    })();
    return _previewCache.pending;
  }

  async function sendFleetStatus(ws) {
    // Send basic status immediately so the UI renders fast
    const t0 = Date.now();
    const sessions = await fleet.getFleetStatus(config, router);
    log.info(`[perf] getFleetStatus: ${Date.now() - t0}ms`);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'fleet:status', sessions }));
    }
    // Then fill in previews/git summaries and send again
    const t1 = Date.now();
    const full = await getFleetWithPreviews();
    log.info(`[perf] getFleetWithPreviews: ${Date.now() - t1}ms`);
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
    broadcastFleetStatus().catch(err => log.error('Fleet broadcast error:', err.message));
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
      log.error('PR status refresh error:', err.message);
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
    taskQueue.on('task:created', (task) => broadcast({ type: 'task:created', task: decorateTaskActions(task, pmManager) }));
    taskQueue.on('task:dispatched', (task) => broadcast({ type: 'task:dispatched', task: decorateTaskActions(task, pmManager) }));
    taskQueue.on('task:completed', (task) => broadcast({ type: 'task:completed', task: decorateTaskActions(task, pmManager) }));
    taskQueue.on('task:failed', (task) => broadcast({ type: 'task:failed', task: decorateTaskActions(task, pmManager) }));
    taskQueue.on('task:cancelled', (task) => broadcast({ type: 'task:cancelled', task: decorateTaskActions(task, pmManager) }));
    taskQueue.on('task:requeued', (task) => broadcast({ type: 'task:requeued', task: decorateTaskActions(task, pmManager) }));
    taskQueue.on('task:snoozed', (task) => broadcast({ type: 'task:snoozed', task: decorateTaskActions(task, pmManager) }));
    taskQueue.on('task:unsnoozed', (task) => broadcast({ type: 'task:unsnoozed', task: decorateTaskActions(task, pmManager) }));
    taskQueue.on('task:updated', (task) => broadcast({ type: 'task:updated', task: decorateTaskActions(task, pmManager) }));
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
      // Send full users list to admins (legacy token mode = no user, send to all)
      for (const client of clients) {
        const clientUser = wsUser.get(client);
        const isLegacy = !clientUser;
        const isAdmin = clientUser && clientUser.login && taskQueue.hasPermission(clientUser.login, 'admin');
        if ((isLegacy || isAdmin) && client.readyState === 1) {
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
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/voice/audio') {
        voiceAudioWss.handleUpgrade(request, socket, head, (ws) => {
          voiceAudioWss.emit('connection', ws, request);
        });
      } else {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    });
    httpServer.listen(port, host, () => {
      log.info(`Web dashboard: http://${host}:${port}`);
    });
    servers.push(httpServer);
  }

  if (workerSecret) {
    log.info(`Worker registration enabled on port ${port}`);
  }

  // Initial agent file scan on startup
  if (taskQueue && taskQueue.agentRoots.length > 0) {
    taskQueue.scanAgentFiles();
    log.info(`Scanned ${taskQueue.agentFilesList.length} agent files from ${taskQueue.agentRoots.length} root(s)`);
  }

  // ── Session 0: auto-create hive console tmux session ──
  if (isSetupComplete()) {
    (async () => {
      try {
        if (!await sessionManager.isTmuxAvailable()) return;
        const result = await sessionManager.createSession(HIVE_CONSOLE_SESSION, HIVE_CONSOLE_DIR, { panes: 1 }, { cols: 80, rows: 50 });
        if (result.created) {
          await sessionManager.startClaude(HIVE_CONSOLE_SESSION, 1, 'claude --continue');
          log.info('[session-0] Created hive console session');
        } else {
          log.info('[session-0] Hive console session already exists');
        }
      } catch (err) {
        log.error(`[session-0] Failed to create console session: ${err.message}`);
      }
    })();
  }

  const tsIP = getTailscaleIP();
  if (tsIP) {
    log.info(`Tailscale access enabled (${tsIP})`);
  } else if (!process.env.WEB_BIND) {
    log.info('No Tailscale interface found — dashboard is localhost-only');
  }

  // Cleanup
  function close() {
    clearInterval(fleetInterval);
    clearInterval(uploadTtlInterval);
    for (const ws of clients) {
      clearTermSub(ws);
      clearConsoleSub(ws);
      clearAllCardSubs(ws);
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

  return { app, servers, wss, voiceAgent, close };
}

module.exports = { createWebServer };
