const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');
const fleet = require('../../core/fleet');
const relay = require('../../core/relay');
const tmux = require('../../core/tmux');

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
    // Directory doesn't exist or not readable — that's fine
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
function capturePaneAnsi(target) {
  return tmux.exec(`tmux capture-pane -e -p -S -500 -t "${target}" 2>/dev/null`) || '';
}

/**
 * Create and start the web dashboard server.
 * @param {object} config - hive config
 * @param {Watcher} watcher - core watcher instance
 * @param {TaskQueue} taskQueue - task queue instance
 * @returns {{ app, server, wss }}
 */
function createWebServer(config, watcher, taskQueue, pmManager) {
  const port = parseInt(process.env.WEB_PORT) || 3000;
  const token = process.env.WEB_TOKEN;

  if (!token) {
    console.warn('WEB_TOKEN not set in .env — web dashboard disabled');
    return null;
  }

  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // Discover available slash commands
  const commands = discoverCommands(config);

  // Track authenticated clients
  const clients = new Set();
  // Per-client terminal subscriptions: ws → { interval, session }
  const termSubs = new Map();

  // ── WebSocket handling ──────────────────────────────

  wss.on('connection', (ws) => {
    let authenticated = false;

    // Auth timeout — must authenticate within 5s
    const authTimeout = setTimeout(() => {
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

      // First message must be auth
      if (!authenticated) {
        if (msg.type === 'auth' && msg.token === token) {
          authenticated = true;
          clearTimeout(authTimeout);
          clients.add(ws);
          ws.send(JSON.stringify({ type: 'auth', ok: true }));
          // Send config, available commands, and initial fleet status
          ws.send(JSON.stringify({ type: 'config', links: config.links || {} }));
          ws.send(JSON.stringify({ type: 'commands:list', commands }));
          sendFleetStatus(ws);
          // Send task queue initial state
          if (taskQueue) {
            ws.send(JSON.stringify({ type: 'tasks:list', tasks: taskQueue.getTasksList() }));
            ws.send(JSON.stringify({ type: 'auto:status', sessions: taskQueue.getAutoSessions() }));
            ws.send(JSON.stringify({ type: 'approvals:list', approvals: taskQueue.getPendingApprovals() }));
            const feedData = taskQueue.getFeed(null, 50);
            ws.send(JSON.stringify({ type: 'feed:entries', entries: feedData.entries, hasMore: feedData.hasMore }));
            ws.send(JSON.stringify({ type: 'rules:list', rules: taskQueue.getRules() }));
            ws.send(JSON.stringify({ type: 'designations:status', designations: taskQueue.getDesignations() }));
          }
          if (pmManager) {
            ws.send(JSON.stringify({ type: 'pm:list', pms: pmManager.getAll() }));
          }
        } else {
          ws.send(JSON.stringify({ type: 'auth', ok: false }));
          ws.close();
        }
        return;
      }

      // Authenticated message routing
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      authenticated = false;
      clients.delete(ws);
      clearTermSub(ws);
      clearTimeout(authTimeout);
    });

    ws.on('error', () => {
      clients.delete(ws);
      clearTermSub(ws);
    });
  });

  // ── Message handlers ────────────────────────────────

  function handleMessage(ws, msg) {
    switch (msg.type) {
      case 'fleet:get':
        sendFleetStatus(ws);
        break;

      case 'peek': {
        const name = fleet.findSession(config, msg.session);
        if (!name) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const paneTarget = `${name}:.${config.sessions.claudePane}`;
        const content = capturePaneAnsi(paneTarget);
        ws.send(JSON.stringify({ type: 'terminal:data', session: msg.session, content }));
        break;
      }

      case 'terminal:subscribe': {
        // Unsubscribe from any previous session
        clearTermSub(ws);
        const name = fleet.findSession(config, msg.session);
        if (!name) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const paneTarget = `${name}:.${config.sessions.claudePane}`;
        // Send immediately
        const content = capturePaneAnsi(paneTarget);
        ws.send(JSON.stringify({ type: 'terminal:data', session: msg.session, content }));
        // Poll every 2s
        const interval = setInterval(() => {
          if (ws.readyState !== 1) { clearTermSub(ws); return; }
          const data = capturePaneAnsi(paneTarget);
          ws.send(JSON.stringify({ type: 'terminal:data', session: msg.session, content: data }));
        }, 2000);
        termSubs.set(ws, { interval, session: msg.session });
        break;
      }

      case 'terminal:unsubscribe':
        clearTermSub(ws);
        break;

      case 'ask': {
        const name = fleet.findSession(config, msg.session);
        if (!name) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        relay.ask(config, name, msg.message, {
          onStream: (content, isFinal) => {
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify({ type: 'ask:stream', session: msg.session, content, final: isFinal }));
          },
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
        const name = fleet.findSession(config, msg.session);
        if (!name) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        relay.tell(config, name, msg.message).then((result) => {
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
        // Send raw tmux keys (Enter, Up, Down, Escape, Tab, etc.)
        const name = fleet.findSession(config, msg.session);
        if (!name) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const paneTarget = `${name}:.${config.sessions.claudePane}`;
        // msg.keys is an array of tmux key names, e.g. ["Enter"], ["Up"], ["Escape"]
        for (const key of (msg.keys || [])) {
          tmux.exec(`tmux send-keys -t "${paneTarget}" ${key}`);
        }
        ws.send(JSON.stringify({ type: 'keys:done', session: msg.session }));
        break;
      }

      case 'restart': {
        const name = fleet.findSession(config, msg.session);
        if (!name) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const paneTarget = `${name}:.${config.sessions.claudePane}`;
        // Send Escape, then /exit, wait, then claude --resume
        tmux.exec(`tmux send-keys -t "${paneTarget}" Escape`);
        setTimeout(() => {
          tmux.exec(`tmux send-keys -t "${paneTarget}" -l '/exit'`);
          tmux.exec(`tmux send-keys -t "${paneTarget}" Enter`);
          setTimeout(() => {
            tmux.exec(`tmux send-keys -t "${paneTarget}" -l 'claude --resume'`);
            tmux.exec(`tmux send-keys -t "${paneTarget}" Enter`);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'restart:done', session: msg.session }));
            }
          }, 3000);
        }, 500);
        break;
      }

      // ── Task queue messages ──────────────────────────
      case 'task:create': {
        if (!taskQueue) break;
        const task = taskQueue.createTask(msg.text, msg.mode, msg.targetSession, msg.designation);
        ws.send(JSON.stringify({ type: 'task:created', task }));
        break;
      }

      case 'task:cancel': {
        if (!taskQueue) break;
        const task = taskQueue.cancelTask(msg.taskId);
        if (task) ws.send(JSON.stringify({ type: 'task:cancelled', task }));
        break;
      }

      case 'auto:toggle': {
        if (!taskQueue) break;
        taskQueue.toggleAutoSession(msg.session);
        break;
      }

      case 'auto:set': {
        if (!taskQueue) break;
        taskQueue.setAutoSessions(msg.sessions || []);
        break;
      }

      case 'broadcast': {
        if (!taskQueue) break;
        taskQueue.broadcast(msg.message, msg.target, msg.sessions).then((result) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'broadcast:done', sent: result.sent, failed: result.failed }));
          }
        });
        break;
      }

      case 'approval:respond': {
        if (!taskQueue) break;
        const approval = taskQueue.resolveApproval(msg.approvalId, msg.approved);
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
        taskQueue.toggleRule(msg.ruleId);
        break;
      }

      // ── Designation messages ─────────────────────────
      case 'designation:set': {
        if (!taskQueue) break;
        taskQueue.setDesignation(msg.session, msg.designation);
        break;
      }

      // ── Spawn messages ──────────────────────────────
      case 'spawn:slots': {
        if (!taskQueue) break;
        ws.send(JSON.stringify({ type: 'spawn:slots', slots: taskQueue.getAvailableSlots() }));
        break;
      }

      case 'spawn': {
        if (!taskQueue) break;
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
          setTimeout(broadcastFleetStatus, 3000);
        }).catch((err) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'spawn:done', success: false, error: err.message }));
          }
        });
        break;
      }

      // ── PM messages ─────────────────────────────────
      case 'pm:create': {
        if (!pmManager) break;
        const pm = pmManager.create(msg.config);
        ws.send(JSON.stringify({ type: 'pm:created', pm }));
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:update': {
        if (!pmManager) break;
        pmManager.update(msg.id, msg.updates);
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:delete': {
        if (!pmManager) break;
        pmManager.remove(msg.id);
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:toggle': {
        if (!pmManager) break;
        pmManager.toggle(msg.id);
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:list': {
        if (!pmManager) break;
        ws.send(JSON.stringify({ type: 'pm:list', pms: pmManager.getAll() }));
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

  // ── Fleet status broadcast ──────────────────────────

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

  function getFleetWithPreviews() {
    const sessions = fleet.getFleetStatus(config);
    for (const s of sessions) {
      try {
        const content = fleet.peekSession(config, s.name);
        s.preview = cleanPreview(content);
      } catch {
        s.preview = '';
      }
    }
    return sessions;
  }

  function sendFleetStatus(ws) {
    const sessions = getFleetWithPreviews();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'fleet:status', sessions }));
    }
  }

  function broadcastFleetStatus() {
    const sessions = getFleetWithPreviews();
    const msg = JSON.stringify({ type: 'fleet:status', sessions });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  // Broadcast fleet status every 10s
  const fleetInterval = setInterval(broadcastFleetStatus, 10000);

  // ── Watcher event bridge ────────────────────────────

  function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  watcher.on('session:idle', ({ session, name, num }) => {
    broadcast({ type: 'notify', event: 'session:idle', session: num, name });
    broadcastFleetStatus();
  });

  watcher.on('session:working', ({ session, name, num }) => {
    broadcast({ type: 'notify', event: 'session:working', session: num, name });
  });

  watcher.on('ci:changed', ({ name, num, from, to, pr }) => {
    broadcast({ type: 'notify', event: 'ci:changed', session: num, name, from, to, pr });
    broadcastFleetStatus();
  });

  // ── TaskQueue event bridge ───────────────────────────

  if (taskQueue) {
    taskQueue.on('task:created', (task) => broadcast({ type: 'task:created', task }));
    taskQueue.on('task:dispatched', (task) => broadcast({ type: 'task:dispatched', task }));
    taskQueue.on('task:completed', (task) => broadcast({ type: 'task:completed', task }));
    taskQueue.on('task:failed', (task) => broadcast({ type: 'task:failed', task }));
    taskQueue.on('task:cancelled', (task) => broadcast({ type: 'task:cancelled', task }));
    taskQueue.on('auto:changed', (sessions) => broadcast({ type: 'auto:status', sessions }));
    taskQueue.on('feed:new', (entry) => broadcast({ type: 'feed:new', entry }));
    taskQueue.on('approval:new', (approval) => broadcast({ type: 'approval:new', approval }));
    taskQueue.on('approval:resolved', (approval) => broadcast({ type: 'approval:resolved', approval }));
    taskQueue.on('rules:changed', (rules) => broadcast({ type: 'rules:list', rules }));
    taskQueue.on('designations:changed', (designations) => broadcast({ type: 'designations:status', designations }));
  }

  if (pmManager) {
    pmManager.on('pm:error', (data) => broadcast({ type: 'pm:error', id: data.id, error: data.error }));
    pmManager.on('pm:changed', () => broadcast({ type: 'pm:list', pms: pmManager.getAll() }));
  }

  // ── Start server ────────────────────────────────────

  server.listen(port, () => {
    console.log(`Web dashboard: http://localhost:${port}`);
  });

  // Cleanup helper
  server.on('close', () => {
    clearInterval(fleetInterval);
    for (const ws of clients) {
      clearTermSub(ws);
      ws.close();
    }
    clients.clear();
  });

  return { app, server, wss };
}

module.exports = { createWebServer };
