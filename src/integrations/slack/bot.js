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
  function findActiveTaskForThread(threadTs) {
    if (!taskQueue || !threadTs) return null;
    const tasks = taskQueue.getTasksList();
    return tasks.find(t =>
      (t.status === 'queued' || t.status === 'dispatched') &&
      t.slackThreadTs === threadTs
    );
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

  // ── Shared handler for both @mentions and DMs ──────
  async function handleMessage(event, say) {
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
      const activeTask = findActiveTaskForThread(event.thread_ts);
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

    // ── Follow-up: active task in this thread? Send directly to session ──
    if (threadTs) {
      const activeTask = findActiveTaskForThread(threadTs);
      if (activeTask && activeTask.status === 'dispatched' && activeTask.assignedTo) {
        try {
          const found = await fleet.findSession(config, router, activeTask.assignedTo);
          if (found) {
            const node = router.getNode(found.nodeId);
            await relay.tell(config, node, found.name, text, { vimMode: taskQueue.vimMode });
            await say({
              text: `:bee: Sent to session ${activeTask.assignedTo}:\n> ${text}`,
              thread_ts: replyTs,
            });
            return;
          }
        } catch (err) {
          console.error('Slack follow-up relay error:', err.message);
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

    const task = taskQueue.createTask(fullText, mode, targetSession, designation, {
      source: `slack:${authorName}`,
      createdBy: authorName,
    });

    // Seed checklist from PM if configured
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

    task.slackChannel = event.channel;
    task.slackThreadTs = threadTs || event.ts;
    taskQueue._saveState();

    const pos = taskQueue.getQueuePosition(task.id);
    const posText = pos > 0 ? ` (position #${pos} in queue)` : '';
    await say({
      text: `:bee: Task created${posText}:\n> ${text}`,
      thread_ts: replyTs,
    });
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

  // Start the bot
  app.start().then(() => {
    console.log('Slack bot started (Socket Mode)');
  }).catch(err => {
    console.error('Slack bot failed to start:', err.message);
  });

  return app;
}

module.exports = { createSlackBot };
