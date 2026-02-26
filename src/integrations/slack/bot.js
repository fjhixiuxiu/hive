const { App } = require('@slack/bolt');

/**
 * Create and start the Slack bot (Socket Mode).
 * Listens for @mentions and creates tasks in the queue.
 *
 * Requires env vars:
 *   SLACK_APP_TOKEN  (xapp-... app-level token with connections:write)
 *   SLACK_BOT_TOKEN  (xoxb-... bot token with app_mentions:read, chat:write)
 *
 * If either is missing, the bot is silently disabled.
 */
function createSlackBot(taskQueue) {
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
  });

  // Strip the bot mention from the message text
  function stripMention(text) {
    return (text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  }

  // ── @hive mention handler ──────────────────────────
  app.event('app_mention', async ({ event, say }) => {
    const text = stripMention(event.text);
    if (!text) {
      await say({ text: 'What do you need? Try: `@hive review PR #1234` or `@hive status`', thread_ts: event.ts });
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
        thread_ts: event.ts,
      });
      return;
    }

    // ── Help command ──
    if (lower === 'help') {
      await say({
        text: `:bee: *Hive Commands*\n• \`@hive <task description>\` — create a task\n• \`@hive status\` — show queue summary\n• \`@hive help\` — this message`,
        thread_ts: event.ts,
      });
      return;
    }

    // ── Default: create a task ──
    if (!taskQueue) {
      await say({ text: 'Task queue not available.', thread_ts: event.ts });
      return;
    }

    // Gather thread context so the agent has full picture
    let context = '';
    const threadTs = event.thread_ts || null;
    if (threadTs && event.channel) {
      try {
        const result = await app.client.conversations.replies({
          channel: event.channel,
          ts: threadTs,
          limit: 20,
        });
        if (result.messages && result.messages.length > 1) {
          const thread = result.messages
            .filter(m => m.ts !== event.ts) // exclude the mention itself
            .map(m => m.text || '')
            .filter(Boolean)
            .join('\n');
          if (thread) context = `\n\nSlack thread context:\n${thread}`;
        }
      } catch {}
    }

    // Build a permalink for reference
    let permalink = '';
    try {
      const linkResult = await app.client.chat.getPermalink({
        channel: event.channel,
        message_ts: event.ts,
      });
      if (linkResult.permalink) permalink = `\nSlack link: ${linkResult.permalink}`;
    } catch {}

    const fullText = text + permalink + context;

    // Look up Slack user for attribution
    const slackUser = event.user || 'unknown';
    const task = taskQueue.createTask(fullText, 'auto', null, null, {
      source: `slack:${slackUser}`,
      createdBy: slackUser,
    });

    const pos = taskQueue.getQueuePosition(task.id);
    const posText = pos > 0 ? ` (position #${pos} in queue)` : '';
    await say({
      text: `:bee: Task created${posText}:\n> ${text}`,
      thread_ts: event.ts,
    });
  });

  // Start the bot
  app.start().then(() => {
    console.log('Slack bot started (Socket Mode)');
  }).catch(err => {
    console.error('Slack bot failed to start:', err.message);
  });

  return app;
}

module.exports = { createSlackBot };
