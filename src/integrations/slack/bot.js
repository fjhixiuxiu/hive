const { App } = require('@slack/bolt');
const fleet = require('../../core/fleet');
const relay = require('../../core/relay');

/**
 * Create and start the Slack bot (Socket Mode).
 *
 * Thread-aware task flow:
 * - New thread mention → create task with full thread context
 * - Follow-up mention in same thread → send directly to active session
 * - Task completes → reply back to Slack thread with result
 * - Channel mention (not in thread) → grab last 10 messages as context
 *
 * Requires env vars:
 *   SLACK_APP_TOKEN  (xapp-... app-level token with connections:write)
 *   SLACK_BOT_TOKEN  (xoxb-... bot token with app_mentions:read, chat:write)
 */
function createSlackBot(taskQueue, config, router, pmManager) {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;

  if (!appToken || !botToken) {
    console.log('Missing SLACK_APP_TOKEN or SLACK_BOT_TOKEN — Slack bot disabled');
    return null;
  }

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
    ignoreSelf: false, // Allow bot's own messages through — channel monitors may need them
    clientOptions: {
      slackApiUrl: 'https://slack.com/api/',
    },
    socketModeOptions: {
      pingPongLoggingEnabled: false,
      serverPingTimeoutMS: 15000,  // 15s (default 5s — too tight when event loop is busy)
      clientPingTimeoutMS: 15000,
    },
  });

  // Strip the bot mention from the message text
  function stripMention(text) {
    return (text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  }

  // Resolve Slack user ID to display name
  async function userName(userId) {
    try {
      const result = await app.client.users.info({ user: userId });
      return result.user.real_name || result.user.name || userId;
    } catch { return userId; }
  }

  // Fetch thread messages (up to 100), formatted with author names
  async function getThreadContext(channel, threadTs, excludeTs) {
    try {
      const result = await app.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 100,
      });
      if (!result.messages || result.messages.length <= 1) return '';
      const lines = [];
      for (const m of result.messages) {
        if (m.ts === excludeTs) continue;
        const name = await userName(m.user);
        const text = stripMention(m.text || '');
        if (text) lines.push(`${name}: ${text}`);
      }
      return lines.join('\n');
    } catch { return ''; }
  }

  // Fetch recent channel messages (last N), formatted
  async function getChannelContext(channel, beforeTs, limit) {
    try {
      const result = await app.client.conversations.history({
        channel,
        latest: beforeTs,
        limit: limit || 10,
      });
      if (!result.messages || !result.messages.length) return '';
      const lines = [];
      for (const m of result.messages.reverse()) {
        const name = await userName(m.user);
        const text = stripMention(m.text || '');
        if (text) lines.push(`${name}: ${text}`);
      }
      return lines.join('\n');
    } catch { return ''; }
  }

  // Get permalink for a message
  async function getPermalink(channel, ts) {
    try {
      const result = await app.client.chat.getPermalink({ channel, message_ts: ts });
      return result.permalink || '';
    } catch { return ''; }
  }

  // Find an active (queued/dispatched) task linked to a Slack thread
  function findActiveTaskForThread(threadTs, channel) {
    if (!taskQueue || !threadTs) return null;
    const tasks = taskQueue.getTasksList();
    // Direct match on task.slackThreadTs (existing behavior)
    const directMatch = tasks.find(t =>
      (t.status === 'queued' || t.status === 'dispatched') &&
      t.slackThreadTs === threadTs
    );
    if (directMatch) return directMatch;

    // Fallback: check session context for dispatched tasks (e.g. PM-created tasks linked to a thread)
    const threadKey = channel ? `${channel}:${threadTs}` : null;
    if (!threadKey) return null;
    return tasks.find(t => {
      if (t.status !== 'dispatched' || !t.assignedTo) return false;
      const ctx = taskQueue.getSessionContext(t.assignedTo);
      return ctx.slackThread === threadKey;
    }) || null;
  }

  // Find a PM with source.type === 'slack' matching the channel
  function findSlackPM(channel) {
    if (!pmManager) return null;
    const pms = pmManager.getAll().filter(pm => pm.enabled && pm.source.type === 'slack');
    // Exact channel match first
    const exact = pms.find(pm => pm.source.channel && pm.source.channel === channel);
    if (exact) return exact;
    // Fallback: catch-all (no channel set)
    return pms.find(pm => !pm.source.channel) || null;
  }

  // ── Channel Monitor PM helpers ──────────────────────
  // Debounce state: threadKey → { messages: [], timer, pm }
  const _monitorDebounce = new Map();
  // Rate limit state: pmId:channel → { count, resetAt }
  const _monitorRateLimit = new Map();

  /**
   * Find an enabled channel-monitor PM that watches this channel.
   */
  function findChannelMonitorPM(channel) {
    if (!pmManager) return null;
    const pms = pmManager.getAll().filter(pm =>
      pm.enabled &&
      pm.source.type === 'slack-channel-monitor' &&
      pm.source.channels &&
      pm.source.channels.includes(channel)
    );
    return pms[0] || null;
  }

  /**
   * Check rate limit for a channel monitor PM.
   * Returns true if under the limit.
   */
  function checkMonitorRateLimit(pm, channel) {
    const maxPerHour = pm.source.maxRelaysPerHour || 30;
    const key = `${pm.id}:${channel}`;
    const now = Date.now();
    let entry = _monitorRateLimit.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 3600000 };
      _monitorRateLimit.set(key, entry);
    }
    if (entry.count >= maxPerHour) return false;
    entry.count++;
    return true;
  }

  /**
   * Relay a batch of debounced messages to the monitor PM's session.
   */
  async function relayToMonitorSession(pm, threadKey, messages) {
    const sessionName = `hive-pm-${pm.id}`;
    const node = router.getNode('local');
    if (!node) {
      console.error('[slack-monitor] No local node available');
      return;
    }

    // Ensure the PM session exists
    try {
      await pmManager.ensureMonitorSession(pm, config);
    } catch (err) {
      console.error(`[slack-monitor] Failed to ensure session for PM "${pm.name}": ${err.message}`);
      return;
    }

    // Format the batch into a single message
    const parts = messages.map(m => `${m.author}: ${m.text}`).join('\n');
    const channel = messages[0]?.channel || '';
    const threadTs = messages[0]?.threadTs || messages[0]?.ts || '';
    const isThread = !!messages[0]?.threadTs;
    const permalink = messages[0]?.permalink || '';

    // Check for existing active task for this thread
    const existingTask = threadTs ? findActiveTaskForThread(threadTs, channel) : null;
    let existingContext = '';
    if (existingTask) {
      existingContext = `\nContext: There is already an active task (#${existingTask.id}) on S:${existingTask.assignedTo || 'queued'} for this thread.`;
    }

    // Build the custom instructions snippet (from PM config or default)
    const customInstructions = pm.source.systemPrompt
      ? `\nPM Instructions: ${pm.source.systemPrompt}`
      : '';

    const formatted = [
      `New message${messages.length > 1 ? 's' : ''} in channel ${channel}:`,
      isThread ? `Thread: ${permalink || threadTs}` : `Channel message: ${permalink || ''}`,
      '',
      parts,
      existingContext,
      '',
      '---',
      'Decide: Does this need a new task, a follow-up to an existing task, or no action?',
      customInstructions,
      '',
      `If creating a task, you MUST pass slackChannel="${channel}" and slackThreadTs="${threadTs || messages[0]?.ts || ''}" so replies route back to Slack.`,
      `Do NOT set a designation on tasks — leave it empty so any idle session picks it up.`,
    ].join('\n');

    try {
      const result = await relay.tell(config, node, sessionName, formatted, {});
      if (result.success) {
        console.log(`[slack-monitor] Relayed ${messages.length} message(s) to PM "${pm.name}" session`);
      } else {
        console.error(`[slack-monitor] Relay failed: ${result.error}`);
      }
    } catch (err) {
      console.error(`[slack-monitor] Relay error: ${err.message}`);
    }
  }

  // ── Shared handler for both @mentions and DMs ──────
  async function handleMessage(event, say) {
    try {
      await _handleMessage(event, say);
    } catch (err) {
      console.error(`[slack] Unhandled error in handleMessage: ${err.message}`, err.stack);
      try {
        await say({ text: `:x: Something went wrong processing your message. Error logged.`, thread_ts: event.thread_ts || event.ts });
      } catch { /* can't even reply */ }
    }
  }

  async function _handleMessage(event, say) {
    const text = stripMention(event.text);
    if (!text) {
      await say({ text: 'What do you need? Try: `@hive <task>` or `@hive status`', thread_ts: event.ts });
      return;
    }

    const lower = text.toLowerCase();

    // ── Status command ──
    if (lower === 'status' || lower === 'queue') {
      if (!taskQueue) {
        await say({ text: 'Task queue not available.', thread_ts: event.ts });
        return;
      }
      const tasks = taskQueue.getTasksList();
      const queued = tasks.filter(t => t.status === 'queued').length;
      const inProgress = tasks.filter(t => t.status === 'dispatched').length;
      const completed = tasks.filter(t => t.status === 'completed').length;
      await say({
        text: `:bee: *Hive Status*\n• Queued: ${queued}\n• In Progress: ${inProgress}\n• Completed today: ${completed}`,
        thread_ts: event.thread_ts || event.ts,
      });
      return;
    }

    // ── Help command ──
    if (lower === 'help') {
      await say({
        text: `:bee: *Hive Commands*\n• \`@hive <task>\` — create a task (with thread/channel context)\n• \`@hive <follow-up>\` — send follow-up to active task in same thread\n• \`@hive close\` — close the task in this thread\n• \`@hive status\` — show queue summary\n• \`@hive help\` — this message\n\nWorks in channels (@mention), DMs, and threads.`,
        thread_ts: event.thread_ts || event.ts,
      });
      return;
    }

    // ── Close task command ──
    if (lower === 'close' || lower === 'done' || lower === 'close task') {
      if (!event.thread_ts) {
        await say({ text: 'Use this command in a task thread.', thread_ts: event.ts });
        return;
      }
      const activeTask = findActiveTaskForThread(event.thread_ts, event.channel);
      if (!activeTask) {
        await say({ text: 'No active task in this thread.', thread_ts: event.thread_ts });
        return;
      }
      if (activeTask.status === 'dispatched') {
        taskQueue.completeTask(activeTask.id, 'Closed via Slack');
      } else {
        taskQueue.cancelTask(activeTask.id);
      }
      await say({ text: ':white_check_mark: Task closed.', thread_ts: event.thread_ts });
      return;
    }

    // ── Task creation / follow-up ──
    if (!taskQueue) {
      await say({ text: 'Task queue not available.', thread_ts: event.thread_ts || event.ts });
      return;
    }

    const threadTs = event.thread_ts || null;
    const replyTs = event.thread_ts || event.ts;

    // ── Follow-up: active task in this thread? Relay or append ──
    if (threadTs) {
      const activeTask = findActiveTaskForThread(threadTs, event.channel);
      if (activeTask) {
        if (activeTask.status === 'dispatched' && activeTask.assignedTo) {
          // Running on a session — relay directly
          try {
            const found = await fleet.findSession(config, router, activeTask.assignedTo);
            if (found) {
              const node = router.getNode(found.nodeId);
              const result = await relay.tell(config, node, found.name, text + '\n\nReply back on the thread when done.', { vimMode: taskQueue.vimMode });
              if (result.success) {
                await say({
                  text: `:bee: Sent to session ${activeTask.assignedTo}:\n> ${text}`,
                  thread_ts: replyTs,
                });
                return;
              }
              // Relay failed — fall through to create new task
              console.error(`Slack relay failed for S:${activeTask.assignedTo}: ${result.error}`);
            }
          } catch (err) {
            console.error('Slack follow-up relay error:', err.message);
          }
        } else if (activeTask.status === 'queued') {
          // Still queued — append follow-up to the task text
          activeTask.text += `\n\nFollow-up:\n${text}`;
          taskQueue._saveState();
          await say({
            text: `:bee: Appended to queued task:\n> ${text}`,
            thread_ts: replyTs,
          });
          return;
        }
      }
    }

    // ── PM-based routing: find a matching Slack PM for this channel ──
    const slackPm = findSlackPM(event.channel);

    // ── New task: gather context ──
    let context = '';
    if (threadTs) {
      context = await getThreadContext(event.channel, threadTs, event.ts);
    } else if (event.channel_type !== 'im') {
      // Channel mention — grab last 10 messages (skip for DMs)
      context = await getChannelContext(event.channel, event.ts, 10);
    }

    const permalink = await getPermalink(event.channel, event.ts);
    const slackUser = event.user || 'unknown';
    const authorName = await userName(slackUser);

    let fullText = '';
    if (context) {
      fullText += `Context (Slack ${threadTs ? 'thread' : 'channel'}):\n${context}\n\n---\n\n`;
    }
    if (slackPm && slackPm.taskFormat) {
      fullText += slackPm.taskFormat.replace('{key}', `slack-${Date.now()}`).replace('{summary}', text);
    } else {
      fullText += `Instructions:\n${text}`;
    }
    if (slackPm && slackPm.instructions) {
      fullText += `\n\nInstructions: ${slackPm.instructions}`;
    }
    if (permalink) fullText += `\n\nSlack link: ${permalink}`;

    // Use PM config for routing if available, otherwise defaults
    const mode = slackPm && slackPm.targetSession ? 'manual' : 'auto';
    const targetSession = (slackPm && slackPm.targetSession) || null;
    const designation = (slackPm && slackPm.designation) || null;

    let task;
    try {
      task = taskQueue.createTask(fullText, mode, targetSession, designation, {
        source: `slack:${authorName}`,
        createdBy: authorName,
        requireHumanClose: slackPm ? !!slackPm.requireHumanClose : false,
      });

      // Set Slack fields IMMEDIATELY so they're included in any subsequent save
      task.slackChannel = event.channel;
      task.slackThreadTs = threadTs || event.ts;
      taskQueue._saveState();
      console.log(`[slack] Task ${task.id} created (${mode}) for thread ${task.slackThreadTs} in ${event.channel}`);
    } catch (err) {
      console.error(`[slack] Task creation failed: ${err.message}`, err.stack);
      await say({ text: `:x: Failed to create task: ${err.message}`, thread_ts: replyTs });
      return;
    }

    // Seed checklist from PM if configured
    try {
      if (slackPm && slackPm.checklistTemplate && pmManager) {
        pmManager._seedChecklist(slackPm, task);
      }

      // Track PM stats
      if (slackPm) {
        slackPm.tasksCreated++;
        slackPm.lastPoll = Date.now();
        pmManager._save();
        pmManager.emit('pm:changed');
      }
    } catch (err) {
      console.error(`[slack] PM stats/checklist error (task ${task.id} still created): ${err.message}`);
    }

    const pos = taskQueue.getQueuePosition(task.id);
    const posText = pos > 0 ? ` (position #${pos} in queue)` : '';
    try {
      await say({
        text: `:bee: Task created${posText}:\n> ${text}`,
        thread_ts: replyTs,
      });
    } catch (err) {
      console.error(`[slack] Failed to reply for task ${task.id}: ${err.message}`);
    }
  }

  // ── Channel @mentions ──
  app.event('app_mention', async ({ event, say }) => handleMessage(event, say));

  // ── DMs ──
  app.event('message', async ({ event, say }) => {
    // Only handle direct messages, skip channel messages (handled by app_mention)
    if (event.channel_type !== 'im') return;
    // Skip bot's own messages and message edits/deletes
    if (event.bot_id || event.subtype) return;
    await handleMessage(event, say);
  });

  // ── Auto-relay: thread messages in tracked threads (no @mention needed) ──
  app.event('message', async ({ event, say }) => {
    // Only channel thread replies (not DMs, not top-level)
    if (event.channel_type === 'im' || !event.thread_ts) return;
    // Skip bot messages, edits, and @mentions (handled above)
    if (event.bot_id || event.subtype) return;
    const text = (event.text || '').trim();
    if (!text) return;
    // Skip if this is an @mention of the bot (already handled by app_mention)
    if (text.match(/<@[A-Z0-9]+>/)) return;

    // Only relay if this thread is linked to an active dispatched task
    const activeTask = findActiveTaskForThread(event.thread_ts, event.channel);
    if (!activeTask || activeTask.status !== 'dispatched' || !activeTask.assignedTo) return;

    try {
      const authorName = await userName(event.user);
      const found = await fleet.findSession(config, router, activeTask.assignedTo);
      if (!found) return;
      const node = router.getNode(found.nodeId);
      const result = await relay.tell(config, node, found.name,
        `Slack thread update from ${authorName}:\n${text}\n\nReply back on the thread when done.`,
        { vimMode: taskQueue.vimMode });
      if (result.success) {
        console.log(`[slack] Auto-relayed thread message to S:${activeTask.assignedTo} from ${authorName}`);
      }
    } catch (err) {
      console.error(`[slack] Auto-relay error: ${err.message}`);
    }
  });

  // ── Channel Monitor: watch configured channels for actionable messages ──
  app.event('message', async ({ event }) => {
    // Skip edits, joins, etc. (but not bot messages — PM config controls that)
    if (event.subtype) return;
    // Skip DMs (handled by DM handler above)
    if (event.channel_type === 'im') return;
    // Skip @mentions (handled by app_mention above)
    if ((event.text || '').match(/<@[A-Z0-9]+>/)) return;

    const channel = event.channel;
    const pm = findChannelMonitorPM(channel);
    if (!pm) return;

    // Skip bot messages if PM has ignoreBots enabled (default: true)
    if (event.bot_id && pm.source.ignoreBots !== false) return;

    const threadTs = event.thread_ts || null;
    const messageTs = event.ts;

    // Skip threads that already have an active task (auto-relay handles those)
    if (pm.source.ignoreThreadsWithActiveTasks !== false && threadTs) {
      const activeTask = findActiveTaskForThread(threadTs, channel);
      if (activeTask) return;
    }

    // Rate limit check
    if (!checkMonitorRateLimit(pm, channel)) {
      console.log(`[slack-monitor] Rate limit reached for PM "${pm.name}" on channel ${channel}`);
      return;
    }

    // Resolve author
    const authorName = await userName(event.user);
    const text = (event.text || '').trim();
    if (!text) return;

    const permalink = await getPermalink(channel, messageTs);

    const entry = { author: authorName, text, channel, ts: messageTs, threadTs, permalink };

    // Debounce: batch thread messages
    const debounceMs = pm.source.threadDebounceMs || 60000;
    const threadKey = threadTs ? `${channel}:${threadTs}` : `${channel}:${messageTs}`;

    let bucket = _monitorDebounce.get(threadKey);
    if (bucket) {
      // Add to existing batch, reset timer
      bucket.messages.push(entry);
      clearTimeout(bucket.timer);
    } else {
      bucket = { messages: [entry], timer: null, pm };
      _monitorDebounce.set(threadKey, bucket);
    }

    // Set timer to flush the batch
    bucket.timer = setTimeout(async () => {
      const batch = _monitorDebounce.get(threadKey);
      _monitorDebounce.delete(threadKey);
      if (batch && batch.messages.length > 0) {
        await relayToMonitorSession(pm, threadKey, batch.messages);
      }
    }, threadTs ? debounceMs : 5000); // Top-level messages: short delay (5s). Thread replies: full debounce.
  });

  // ── Reply back to Slack when task completes ──────────
  if (taskQueue) {
    taskQueue.on('task:completed', async (task) => {
      if (!task.slackChannel || !task.slackThreadTs) return;
      try {
        const duration = task.dispatchedAt
          ? Math.round((task.completedAt - task.dispatchedAt) / 60000)
          : 0;
        const resultSnippet = task.result
          ? task.result.substring(0, 300)
          : 'No result summary available.';
        await app.client.chat.postMessage({
          channel: task.slackChannel,
          thread_ts: task.slackThreadTs,
          text: `:white_check_mark: *Task completed* (${duration}m)\n${resultSnippet}`,
        });
      } catch (err) {
        console.error('Slack reply-back error:', err.message);
      }
    });

    taskQueue.on('task:failed', async (task) => {
      if (!task.slackChannel || !task.slackThreadTs) return;
      try {
        await app.client.chat.postMessage({
          channel: task.slackChannel,
          thread_ts: task.slackThreadTs,
          text: `:x: *Task failed*: ${task.result || 'Unknown error'}`,
        });
      } catch (err) {
        console.error('Slack reply-back error:', err.message);
      }
    });
  }

  // ── Connection health monitoring ──
  // SocketModeReceiver exposes lifecycle events; log them so silent deaths are visible
  if (app.receiver && app.receiver.client) {
    const smClient = app.receiver.client;
    smClient.on('connected', () => {
      console.log('[slack] Socket Mode connected');
    });
    smClient.on('disconnected', () => {
      console.warn('[slack] Socket Mode disconnected — will auto-reconnect');
    });
    smClient.on('reconnecting', () => {
      console.log('[slack] Socket Mode reconnecting...');
    });
    smClient.on('error', (err) => {
      console.error(`[slack] Socket Mode error: ${err.message}`);
    });
    smClient.on('close', (code, reason) => {
      console.warn(`[slack] Socket Mode closed (code=${code}, reason=${reason || 'none'})`);
    });
  }

  // Health check: periodically verify the connection is alive via auth.test
  const HEALTH_INTERVAL = 5 * 60 * 1000; // 5 min
  setInterval(async () => {
    try {
      await app.client.auth.test();
    } catch (err) {
      console.error(`[slack] Health check failed: ${err.message} — restarting socket`);
      try {
        await app.stop();
        await app.start();
        console.log('[slack] Bot restarted after health check failure');
      } catch (restartErr) {
        console.error(`[slack] Restart failed: ${restartErr.message}`);
      }
    }
  }, HEALTH_INTERVAL);

  // Start the bot
  app.start().then(() => {
    console.log('Slack bot started (Socket Mode)');
  }).catch(err => {
    console.error('Slack bot failed to start:', err.message);
  });

  return app;
}

module.exports = { createSlackBot };
