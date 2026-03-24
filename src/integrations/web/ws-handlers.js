const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execSync, spawn } = require('child_process');
const fleet = require('../../core/fleet');
const relay = require('../../core/relay');
const git = require('../../core/git');
const tmux = require('../../core/tmux');
const auth = require('../../core/auth');
const log = require('../../core/log');
const {
  HIVE_CONSOLE_SESSION, ghExecEnv, setupPath, isSetupComplete,
  decorateTaskActions, executeTaskAction, capturePaneAnsi,
} = require('./ws-helpers');

/**
 * Create the WebSocket message handler.
 * @param {object} deps - Closure dependencies from createWebServer
 * @returns {function} handleMessage(ws, msg, user)
 */
function createMessageHandler(deps) {
  const {
    config, taskQueue, pmManager, router,
    broadcast, checkPermission, resolveSession,
    clearTermSub, clearConsoleSub, termSubs, consoleSubs,
    clearCardSub, clearAllCardSubs, cardTermSubs,
    sendFleetStatus, broadcastFleetStatus, sendInitialState, _previewCache,
    commands, clients, wsUser, workers, mcpClients, voiceAgent,
  } = deps;

  // Per-session working directory overrides (session num → absolute path).
  // Set via mcp:set_working_dir when a Claude session works in a directory
  // different from its configured repoDir (e.g. a git worktree).
  const workingDirOverrides = new Map();

  /**
   * Resolve the effective repo directory for a session.
   * Checks working dir overrides first, then falls back to config.sessions.repoDir.
   */
  function resolveRepoDir(num, nc) {
    if (num && workingDirOverrides.has(num)) return workingDirOverrides.get(num);
    return num ? nc.sessions.repoDir(num) : null;
  }

  return async function handleMessage(ws, msg, user) {
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'fleet:get':
        await sendFleetStatus(ws);
        break;

      case 'peek': {
        const found = await resolveSession(msg);
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

      case 'terminal:panes': {
        const found = await resolveSession(msg);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        try {
          const raw = await node.exec(`tmux list-panes -t "${name}" -F '#{pane_index}|#{pane_current_command}' 2>/dev/null`);
          const panes = (raw || '').trim().split('\n').filter(Boolean).map(line => {
            const [idx, cmd] = line.split('|');
            return { index: parseInt(idx, 10), command: cmd || 'unknown' };
          });
          // Mark the claudePane as the active/primary one
          const claudeIdx = config.sessions.claudePane;
          panes.forEach(p => { p.active = (p.index === claudeIdx); });
          ws.send(JSON.stringify({ type: 'terminal:panes', session: msg.session, panes, claudePane: claudeIdx }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'terminal:panes', session: msg.session, panes: [], claudePane: config.sessions.claudePane }));
        }
        break;
      }

      case 'terminal:subscribe': {
        const isConsole = String(msg.session) === 'hive-console';
        const isCard = msg.card === true;
        if (isCard) {
          // Card terminals: keyed by session:pane, multiple per connection
        } else if (isConsole) {
          clearConsoleSub(ws);
        } else {
          clearTermSub(ws);
        }
        const found = await resolveSession(msg);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const subPaneIdx = isConsole ? 1 : ((typeof msg.pane === 'number') ? msg.pane : config.sessions.claudePane);
        const paneTarget = `${name}:.${subPaneIdx}`;
        // Send immediately
        const { content: subContent, cols: subCols } = await capturePaneAnsi(node, paneTarget);
        ws.send(JSON.stringify({ type: 'terminal:data', session: msg.session, pane: subPaneIdx, content: subContent, cols: subCols, card: isCard }));
        // Poll every 2s (guard against stale callbacks after clearInterval)
        const sub = { interval: null, session: msg.session, name, node, pane: subPaneIdx, cancelled: false };
        const subKey = `${msg.session}:${subPaneIdx}`;
        sub.interval = setInterval(async () => {
          if (sub.cancelled || ws.readyState !== 1) {
            if (isCard) clearCardSub(ws, subKey);
            else if (isConsole) clearConsoleSub(ws);
            else clearTermSub(ws);
            return;
          }
          try {
            const { content: pollContent, cols: pollCols } = await capturePaneAnsi(node, paneTarget);
            if (sub.cancelled) return;
            ws.send(JSON.stringify({ type: 'terminal:data', session: msg.session, pane: subPaneIdx, content: pollContent, cols: pollCols, card: isCard }));
          } catch {
            // Node may have disconnected
          }
        }, 2000);
        if (isCard) {
          clearCardSub(ws, subKey); // replace if already exists
          if (!cardTermSubs.has(ws)) cardTermSubs.set(ws, new Map());
          cardTermSubs.get(ws).set(subKey, sub);
        } else if (isConsole) {
          consoleSubs.set(ws, sub);
        } else {
          termSubs.set(ws, sub);
        }
        break;
      }

      case 'terminal:card:unsubscribe': {
        const pane = typeof msg.pane === 'number' ? msg.pane : config.sessions.claudePane;
        clearCardSub(ws, `${msg.session}:${pane}`);
        break;
      }

      case 'terminal:resize': {
        const isConsoleResize = String(msg.session) === 'hive-console';
        const sub = isConsoleResize ? consoleSubs.get(ws) : termSubs.get(ws);
        if (!sub || !msg.cols || !msg.rows) break;
        const resizePane = isConsoleResize ? 1 : config.sessions.claudePane;
        const resizeTarget = `${sub.name}:.${resizePane}`;
        await sub.node.exec(`tmux resize-pane -t "${resizeTarget}" -x ${msg.cols} -y ${msg.rows} 2>/dev/null`);
        break;
      }

      case 'terminal:unsubscribe':
        if (String(msg.session) === 'hive-console') clearConsoleSub(ws);
        else clearTermSub(ws);
        break;

      case 'ask': {
        if (!checkPermission(ws, user, 'send-messages')) break;
        const found = await resolveSession(msg);
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
        }).catch((err) => {
          log.error('ask error:', err);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ask:done', session: msg.session, success: false, error: err.message }));
          }
        });
        break;
      }

      case 'tell': {
        if (!checkPermission(ws, user, 'send-messages')) break;
        const found = await resolveSession(msg);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        // If targeting a non-Claude pane, send text directly via sendKeys (bypass relay)
        if (typeof msg.pane === 'number' && msg.pane !== config.sessions.claudePane) {
          const shellTarget = `${name}:.${msg.pane}`;
          try {
            await node.sendKeys(shellTarget, msg.message, true);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tell:done', session: msg.session, success: true }));
          } catch (err) {
            log.error('tell (shell pane) error:', err);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tell:done', session: msg.session, success: false, error: err.message }));
          }
          break;
        }
        relay.tell(config, node, name, msg.message, { vimMode: taskQueue ? taskQueue.vimMode : false }).then((result) => {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'tell:done',
            session: msg.session,
            success: result.success,
            error: result.error,
          }));
        }).catch((err) => {
          log.error('tell error:', err);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'tell:done', session: msg.session, success: false, error: err.message }));
          }
        });
        break;
      }

      case 'keys': {
        if (!checkPermission(ws, user, 'send-messages')) break;
        // Send raw tmux keys (Enter, Up, Down, Escape, Tab, etc.)
        const found = await resolveSession(msg);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const keysPaneIdx = (typeof msg.pane === 'number') ? msg.pane : config.sessions.claudePane;
        const paneTarget = `${name}:.${keysPaneIdx}`;
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
          // Session not in fleet — try sending claude --continue to tmux directly
          const sessionName = String(msg.session);
          const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
          try {
            const localNode = router.getNode('local');
            if (!localNode) throw new Error('No local node');
            await localNode.exec(`tmux send-keys -t "${paneTarget}" -l 'claude --continue'`);
            await localNode.exec(`tmux send-keys -t "${paneTarget}" Enter`);
            fleet.invalidateCache();
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'restart:done', session: msg.session }));
            }
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          }
          break;
        }
        const { name, nodeId } = found;
        const node = router.getNode(nodeId);
        const paneTarget = `${name}:.${config.sessions.claudePane}`;

        // Check if Claude is actually running — if off, just start it
        const content = await node.capturePane(paneTarget, { lines: 3 });
        const currentState = tmux.detectState(content, config);
        if (currentState === 'off') {
          await node.exec(`tmux send-keys -t "${paneTarget}" -l 'claude --continue'`);
          await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
          fleet.invalidateCache();
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'restart:done', session: msg.session }));
          }
          break;
        }

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

      case 'restart:all': {
        if (!checkPermission(ws, user, 'restart')) break;
        const sessions = await fleet.getFleetStatus(config, router);
        let restarted = 0;
        let failed = 0;
        for (const sess of sessions) {
          try {
            const found = await fleet.findSession(config, router, sess.num);
            if (!found) { failed++; continue; }
            const { name, nodeId } = found;
            const node = router.getNode(nodeId);
            const paneTarget = `${name}:.${config.sessions.claudePane}`;
            // Stagger restarts: sequential with delays
            const delay = restarted * 5000;
            setTimeout(async () => {
              try {
                // Cancel any pending input, then /exit
                await node.exec(`tmux send-keys -t "${paneTarget}" C-c`);
                await new Promise(r => setTimeout(r, 500));
                await node.exec(`tmux send-keys -t "${paneTarget}" -l '/exit'`);
                await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
                // Wait for Claude to exit, then restart
                await new Promise(r => setTimeout(r, 3000));
                await node.exec(`tmux send-keys -t "${paneTarget}" -l 'claude --continue'`);
                await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
              } catch (err) {
                log.error(`[restart:all] Failed to restart session ${sess.num}: ${err.message}`);
              }
            }, delay);
            restarted++;
          } catch (err) {
            log.error(`[restart:all] Session ${sess.num} error: ${err.message}`);
            failed++;
          }
        }
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'restart:all:done', restarted, failed }));
        }
        taskQueue.pushFeed('system', null, `Restarting all ${restarted} session(s) — /exit + claude --continue`);
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
        const nc = fleet.getNodeConfig(config, nodeId);
        const num = fleet.sessionNum(name, nc.sessions.namePrefix);
        const repoDir = resolveRepoDir(num, nc);
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
        const workingDir = num && workingDirOverrides.has(num) ? workingDirOverrides.get(num) : null;
        ws.send(JSON.stringify({ type: 'git:info', session: msg.session, log, diffStat, stagedStat, changedFiles, branchDiff, workingDir }));
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
        const nc = fleet.getNodeConfig(config, nodeId);
        const num = fleet.sessionNum(name, nc.sessions.namePrefix);
        const repoDir = resolveRepoDir(num, nc);
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
        const nc = fleet.getNodeConfig(config, nodeId);
        const num = fleet.sessionNum(name, nc.sessions.namePrefix);
        const repoDir = resolveRepoDir(num, nc);
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

      case 'task:rename': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'create-tasks')) break;
        const newText = (msg.text || '').trim();
        if (!newText) {
          ws.send(JSON.stringify({ type: 'error', message: 'New title cannot be empty' }));
          break;
        }
        const renamedTask = taskQueue.renameTask(msg.taskId, newText);
        if (renamedTask) {
          broadcast({ type: 'task:updated', task: renamedTask });
          ws.send(JSON.stringify({ type: 'task:renamed', taskId: msg.taskId }));
        }
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

      case 'task:requeue': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'dispatch')) break;
        const requeuedTask = taskQueue.requeueTask(msg.taskId);
        if (requeuedTask) broadcast({ type: 'task:requeued', task: decorateTaskActions(requeuedTask, pmManager) });
        break;
      }

      case 'task:cancel': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'cancel')) break;
        const cancelledTask = taskQueue.cancelTask(msg.taskId);
        if (cancelledTask) broadcast({ type: 'task:cancelled', task: cancelledTask });
        break;
      }

      case 'task:snooze': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'dispatch')) break;
        const snoozedTask = taskQueue.snoozeTask(msg.taskId, msg.durationMs);
        if (snoozedTask) broadcast({ type: 'task:snoozed', task: decorateTaskActions(snoozedTask, pmManager) });
        break;
      }

      case 'task:unsnooze': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'dispatch')) break;
        const unsnoozedTask = taskQueue.unsnoozeTask(msg.taskId);
        if (unsnoozedTask) broadcast({ type: 'task:unsnoozed', task: decorateTaskActions(unsnoozedTask, pmManager) });
        break;
      }

      case 'task:complete': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'cancel')) break;
        const pendingTask = taskQueue.tasks.get(msg.taskId);
        let snap = null, snapCols = 0;
        if (pendingTask && pendingTask.assignedTo) {
          try {
            const found = await fleet.findSession(config, router, pendingTask.assignedTo);
            if (found) {
              const node = router.getNode(found.nodeId);
              const paneTarget = `${found.name}:.${config.sessions.claudePane}`;
              snap = await node.exec(`tmux capture-pane -e -p -S -500 -t "${paneTarget}" 2>/dev/null`) || null;
              const colsStr = await node.exec(`tmux display-message -p -t "${paneTarget}" "#{pane_width}" 2>/dev/null`);
              snapCols = parseInt(colsStr) || 0;
            }
          } catch {}
        }
        const task = taskQueue.completeTask(msg.taskId, msg.result || 'Manually completed', snap, snapCols);
        if (task) broadcast({ type: 'task:completed', task });
        break;
      }

      case 'task:resume': {
        if (!taskQueue) break;
        const task = taskQueue.resumeTask(msg.taskId);
        if (task) {
          broadcast({ type: 'task:dispatched', task });
          // If a newer task ran in this session, send /resume to reload the conversation
          if (msg.sendResume && task.assignedTo) {
            const found = await fleet.findSession(config, router, task.assignedTo);
            if (found) {
              const node = router.getNode(found.nodeId);
              relay.tell(config, node, found.name, '/resume', { vimMode: taskQueue.vimMode }).catch(() => {});
            }
          }
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot resume task — session may be busy or task not resumable' }));
        }
        break;
      }

      case 'task:action': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'cancel')) break;
        const actionTask = taskQueue.tasks.get(msg.taskId);
        if (!actionTask || !actionTask.actionContext) {
          ws.send(JSON.stringify({ type: 'task:action:result', taskId: msg.taskId, actionId: msg.actionId, ok: false, error: 'Task not found or has no actions' }));
          break;
        }
        try {
          const pmManager = taskQueue._pmManager;
          const result = await executeTaskAction(actionTask, msg.actionId, pmManager);
          broadcast({ type: 'task:action:result', taskId: msg.taskId, actionId: msg.actionId, ok: true, message: result.message });
          if (result.closeTask || msg.closeTask) {
            let actionSnap = null, actionSnapCols = 0;
            if (actionTask.assignedTo) {
              try {
                const found = await fleet.findSession(config, router, actionTask.assignedTo);
                if (found) {
                  const node = router.getNode(found.nodeId);
                  const paneTarget = `${found.name}:.${config.sessions.claudePane}`;
                  actionSnap = await node.exec(`tmux capture-pane -e -p -S -500 -t "${paneTarget}" 2>/dev/null`) || null;
                  const colsStr = await node.exec(`tmux display-message -p -t "${paneTarget}" "#{pane_width}" 2>/dev/null`);
                  actionSnapCols = parseInt(colsStr) || 0;
                }
              } catch {}
            }
            const completed = taskQueue.completeTask(msg.taskId, result.message, actionSnap, actionSnapCols);
            if (completed) broadcast({ type: 'task:completed', task: decorateTaskActions(completed, pmManager) });
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'task:action:result', taskId: msg.taskId, actionId: msg.actionId, ok: false, error: err.message }));
        }
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
        taskQueue.setDesignationDef(msg.name, { agentFiles: msg.agentFiles, description: msg.description, color: msg.color });
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

      case 'taskAutoComplete:toggle': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'dispatch')) break;
        taskQueue.taskAutoComplete = !taskQueue.taskAutoComplete;
        taskQueue._saveState();
        broadcast({ type: 'taskAutoComplete:status', enabled: taskQueue.taskAutoComplete });
        break;
      }

      case 'kill': {
        if (!checkPermission(ws, user, 'restart')) break;
        const found = await fleet.findSession(config, router, msg.session);
        if (!found) {
          ws.send(JSON.stringify({ type: 'error', message: `No session matching "${msg.session}"` }));
          return;
        }
        const { name, nodeId } = found;
        const num = fleet.sessionNum(name, config.sessions.namePrefix);
        const node = router.getNode(nodeId);
        await node.exec(`tmux kill-session -t "${name}:" 2>/dev/null`);
        if (num) taskQueue.cleanupSession(num);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'kill:done', session: msg.session }));
        }
        setTimeout(() => {
          fleet.invalidateCache();
          _previewCache.result = null;
          _previewCache.ts = 0;
          broadcastFleetStatus().catch(() => {});
        }, 500);
        break;
      }

      case 'shutdown:all': {
        if (!checkPermission(ws, user, 'restart')) break;
        const sessionManager = require('../../core/session-manager');
        try {
          const results = await sessionManager.destroyAllSessions(config);
          // Clean up taskQueue for each killed session
          if (taskQueue) {
            for (const name of results.killed) {
              const num = fleet.sessionNum(name, config.sessions.namePrefix);
              if (num) taskQueue.cleanupSession(num);
            }
          }
          fleet.invalidateCache();
          _previewCache.result = null;
          _previewCache.ts = 0;
          broadcastFleetStatus().catch(() => {});
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'shutdown:all:done', killed: results.killed.length, failed: results.failed.length }));
          }
        } catch (err) {
          log.error('Shutdown all error:', err.message);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: `Shutdown failed: ${err.message}` }));
          }
        }
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
            fleet.invalidateCache();
            _previewCache.result = null;
            _previewCache.ts = 0;
            broadcastFleetStatus().catch(() => {});
          }, 500);
        }).catch((err) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'spawn:done', success: false, error: err.message }));
          }
        });
        break;
      }

      case 'respawn:all': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        taskQueue.respawnAll().then((results) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'respawn:done', ...results }));
          }
          // Broadcast updated spawned agents list
          broadcast({ type: 'spawnedAgents:list', agents: taskQueue.getSpawnedAgentsList() });
          // Refresh fleet for all clients after a delay
          setTimeout(() => {
            fleet.invalidateCache();
            _previewCache.result = null;
            _previewCache.ts = 0;
            broadcastFleetStatus().catch(() => {});
          }, 500);
        }).catch((err) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'respawn:done', respawned: [], skipped: [], failed: [{ num: 0, error: err.message }] }));
          }
        });
        break;
      }

      // -- PM messages -------------------------------------------------------
      case 'pm:create': {
        if (!pmManager) break;
        if (!checkPermission(ws, user, 'admin')) break;
        const cronExpr = msg.config && msg.config.schedule;
        if (cronExpr) {
          const nodeCron = require('node-cron');
          if (!nodeCron.validate(cronExpr)) {
            ws.send(JSON.stringify({ type: 'error', message: `Invalid cron expression: ${cronExpr}` }));
            break;
          }
        }
        const pm = pmManager.create(msg.config);
        ws.send(JSON.stringify({ type: 'pm:created', pm }));
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:update': {
        if (!pmManager) break;
        if (!checkPermission(ws, user, 'admin')) break;
        const updateCron = msg.updates && msg.updates.schedule;
        if (updateCron) {
          const nodeCron = require('node-cron');
          if (!nodeCron.validate(updateCron)) {
            ws.send(JSON.stringify({ type: 'error', message: `Invalid cron expression: ${updateCron}` }));
            break;
          }
        }
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

      case 'pm:reset': {
        if (!pmManager) break;
        if (!checkPermission(ws, user, 'admin')) break;
        pmManager.reset(msg.id);
        broadcast({ type: 'pm:list', pms: pmManager.getAll() });
        break;
      }

      case 'pm:list': {
        if (!pmManager) break;
        ws.send(JSON.stringify({ type: 'pm:list', pms: pmManager.getAll() }));
        break;
      }

      case 'pm:export': {
        if (!pmManager) break;
        const prompt = pmManager.exportPM(msg.id, msg.skillPaths || []);
        if (prompt) {
          ws.send(JSON.stringify({ type: 'pm:export:result', id: msg.id, prompt }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'PM not found' }));
        }
        break;
      }

      case 'pm:skills': {
        if (!taskQueue) break;
        const skills = taskQueue.scanSkills();
        ws.send(JSON.stringify({ type: 'pm:skills', skills }));
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

      // -- Work States config ---------------------------------------------------
      case 'workStates:set': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'admin')) break;
        const states = taskQueue.setWorkStates(msg.states || []);
        broadcast({ type: 'workStates:list', states });
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

      // -- Plan file reading --------------------------------------------------
      case 'plan:read': {
        // Read a file from the session's node (used by plan pane to poll plan file)
        if (!msg.session || !msg.path) {
          ws.send(JSON.stringify({ type: 'plan:file', session: msg.session, content: null, error: 'Missing session or path' }));
          break;
        }
        const planFound = await fleet.findSession(config, router, msg.session);
        if (!planFound) {
          ws.send(JSON.stringify({ type: 'plan:file', session: msg.session, content: null, error: 'Session not found' }));
          break;
        }
        const planNode = router.getNode(planFound.nodeId);
        try {
          const content = await planNode.readFile(msg.path);
          ws.send(JSON.stringify({ type: 'plan:file', session: msg.session, path: msg.path, content }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'plan:file', session: msg.session, path: msg.path, content: null, error: err.message }));
        }
        break;
      }

      // -- Session Context ---------------------------------------------------
      case 'context:get': {
        if (!taskQueue) break;
        const ctx = msg.session != null
          ? taskQueue.getSessionContext(msg.session)
          : taskQueue.getAllSessionContexts();
        ws.send(JSON.stringify({ type: 'context:data', session: msg.session ?? null, context: ctx }));
        break;
      }

      case 'context:set': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'send-messages')) break;
        if (msg.session == null || !msg.updates || typeof msg.updates !== 'object') {
          ws.send(JSON.stringify({ type: 'error', message: 'context:set requires session and updates' }));
          break;
        }
        const updated = taskQueue.setSessionContext(msg.session, msg.updates);
        broadcast({ type: 'context:updated', session: Number(msg.session), context: updated });
        break;
      }

      case 'context:clear': {
        if (!taskQueue) break;
        if (!checkPermission(ws, user, 'send-messages')) break;
        if (msg.session == null) break;
        taskQueue.clearSessionContext(msg.session);
        broadcast({ type: 'context:updated', session: Number(msg.session), context: {} });
        break;
      }

      // -- Ideas (GitHub issues) -----------------------------------------------
      case 'idea:create': {
        const title = (msg.title || '').trim();
        if (!title) {
          ws.send(JSON.stringify({ type: 'idea:error', error: 'Title is required' }));
          break;
        }
        const args = ['issue', 'create', '--repo', 'nukulb/hive', '--title', title, '--label', 'idea'];
        if (msg.body) { args.push('--body', msg.body); }
        execFile('gh', args, { timeout: 15000, env: ghExecEnv }, (err, stdout) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'idea:error', error: err.message }));
            return;
          }
          const url = (stdout || '').trim();
          const numMatch = url.match(/\/issues\/(\d+)$/);
          const issue = { url, number: numMatch ? parseInt(numMatch[1]) : 0, title };
          ws.send(JSON.stringify({ type: 'idea:created', issue }));
        });
        break;
      }

      case 'idea:list': {
        execFile('gh', ['issue', 'list', '--repo', 'nukulb/hive', '--label', 'idea', '--state', 'all', '--json', 'number,title,state,url', '--limit', '50'], { timeout: 15000, env: ghExecEnv }, (err, stdout) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'idea:error', error: err.message }));
            return;
          }
          try {
            const ideas = JSON.parse(stdout);
            ws.send(JSON.stringify({ type: 'idea:list', ideas }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'idea:list', ideas: [] }));
          }
        });
        break;
      }

      case 'update:status': {
        if (!checkPermission(ws, user, 'admin')) break;
        const hiveRoot = path.join(__dirname, '..', '..', '..');
        try {
          const branch = execSync('git branch --show-current', { cwd: hiveRoot, encoding: 'utf8' }).trim();
          const commitRaw = execSync('git log -1 --format="%h|%s|%ar"', { cwd: hiveRoot, encoding: 'utf8' }).trim();
          const [hash, subject, timeAgo] = commitRaw.split('|');
          const branchesRaw = execSync('git branch -r --format="%(refname:short)"', { cwd: hiveRoot, encoding: 'utf8' }).trim();
          const remoteBranches = branchesRaw.split('\n')
            .map(b => b.replace(/^origin\//, ''))
            .filter(b => b && b !== 'HEAD');
          ws.send(JSON.stringify({ type: 'update:status', branch, hash, subject, timeAgo, remoteBranches }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'update:error', error: err.message }));
        }
        break;
      }

      case 'integration:save': {
        if (!checkPermission(ws, user, 'admin')) break;
        const intName = msg.integration;
        const ALLOWED_KEYS = {
          github: ['GITHUB_TOKEN'],
          jenkins: ['JENKINS_URL', 'JENKINS_USER', 'JENKINS_API_TOKEN'],
          slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
          jira: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
        };
        const allowed = ALLOWED_KEYS[intName];
        if (!allowed || !msg.values || typeof msg.values !== 'object') {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid integration' }));
          break;
        }
        // Filter to only allowed keys
        const safeValues = {};
        for (const k of Object.keys(msg.values)) {
          if (allowed.includes(k)) safeValues[k] = msg.values[k];
        }
        try {
          const envFile = path.join(__dirname, '..', '..', '..', '.env');
          let lines = [];
          if (fs.existsSync(envFile)) {
            lines = fs.readFileSync(envFile, 'utf8').split('\n');
          }
          for (const [key, val] of Object.entries(safeValues)) {
            const idx = lines.findIndex(l => l.trim().startsWith(key + '='));
            const line = `${key}=${val}`;
            if (idx >= 0) { lines[idx] = line; } else { lines.push(line); }
          }
          fs.writeFileSync(envFile, lines.join('\n'));
          ws.send(JSON.stringify({ type: 'integration:saved', integration: intName, restart: true }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to save: ' + err.message }));
        }
        break;
      }

      case 'integration:test': {
        const intTestName = msg.integration;
        const vals = msg.values || {};
        const sendResult = (ok, detail, error) => {
          try {
            ws.send(JSON.stringify({ type: 'integration:test:result', integration: intTestName, ok, detail, error }));
          } catch (_) {}
        };

        const httpRequest = (urlStr, headers, postBody) => {
          return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const mod = url.protocol === 'https:' ? https : http;
            const options = { method: postBody ? 'POST' : 'GET', headers: { ...headers }, timeout: 15000 };
            const req = mod.request(urlStr, options, (res) => {
              let data = '';
              res.on('data', (chunk) => data += chunk);
              res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON')); }
                } else {
                  reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                }
              });
            });
            req.on('error', (err) => reject(new Error(err.message)));
            req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
            if (postBody) req.write(postBody);
            req.end();
          });
        };

        try {
          switch (intTestName) {
            case 'github': {
              const token = vals.GITHUB_TOKEN;
              if (!token) { sendResult(false, null, 'Token required'); break; }
              const data = await httpRequest('https://api.github.com/user', {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'User-Agent': 'hive-dashboard',
              });
              sendResult(true, `Authenticated as ${data.login}`);
              break;
            }
            case 'jenkins': {
              const jUrl = (vals.JENKINS_URL || '').replace(/\/+$/, '');
              const jUser = vals.JENKINS_USER;
              const jToken = vals.JENKINS_API_TOKEN;
              if (!jUrl || !jUser || !jToken) { sendResult(false, null, 'All fields required'); break; }
              const auth = Buffer.from(`${jUser}:${jToken}`).toString('base64');
              const data = await httpRequest(`${jUrl}/api/json`, {
                'Authorization': `Basic ${auth}`,
                'Accept': 'application/json',
              });
              sendResult(true, data.nodeDescription || 'Connected');
              break;
            }
            case 'slack': {
              const botToken = vals.SLACK_BOT_TOKEN;
              if (!botToken) { sendResult(false, null, 'Bot token required'); break; }
              const data = await httpRequest('https://slack.com/api/auth.test', {
                'Authorization': `Bearer ${botToken}`,
                'Content-Type': 'application/json',
              });
              if (data.ok) {
                sendResult(true, data.team || 'Connected');
              } else {
                sendResult(false, null, data.error || 'Auth failed');
              }
              break;
            }
            case 'jira': {
              const jiraUrl = (vals.JIRA_BASE_URL || '').replace(/\/+$/, '');
              const jiraEmail = vals.JIRA_EMAIL;
              const jiraToken = vals.JIRA_API_TOKEN;
              if (!jiraUrl || !jiraEmail || !jiraToken) { sendResult(false, null, 'All fields required'); break; }
              const jiraAuth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
              const data = await httpRequest(`${jiraUrl}/rest/api/3/myself`, {
                'Authorization': `Basic ${jiraAuth}`,
                'Accept': 'application/json',
              });
              sendResult(true, data.displayName || 'Connected');
              break;
            }
            default:
              sendResult(false, null, 'Unknown integration');
          }
        } catch (err) {
          sendResult(false, null, err.message);
        }
        break;
      }

      case 'update:pull': {
        if (!checkPermission(ws, user, 'admin')) break;
        const hiveDir = path.join(__dirname, '..', '..', '..');
        const targetBranch = msg.branch;
        const sendLog = (step, output) => {
          try { ws.send(JSON.stringify({ type: 'update:log', step, output })); } catch (_) {}
        };
        try {
          // Step 0: stash local changes so pull doesn't conflict
          const dirtyCheck = execSync('git status --porcelain', { cwd: hiveDir, encoding: 'utf8' }).trim();
          let didStash = false;
          if (dirtyCheck) {
            sendLog('stash', 'Stashing local changes...');
            execSync('git stash --include-untracked 2>&1', { cwd: hiveDir, encoding: 'utf8', timeout: 10000 });
            didStash = true;
            sendLog('stash', 'Done.');
          }

          // Step 1: fetch
          sendLog('fetch', 'Running git fetch origin...');
          const fetchOut = execSync('git fetch origin 2>&1', { cwd: hiveDir, encoding: 'utf8', timeout: 30000 });
          sendLog('fetch', fetchOut || 'Done.');

          // Step 2: checkout if different branch
          const currentBranch = execSync('git branch --show-current', { cwd: hiveDir, encoding: 'utf8' }).trim();
          if (targetBranch && targetBranch !== currentBranch) {
            sendLog('checkout', `Switching to ${targetBranch}...`);
            const checkoutOut = execSync(`git checkout ${targetBranch} 2>&1`, { cwd: hiveDir, encoding: 'utf8', timeout: 15000 });
            sendLog('checkout', checkoutOut || 'Done.');
          }

          // Step 3: pull
          sendLog('pull', 'Running git pull...');
          const pullOut = execSync('git pull 2>&1', { cwd: hiveDir, encoding: 'utf8', timeout: 30000 });
          sendLog('pull', pullOut || 'Done.');

          // Step 3b: re-apply stashed changes
          if (didStash) {
            sendLog('stash', 'Re-applying local changes...');
            try {
              execSync('git stash pop 2>&1', { cwd: hiveDir, encoding: 'utf8', timeout: 10000 });
              sendLog('stash', 'Done.');
            } catch (stashErr) {
              sendLog('stash', 'Stash pop had conflicts — local changes may need manual merge.');
            }
          }

          // Step 4: npm test
          sendLog('test', 'Running npm test...');
          try {
            const testOut = execSync('npm test 2>&1', { cwd: hiveDir, encoding: 'utf8', timeout: 120000 });
            sendLog('test', testOut || 'All tests passed.');
          } catch (testErr) {
            sendLog('test', testErr.stdout || testErr.message);
            ws.send(JSON.stringify({ type: 'update:error', error: 'Tests failed — aborting restart.' }));
            break;
          }

          // Step 5: restart
          sendLog('restart', 'Restarting hive...');
          ws.send(JSON.stringify({ type: 'update:restarting' }));

          const pid = process.pid;
          const restartScript = `sleep 1 && kill ${pid} && cd "${hiveDir}" && node src/index.js > /tmp/hive.log 2>&1`;
          const child = spawn('bash', ['-c', restartScript], { detached: true, stdio: 'ignore' });
          child.unref();
        } catch (err) {
          sendLog('error', err.message);
          ws.send(JSON.stringify({ type: 'update:error', error: err.message }));
        }
        break;
      }

      case 'hive:restart': {
        if (!checkPermission(ws, user, 'admin')) break;
        const hiveDir = path.join(__dirname, '..', '..', '..');
        try {
          ws.send(JSON.stringify({ type: 'update:restarting' }));
          const pid = process.pid;
          const restartScript = `sleep 1 && kill ${pid} && cd "${hiveDir}" && node src/index.js > /tmp/hive.log 2>&1`;
          const child = spawn('bash', ['-c', restartScript], { detached: true, stdio: 'ignore' });
          child.unref();
        } catch (err) {
          ws.send(JSON.stringify({ type: 'update:error', error: err.message }));
        }
        break;
      }

      // -- Setup wizard messages ----------------------------------------------
      case 'setup:validate-path': {
        const rawPath = (msg.path || '').trim();
        if (!rawPath) {
          ws.send(JSON.stringify({ type: 'setup:validate-path:result', valid: false, error: 'Path is required' }));
          break;
        }
        const resolved = rawPath.replace(/^~/, os.homedir());
        const exists = fs.existsSync(resolved);
        const hasGit = exists && fs.existsSync(path.join(resolved, '.git'));
        ws.send(JSON.stringify({ type: 'setup:validate-path:result', valid: exists, hasGit, resolved }));
        break;
      }

      case 'setup:launch': {
        try {
          const setupData = {
            hiveName: msg.hiveName || '',
            repoDir: msg.repoDir,
            agentCount: msg.agentCount || 4,
            sharedRepo: !!msg.sharedRepo,
            roles: msg.roles || {},
            githubRepo: msg.githubRepo || '',
            perAgentGitUrls: msg.perAgentGitUrls || {},
            createdAt: new Date().toISOString(),
          };
          fs.writeFileSync(setupPath, JSON.stringify(setupData, null, 2));

          // Reload config by clearing require cache
          const configPath = path.join(__dirname, '..', '..', '..', 'hive.config.js');
          delete require.cache[require.resolve(configPath)];
          const newConfig = require(configPath);
          Object.assign(config.sessions, newConfig.sessions);
          config.github = newConfig.github;
          config.links = newConfig.links;

          // Set designations from wizard role names
          if (taskQueue && setupData.roles) {
            for (const [num, name] of Object.entries(setupData.roles)) {
              if (name && !name.startsWith('Slot ')) {
                taskQueue.setDesignation(Number(num), name);
              }
            }
          }

          // Close wizard immediately — sessions will appear on grid as they're created
          fleet.invalidateCache();
          _previewCache.result = null;
          _previewCache.ts = 0;
          ws.send(JSON.stringify({ type: 'setup:complete', sessionsCreated: 0 }));
          sendInitialState(ws);

          // Background: clone (if git) + create sessions + start Claude
          const hasGitUrls = Object.values(setupData.perAgentGitUrls).some(u => u);
          const sessionManager = require('../../core/session-manager');

          (async () => {
            try {
              if (!await sessionManager.isTmuxAvailable()) return;
              await sessionManager.applyGlobalOptions(config.tmux || {});
              const claudePane = config.sessions?.claudePane || 1;
              const prefix = config.sessions?.namePrefix || '';

              if (hasGitUrls) {
                const { cloneOrReuse } = require('../../core/git-utils');
                const baseDir = setupData.repoDir.replace(/^~/, os.homedir());

                if (setupData.sharedRepo) {
                  // Shared: clone once, then create all sessions
                  const gitUrl = Object.values(setupData.perAgentGitUrls).find(u => u);
                  try {
                    await cloneOrReuse(gitUrl, baseDir);
                  } catch (err) {
                    log.error(`[setup] shared clone failed: ${err.message}`);
                  }
                  const results = await sessionManager.createAllSessions(config);
                  for (const num of results.created) {
                    try {
                      await sessionManager.startClaude(`${prefix}${num}`, claudePane, 'claude');
                    } catch (err) {
                      log.error(`Failed to start Claude in session ${num}: ${err.message}`);
                    }
                    broadcastFleetStatus().catch(() => {});
                  }
                } else {
                  // Per-agent: clone + create + start one by one
                  for (let i = 1; i <= setupData.agentCount; i++) {
                    const agentGitUrl = setupData.perAgentGitUrls[String(i)];
                    const agentDir = `${baseDir}${i}`;
                    if (agentGitUrl) {
                      try {
                        await cloneOrReuse(agentGitUrl, agentDir);
                      } catch (err) {
                        log.error(`[setup] agent ${i} clone failed: ${err.message}`);
                      }
                    } else {
                      try { fs.mkdirSync(agentDir, { recursive: true }); } catch (_) {}
                    }
                    const name = `${prefix}${i}`;
                    const repoDir = config.sessions?.repoDir ? config.sessions.repoDir(i) : agentDir;
                    try {
                      await sessionManager.createSession(name, repoDir, {}, config.tmux?.defaultSize || {});
                      await sessionManager.startClaude(name, claudePane, 'claude');
                    } catch (err) {
                      log.error(`[setup] agent ${i} session failed: ${err.message}`);
                    }
                    broadcastFleetStatus().catch(() => {});
                  }
                }
              } else {
                // No git — create all sessions at once (fast)
                const results = await sessionManager.createAllSessions(config);
                for (const num of results.created) {
                  try {
                    await sessionManager.startClaude(`${prefix}${num}`, claudePane, 'claude');
                  } catch (err) {
                    log.error(`Failed to start Claude in session ${num}: ${err.message}`);
                  }
                }
                broadcastFleetStatus().catch(() => {});
              }
            } catch (err) {
              log.error('[setup] background session creation failed:', err.message);
            }
          })();

        } catch (err) {
          log.error('Setup launch error:', err.message);
          ws.send(JSON.stringify({ type: 'setup:error', error: err.message }));
        }
        break;
      }

      case 'setup:skip': {
        const minSetup = { skipped: true, createdAt: new Date().toISOString() };
        fs.writeFileSync(setupPath, JSON.stringify(minSetup, null, 2));
        ws.send(JSON.stringify({ type: 'setup:complete', sessionsCreated: 0 }));
        sendInitialState(ws);
        break;
      }

      // ── MCP tool handlers (called by mcp-server/index.mjs via WS) ──
      case 'mcp:get_task': {
        if (!taskQueue) { ws.send(JSON.stringify({ _reqId: msg._reqId, task: null })); break; }
        const sessionNum = msg.session;
        const taskId = taskQueue.activeTaskBySession.get(sessionNum);
        const task = taskId ? taskQueue.tasks.get(taskId) : null;
        ws.send(JSON.stringify({ _reqId: msg._reqId, task: task ? { id: task.id, text: task.text, status: task.status, designation: task.designation, checklist: task.checklist || [] } : null }));
        break;
      }

      case 'mcp:complete_task': {
        if (!taskQueue) { ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'No task queue' })); break; }
        const sessionNum = msg.session;
        const taskId = taskQueue.activeTaskBySession.get(sessionNum);
        if (!taskId) { ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'No active task for this session' })); break; }
        const task = taskQueue.completeTask(taskId, msg.summary || 'Completed via MCP');
        if (task) {
          broadcast({ type: 'task:completed', task });
          ws.send(JSON.stringify({ _reqId: msg._reqId, ok: true }));
        } else {
          ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'Could not complete task' }));
        }
        break;
      }

      case 'mcp:post_update': {
        if (!taskQueue) { ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'No task queue' })); break; }
        taskQueue.pushFeed('mcp', msg.session, `[Session ${msg.session}] ${msg.message || ''}`);
        ws.send(JSON.stringify({ _reqId: msg._reqId, ok: true }));
        break;
      }

      case 'mcp:report_learnings': {
        if (!taskQueue || !pmManager) { ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'No task queue or PM manager' })); break; }
        const sessionNum = msg.session;
        const taskId = taskQueue.activeTaskBySession.get(sessionNum);
        const task = taskId ? taskQueue.tasks.get(taskId) : null;
        const source = task && task.source;
        if (!source || !source.startsWith('pm:')) {
          ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'No PM-sourced task for this session' }));
          break;
        }
        const pmName = source.slice(3); // strip 'pm:' prefix
        const pm = pmManager.getAll().find(p => p.name === pmName);
        if (!pm) {
          ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: `PM "${pmName}" not found` }));
          break;
        }
        const added = pmManager.addLearnings(pm.id, msg.learnings || []);
        if (added > 0) {
          taskQueue.pushFeed('task', null, `PM "${pm.name}" learned ${added} new insight${added > 1 ? 's' : ''}`);
        }
        ws.send(JSON.stringify({ _reqId: msg._reqId, ok: true, added }));
        break;
      }

      case 'mcp:share_knowledge': {
        if (!pmManager) { ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'No PM manager' })); break; }
        const sessionNum = msg.session;
        const taskId = taskQueue ? taskQueue.activeTaskBySession.get(sessionNum) : null;
        const task = taskId ? taskQueue.tasks.get(taskId) : null;
        const sourcePm = task && task.source ? task.source.replace(/^pm:/, '') : 'unknown';
        const entry = {
          insight: (msg.insight || '').slice(0, 500),
          files: Array.isArray(msg.files) ? msg.files.slice(0, 20) : [],
          domain: (msg.domain || '').slice(0, 50).toLowerCase() || null,
          type: msg.insightType || null,
          sourcePm,
          sourceSession: sessionNum,
          createdAt: Date.now(),
        };
        if (!entry.insight) {
          ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'Missing insight text' }));
          break;
        }
        pmManager.addKnowledge(entry);
        if (taskQueue) taskQueue.pushFeed('task', null, `Knowledge shared: "${entry.insight.slice(0, 80)}..." [${entry.domain || 'general'}]`);
        ws.send(JSON.stringify({ _reqId: msg._reqId, ok: true }));
        break;
      }

      case 'mcp:get_knowledge': {
        if (!pmManager) { ws.send(JSON.stringify({ _reqId: msg._reqId, entries: [], pmLearnings: [] })); break; }
        // Fleet knowledge base
        const entries = pmManager.queryKnowledge(msg.query || '', {
          files: msg.files,
          domain: msg.domain,
        });
        // PM-specific learnings for the session's active task
        let pmLearnings = [];
        if (taskQueue) {
          const sessionNum = msg.session;
          const taskId = taskQueue.activeTaskBySession.get(sessionNum);
          const task = taskId ? taskQueue.tasks.get(taskId) : null;
          if (task && task.source && task.source.startsWith('pm:')) {
            const pmName = task.source.slice(3);
            const pm = pmManager.getAll().find(p => p.name === pmName);
            if (pm && pm.memory && pm.memory.length) {
              // Filter PM learnings by query relevance
              const q = (msg.query || '').toLowerCase();
              const qWords = q ? new Set(q.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3)) : null;
              pmLearnings = pm.memory.filter(m => {
                if (!qWords || !qWords.size) return true; // no query = return all
                const mLower = m.toLowerCase();
                for (const w of qWords) { if (mLower.includes(w)) return true; }
                return false;
              }).slice(0, 20);
            }
          }
        }
        ws.send(JSON.stringify({ _reqId: msg._reqId, entries, pmLearnings }));
        break;
      }

      case 'mcp:get_context': {
        if (!taskQueue) { ws.send(JSON.stringify({ _reqId: msg._reqId, context: {} })); break; }
        const ctx = taskQueue.getSessionContext(msg.session);
        ws.send(JSON.stringify({ _reqId: msg._reqId, context: ctx }));
        break;
      }

      case 'mcp:set_context': {
        if (!taskQueue) { ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'No task queue' })); break; }
        const updates = msg.updates;
        if (!updates || typeof updates !== 'object') {
          ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'updates must be an object' }));
          break;
        }
        const updated = taskQueue.setSessionContext(msg.session, updates);
        broadcast({ type: 'context:updated', session: Number(msg.session), context: updated });
        ws.send(JSON.stringify({ _reqId: msg._reqId, ok: true, context: updated }));
        break;
      }

      case 'mcp:set_working_dir': {
        const num = Number(msg.session);
        const dir = msg.dir;
        if (!dir || typeof dir !== 'string') {
          ws.send(JSON.stringify({ _reqId: msg._reqId, ok: false, error: 'dir must be a non-empty string' }));
          break;
        }
        const resolved = dir.replace(/^~/, os.homedir());
        workingDirOverrides.set(num, resolved);
        broadcast({ type: 'working_dir:updated', session: num, dir: resolved });
        log.info(`Session ${num} working dir set to ${resolved}`);
        ws.send(JSON.stringify({ _reqId: msg._reqId, ok: true, dir: resolved }));
        break;
      }

      case 'mcp:get_sessions': {
        const sessions = await fleet.getFleetStatus(config, router);
        const summary = sessions.map(s => ({ num: s.num, state: s.state, branch: s.branch || null, designation: s.designation || null }));
        ws.send(JSON.stringify({ _reqId: msg._reqId, sessions: summary }));
        break;
      }

      case 'mcp:deploy': {
        if (!checkPermission(ws, user, 'admin')) break;
        const sessionMgr = require('../../core/session-manager');
        const sessions = await fleet.getFleetStatus(config, router);
        const webToken = process.env.WEB_TOKEN || '';
        const hiveWsUrl = `ws://127.0.0.1:${process.env.WEB_PORT || 3000}`;
        let count = 0;
        for (const sess of sessions) {
          try {
            const repoDir = config.sessions.repoDir(sess.num);
            sessionMgr.writeMcpConfig(repoDir, hiveWsUrl, webToken, sess.num, msg.tools);
            count++;
          } catch {}
        }
        // Tell connected MCP server processes to exit — Claude Code will respawn them
        let restarted = 0;
        if (mcpClients) {
          for (const [mcpWs] of mcpClients) {
            try {
              mcpWs.send(JSON.stringify({ type: 'mcp:exit' }));
              restarted++;
            } catch {}
          }
        }
        ws.send(JSON.stringify({ type: 'mcp:deployed', count, restarted }));
        break;
      }

      case 'mcp:remove': {
        if (!checkPermission(ws, user, 'admin')) break;
        const sessionMgr2 = require('../../core/session-manager');
        const sessions = await fleet.getFleetStatus(config, router);
        let count = 0;
        for (const sess of sessions) {
          try {
            const repoDir = config.sessions.repoDir(sess.num);
            sessionMgr2.removeMcpConfig(repoDir);
            count++;
          } catch {}
        }
        ws.send(JSON.stringify({ type: 'mcp:removed', count }));
        break;
      }

      // ── Voice agent ─────────────────────────────────────
      case 'voice:join': {
        if (!checkPermission(ws, user, 'admin')) break;
        if (!voiceAgent) { ws.send(JSON.stringify({ type: 'error', message: 'Voice agent not available' })); break; }
        if (voiceAgent.active) { ws.send(JSON.stringify({ type: 'error', message: 'Already in a meeting' })); break; }
        const meetingUrl = msg.url;
        if (!meetingUrl) { ws.send(JSON.stringify({ type: 'error', message: 'Meeting URL required' })); break; }
        voiceAgent.joinMeeting(meetingUrl, {
          passcode: msg.passcode,
          botName: msg.botName || 'Hive',
          name: msg.name || undefined,
          reportOnJoin: msg.reportOnJoin !== false,
        }).then(() => {
          broadcast({ type: 'voice:status', status: voiceAgent.getStatus() });
        }).catch((err) => {
          ws.send(JSON.stringify({ type: 'voice:error', error: err.message }));
        });
        ws.send(JSON.stringify({ type: 'voice:joining', url: meetingUrl }));
        break;
      }

      case 'voice:leave': {
        if (!checkPermission(ws, user, 'admin')) break;
        if (!voiceAgent || !voiceAgent.active) { ws.send(JSON.stringify({ type: 'error', message: 'Not in a meeting' })); break; }
        voiceAgent.leaveMeeting().then(() => {
          broadcast({ type: 'voice:status', status: voiceAgent.getStatus() });
        });
        break;
      }

      case 'voice:status': {
        const status = voiceAgent ? voiceAgent.getStatus() : { active: false };
        ws.send(JSON.stringify({ type: 'voice:status', status }));
        break;
      }

      case 'voice:speak': {
        if (!checkPermission(ws, user, 'admin')) break;
        if (!voiceAgent || !voiceAgent.active) { ws.send(JSON.stringify({ type: 'error', message: 'Not in a meeting' })); break; }
        if (!msg.text) break;
        voiceAgent._speak(msg.text).catch(err => {
          ws.send(JSON.stringify({ type: 'voice:error', error: err.message }));
        });
        break;
      }

      case 'voice:transcript': {
        if (!voiceAgent || !voiceAgent.transcriber) {
          ws.send(JSON.stringify({ type: 'voice:transcript', transcript: [] }));
          break;
        }
        ws.send(JSON.stringify({ type: 'voice:transcript', transcript: voiceAgent.transcriber.transcript }));
        break;
      }

      case 'voice:meetings': {
        const meetings = voiceAgent ? voiceAgent.getMeetings() : [];
        const status = voiceAgent ? voiceAgent.getStatus() : { active: false };
        ws.send(JSON.stringify({ type: 'voice:meetings', meetings, status }));
        break;
      }

      case 'voice:meeting:detail': {
        if (!voiceAgent || !msg.id) { ws.send(JSON.stringify({ type: 'voice:meeting:detail', meeting: null })); break; }
        const meeting = voiceAgent.getMeeting(msg.id);
        ws.send(JSON.stringify({ type: 'voice:meeting:detail', meeting }));
        break;
      }

      case 'voice:meeting:rename': {
        if (!checkPermission(ws, user, 'admin')) break;
        if (!voiceAgent || !msg.id || !msg.name) break;
        voiceAgent.renameMeeting(msg.id, msg.name);
        ws.send(JSON.stringify({ type: 'voice:meetings', meetings: voiceAgent.getMeetings(), status: voiceAgent.getStatus() }));
        break;
      }

      case 'voice:debug': {
        if (!voiceAgent) { ws.send(JSON.stringify({ type: 'voice:debug', debug: { active: false } })); break; }
        voiceAgent.getDebug().then(debug => {
          ws.send(JSON.stringify({ type: 'voice:debug', debug }));
        }).catch(err => {
          ws.send(JSON.stringify({ type: 'voice:debug', debug: { error: err.message } }));
        });
        break;
      }
    }
  };
}

module.exports = createMessageHandler;
