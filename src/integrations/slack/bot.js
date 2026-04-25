const { App } = require('@slack/bolt');
const fleet = require('../../core/fleet');
const relay = require('../../core/relay');
const log = require('../../core/log');

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

  // Find an active (queued/dispatched) task linked to a Slack thread.
  //
  // [Phase 1 — context-consolidation] Dual lookup path:
  //   1. Direct match on old-style task.slackThreadTs fields (original behavior)
  //   2. Fallback: sessionContext.slackThread (set by _dispatchTask for slack-
  //      originated tasks, or by Claude via hive_set_context for PM-created tasks)
  //
  // Phase 2 will collapse to a single path: sessionContext.slackThread for
  // dispatched tasks, task._slackContext for queued tasks (see plan Step 3 /
  // "findActiveTaskForThread" row in the "What changes" table).
  // See: ~/dev/agents/hive/context-consolidation-plan.md
  function findActiveTaskForThread(threadTs, channel) {
    if (!taskQueue || !threadTs) {
      log.info(`[slack:rcv] findActiveTaskForThread: no taskQueue or threadTs (threadTs=${threadTs})`);
      return null;
    }
    const tasks = taskQueue.getTasksList();
    // Direct match on task.slackThreadTs (existing behavior)
    const directMatch = tasks.find(t =>
      (t.status === 'queued' || t.status === 'dispatched') &&
      t.slackThreadTs === threadTs
    );
    if (directMatch) {
      log.info(`[slack:rcv] findActiveTaskForThread: directMatch task=${directMatch.id} status=${directMatch.status} assignedTo=${directMatch.assignedTo} thread=${threadTs}`);
      return directMatch;
    }

    // Fallback: check session context for dispatched tasks (e.g. PM-created tasks linked to a thread)
    const threadKey = channel ? `${channel}:${threadTs}` : null;
    if (!threadKey) {
      log.info(`[slack:rcv] findActiveTaskForThread: no channel for threadKey lookup`);
      return null;
    }
    const ctxMatch = tasks.find(t => {
      if (t.status !== 'dispatched' || !t.assignedTo) return false;
      const ctx = taskQueue.getSessionContext(t.assignedTo);
      return ctx.slackThread === threadKey;
    }) || null;
    log.info(`[slack:rcv] findActiveTaskForThread: directMatch=null ctxMatch=${ctxMatch ? ctxMatch.id : 'null'} threadKey=${threadKey}`);
    return ctxMatch;
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
  // Last relayed Slack context per PM session — used by ws-handlers to
  // auto-attach slackChannel/slackThreadTs on PM-created tasks.
  // Key: session name (e.g. "hive-pm-13"), Value: { channel, threadTs, at }
  if (taskQueue) taskQueue.lastRelayedSlackContext = new Map();

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
      `## Replying and creating tasks`,
      `To reply to this thread: use slack_post_message with channel_id="${channel}" and thread_ts="${threadTs || messages[0]?.ts || ''}".`,
      `To create a hive task: pass slackChannel="${channel}" and slackThreadTs="${threadTs || messages[0]?.ts || ''}" so replies route back.`,
      `Do NOT set a designation on tasks — leave it empty so any idle session picks it up.`,
    ].join('\n');

    try {
      const result = await relay.tell(config, node, sessionName, formatted, {});
      if (result.success) {
        console.log(`[slack-monitor] Relayed ${messages.length} message(s) to PM "${pm.name}" session`);
        // Store context so ws-handlers can auto-attach to PM-created tasks
        if (taskQueue && taskQueue.lastRelayedSlackContext && channel && threadTs) {
          taskQueue.lastRelayedSlackContext.set(sessionName, { channel, threadTs, at: Date.now() });
        }
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
    log.info(`[slack:rcv] _handleMessage entry ts=${event.ts} thread_ts=${event.thread_ts || ''} ch=${event.channel} type=${event.type || 'message'}`);
    const text = stripMention(event.text);
    if (!text) {
      log.info(`[slack:rcv] _handleMessage exit: empty text after stripMention`);
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
      log.info(`[slack:rcv] _handleMessage follow-up check: threadTs=${threadTs} activeTask=${activeTask ? `${activeTask.id}/${activeTask.status}` : 'null'}`);
      if (activeTask) {
        if (activeTask.status === 'dispatched' && activeTask.assignedTo) {
          // Running on a session — relay directly
          try {
            const found = await fleet.findSession(config, router, activeTask.assignedTo);
            if (found) {
              const node = router.getNode(found.nodeId);
              const result = await relay.tell(config, node, found.name, text + '\n\nReply back on the thread when done.', { vimMode: taskQueue.vimMode });
              if (result.success) {
                // React instead of echoing the message back
                await app.client.reactions.add({
                  channel: event.channel, name: 'bee', timestamp: event.ts,
                }).catch(() => {});
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
          await app.client.reactions.add({
            channel: event.channel, name: 'bee', timestamp: event.ts,
          }).catch(() => {});
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
    // Tell session to use hive_reply_thread for Slack replies (no raw timestamps in prompt)
    fullText += `\n\nTo reply to the Slack thread, use the hive_reply_thread tool with your message.`;

    // Use PM config for routing if available, otherwise defaults
    const mode = slackPm && slackPm.targetSession ? 'manual' : 'auto';
    const targetSession = (slackPm && slackPm.targetSession) || null;
    const designation = (slackPm && slackPm.designation) || null;

    let task;
    try {
      log.info(`[slack:rcv] _handleMessage createTask path: ts=${event.ts} thread_ts=${threadTs || ''} ch=${event.channel} mode=${mode} target=${targetSession}`);
      task = taskQueue.createTask(fullText, mode, targetSession, designation, {
        source: `slack:${authorName}`,
        createdBy: authorName,
        requireHumanClose: slackPm ? !!slackPm.requireHumanClose : false,
      });

      // Set Slack fields IMMEDIATELY so they're included in any subsequent save.
      // [Phase 1 — context-consolidation] Post-creation mutation with old-style
      // slack fields. Phase 2 will pass { slackContext: { channel, threadTs } } in
      // createTask meta and drop this mutation block.
      // See: ~/dev/agents/hive/context-consolidation-plan.md (Step 3: Slack bot refactor)
      task.slackChannel = event.channel;
      task.slackThreadTs = threadTs || event.ts;
      task._lastSeenSlackTs = event.ts; // seed high-water mark so poller doesn't replay
      if (permalink) task.slackPermalink = permalink;
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

    // React with :bee: instead of echoing the message back
    try {
      await app.client.reactions.add({
        channel: event.channel,
        name: 'bee',
        timestamp: event.ts,
      });
    } catch (err) {
      // already_reacted is fine
      if (!err.data || err.data.error !== 'already_reacted') {
        console.error(`[slack] Failed to react for task ${task.id}: ${err.message}`);
      }
    }
  }

  // ── Zombie Socket Mode detection ──
  // Track when we last received ANY event from Slack. Slack Bolt + Socket Mode
  // can silently zombie — the WebSocket stays open and pings/pongs succeed,
  // but Slack stops delivering real events. If this value gets stale while the
  // socket claims to be "connected", the health check below will probe
  // monitored channels and force-restart the bot.
  //
  // This middleware ALSO logs every incoming event at the top of the Bolt
  // middleware chain (before any handler/filter). Grep for [slack:rcv] to
  // diagnose missing messages — if an @mention doesn't create a task, the
  // first question is "did the bot even receive it?". This line answers that.
  let lastEventAt = Date.now();
  const lastEventByChannel = new Map(); // channel -> timestamp of last received event
  const lastSeenByThread = new Map();   // "channel:threadTs" -> last seen Slack ts (string)
  app.use(async ({ body, next }) => {
    lastEventAt = Date.now();
    try {
      const ev = (body && body.event) || {};
      const type = ev.type || (body && body.type) || 'unknown';
      const ch = ev.channel || '';
      if (ch) lastEventByChannel.set(ch, Date.now());
      const ts = ev.ts || '';
      const threadTs = ev.thread_ts || '';
      const user = ev.user || '';
      const sub = ev.subtype || '';
      const textPreview = (ev.text || '').slice(0, 100).replace(/\n/g, ' ');
      log.info(`[slack:rcv] type=${type} ch=${ch} ts=${ts} thread_ts=${threadTs} user=${user} sub=${sub} text="${textPreview}"`);
    } catch (err) {
      log.warn(`[slack:rcv] middleware log failed: ${err.message}`);
    }
    await next();
  });

  // ── @mention dedupe ───────────────────────────────────────────────────
  // Slack USUALLY fires `app_mention` for @mentions in channels, including
  // thread replies. But for some threads (observed: long-running threads
  // with many replies in C0A72B59EDC, ~67 messages in the case that
  // surfaced this) Slack stops firing `app_mention` and only fires the
  // `message` event. We can't predict which threads enter that state, so
  // we route @mentions through `handleMessage` from BOTH event handlers
  // and dedupe by `event.ts` (unique per Slack message; the same ts is
  // shared by app_mention + message events for the same underlying
  // message, and by Slack's retries).
  //
  // The dedupe map is bounded by a 60s TTL via lazy GC on every set.
  // Slack retries happen within seconds, not minutes, so 60s is plenty.
  const _recentlyHandledMentions = new Map(); // ts → markedAt (ms)
  const MENTION_DEDUPE_TTL_MS = 60 * 1000;
  function markMentionHandled(ts) {
    if (!ts) return;
    const now = Date.now();
    _recentlyHandledMentions.set(ts, now);
    // Lazy GC: drop entries older than the TTL on every set
    for (const [k, v] of _recentlyHandledMentions) {
      if (now - v > MENTION_DEDUPE_TTL_MS) _recentlyHandledMentions.delete(k);
    }
  }
  function isMentionAlreadyHandled(ts) {
    if (!ts) return false;
    const t = _recentlyHandledMentions.get(ts);
    if (!t) return false;
    if (Date.now() - t > MENTION_DEDUPE_TTL_MS) {
      _recentlyHandledMentions.delete(ts);
      return false;
    }
    return true;
  }

  // ── Channel @mentions ──
  app.event('app_mention', async ({ event, say }) => {
    if (isMentionAlreadyHandled(event.ts)) {
      log.info(`[slack:rcv] app_mention ts=${event.ts} deduped (already handled via message event)`);
      return;
    }
    markMentionHandled(event.ts);
    return handleMessage(event, say);
  });

  // Subtypes that represent real user-authored messages (vs edits/joins/etc).
  // `undefined` = plain message. `file_share` = message with attachment.
  // `thread_broadcast` = thread reply broadcast to channel.
  const isUserMessage = (event) =>
    !event.subtype || event.subtype === 'file_share' || event.subtype === 'thread_broadcast';

  // ── DMs ──
  app.event('message', async ({ event, say }) => {
    // Only handle direct messages, skip channel messages (handled by app_mention)
    if (event.channel_type !== 'im') return;
    // Skip bot's own messages and message edits/deletes
    if (event.bot_id || !isUserMessage(event)) return;
    await handleMessage(event, say);
  });

  // ── Auto-relay: thread messages in tracked threads (no @mention needed) ──
  app.event('message', async ({ event, say }) => {
    // Only channel thread replies (not DMs, not top-level)
    if (event.channel_type === 'im' || !event.thread_ts) return;
    // Skip bot messages and message edits/deletes
    if (event.bot_id || !isUserMessage(event)) return;
    const text = (event.text || '').trim();
    if (!text) return;

    // @mention in a thread reply: Slack USUALLY fires app_mention for these,
    // but for some long threads it only fires the 'message' event. Route to
    // handleMessage from here too, deduped by event.ts so we don't process
    // twice when both events fire. See _recentlyHandledMentions comment block.
    if (botUserId && text.includes(`<@${botUserId}>`)) {
      if (isMentionAlreadyHandled(event.ts)) {
        log.info(`[slack:rcv] thread-reply @mention ts=${event.ts} deduped (already handled via app_mention)`);
        return;
      }
      markMentionHandled(event.ts);
      return handleMessage(event, say);
    }

    // Only relay if this thread is linked to an active dispatched task
    const activeTask = findActiveTaskForThread(event.thread_ts, event.channel);
    if (!activeTask || activeTask.status !== 'dispatched' || !activeTask.assignedTo) return;

    // Track high-water mark for thread polling dedup (in-memory + persisted on task)
    const threadKey = `${event.channel}:${event.thread_ts}`;
    lastSeenByThread.set(threadKey, event.ts);
    activeTask._lastSeenSlackTs = event.ts;
    taskQueue._saveState();

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
    // Skip edits, joins, etc. (but not bot messages — PM config controls that).
    // Allow file_share + thread_broadcast so messages with attachments/screenshots reach the monitor.
    if (!isUserMessage(event)) return;
    // Skip DMs (handled by DM handler above)
    if (event.channel_type === 'im') return;
    // Skip @mentions of the bot (handled by app_mention above) — but allow mentions of other users
    if (botUserId && (event.text || '').includes(`<@${botUserId}>`)) return;

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
    let text = (event.text || '').trim();
    // Note any file attachments so the PM session has context for screenshots/uploads
    if (Array.isArray(event.files) && event.files.length > 0) {
      const fileList = event.files
        .map(f => `- ${f.name || f.title || f.id}${f.permalink ? ` (${f.permalink})` : ''}`)
        .join('\n');
      text = text
        ? `${text}\n\n[${event.files.length} file attachment(s)]\n${fileList}`
        : `[${event.files.length} file attachment(s)]\n${fileList}`;
    }
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
  //
  // [Phase 1 — context-consolidation] Reads old task.slackChannel/slackThreadTs
  // directly. These fields survive task completion because they live on the
  // task object, not in sessionContext (which gets cleared on complete).
  //
  // Phase 2 will read from task._completionContext — a snapshot that
  // completeTask/failTask will capture from sessionContext.slackThread BEFORE
  // clearing it. This is the HIGH-RISK change flagged in the plan ("Slack
  // reply-back on task completion (CRITICAL)") — snapshot must happen before
  // clearSessionContext or replies will silently drop.
  //
  // See: ~/dev/agents/hive/context-consolidation-plan.md (Step 2: completeTask/failTask)
  if (taskQueue) {
    // Add :hourglass_flowing_sand: when task is dispatched to a session
    taskQueue.on('task:dispatched', async (task) => {
      if (!task.slackChannel || !task.slackThreadTs) return;
      try {
        await app.client.reactions.add({
          channel: task.slackChannel, name: 'hourglass_flowing_sand', timestamp: task.slackThreadTs,
        });
      } catch (err) {
        if (!err.data || err.data.error !== 'already_reacted') {
          console.error('Slack dispatch reaction error:', err.message);
        }
      }
    });

    taskQueue.on('task:completed', async (task) => {
      if (!task.slackChannel || !task.slackThreadTs) return;
      try {
        // Remove hourglass, add checkmark
        await app.client.reactions.remove({
          channel: task.slackChannel, name: 'hourglass_flowing_sand', timestamp: task.slackThreadTs,
        }).catch(() => {});
        await app.client.reactions.add({
          channel: task.slackChannel, name: 'white_check_mark', timestamp: task.slackThreadTs,
        }).catch(() => {});
        // Post rich completion message with context
        const duration = task.dispatchedAt
          ? Math.round((task.completedAt - task.dispatchedAt) / 60000)
          : 0;
        const parts = [`:white_check_mark: *Task completed* (${duration}m)`];
        // Add JIRA/PR context from actionContext, task fields, or sessionContext
        const ctx = task.actionContext;
        const sCtx = task.assignedTo != null && taskQueue ? taskQueue.getSessionContext(task.assignedTo) : {};
        const pr = (ctx && ctx.type === 'github-pr' && ctx.repo && ctx.prNumber)
          ? `https://github.com/${ctx.repo}/pull/${ctx.prNumber}`
          : sCtx.pr || null;
        const jira = task.jira || sCtx.jira || null;
        if (pr) parts.push(`PR: ${pr}`);
        if (jira) parts.push(`JIRA: ${jira}`);
        const resultSnippet = task.result
          ? task.result.substring(0, 300)
          : '';
        if (resultSnippet) parts.push(resultSnippet);
        await app.client.chat.postMessage({
          channel: task.slackChannel,
          thread_ts: task.slackThreadTs,
          text: parts.join('\n'),
        });
      } catch (err) {
        console.error('Slack reply-back error:', err.message);
      }
    });

    taskQueue.on('task:failed', async (task) => {
      if (!task.slackChannel || !task.slackThreadTs) return;
      try {
        await app.client.reactions.remove({
          channel: task.slackChannel, name: 'hourglass_flowing_sand', timestamp: task.slackThreadTs,
        }).catch(() => {});
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
      lastEventAt = Date.now(); // reset zombie-detector baseline on reconnect
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

  // Cleanly restart the bot and reset the zombie-detector baseline.
  async function restartBot(reason) {
    console.warn(`[slack] Restarting bot (reason: ${reason})`);
    try {
      await app.stop();
      await app.start();
      lastEventAt = Date.now();
      console.log(`[slack] Bot restarted (reason: ${reason})`);
    } catch (restartErr) {
      console.error(`[slack] Restart failed: ${restartErr.message}`);
    }
  }

  // Health check: verify the connection is alive AND actually delivering events.
  //
  // Two checks run every HEALTH_INTERVAL:
  //   1. auth.test() — catches Web API outages
  //   2. Zombie Socket Mode detection — if we haven't received any event for
  //      ZOMBIE_THRESHOLD_MS, probe the channels that slack-channel-monitor
  //      PMs are watching via conversations.history. If a real (non-subtype)
  //      message exists in any of them that's newer than lastEventAt, Socket
  //      Mode is zombied (connection claims to be up but no events flowing)
  //      → force-restart the bot.
  const HEALTH_INTERVAL = 5 * 60 * 1000;      // 5 min
  const ZOMBIE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min of silence before probing
  setInterval(async () => {
    // Step 1: Web API liveness
    try {
      await app.client.auth.test();
    } catch (err) {
      return restartBot(`auth.test failed: ${err.message}`);
    }

    // Step 2: Zombie Socket Mode detection
    const sinceLastEvent = Date.now() - lastEventAt;
    if (sinceLastEvent < ZOMBIE_THRESHOLD_MS) return;
    if (!pmManager) return;

    // Collect channels to probe: channel-monitor PMs + channels with active Slack tasks
    const probeChannels = new Set();
    const monitorPms = pmManager.getAll().filter(pm =>
      pm.enabled &&
      pm.source &&
      pm.source.type === 'slack-channel-monitor' &&
      Array.isArray(pm.source.channels)
    );
    for (const pm of monitorPms) pm.source.channels.forEach(ch => probeChannels.add(ch));

    // Add channels from active Slack-sourced tasks (dispatched or queued)
    if (taskQueue) {
      for (const t of taskQueue.tasks.values()) {
        if (t.status !== 'dispatched' && t.status !== 'queued') continue;
        if (t.slackChannel) probeChannels.add(t.slackChannel);
        // Also check sessionContext for slack threads
        const ctx = taskQueue.sessionContext.get(t.assignedTo);
        if (ctx && ctx.slackThread) {
          const ch = ctx.slackThread.split(':')[0];
          if (ch) probeChannels.add(ch);
        }
      }
    }

    if (probeChannels.size === 0) return;

    // Use per-channel tracking: probe each channel for messages we should
    // have received. This catches partial zombies where some channels flow
    // but others silently drop.
    const probeOldestSec = Math.floor((Date.now() - ZOMBIE_THRESHOLD_MS) / 1000);
    for (const channel of probeChannels) {
      try {
        const resp = await app.client.conversations.history({
          channel,
          limit: 5,
          oldest: String(probeOldestSec),
        });
        // Look for a real (non-subtype) message in this channel that we
        // should have received but didn't (not in our per-channel tracker).
        const missed = (resp.messages || []).find(m => {
          if (m.subtype) return false;
          const msgTs = parseFloat(m.ts) * 1000;
          // Check if this message arrived after our per-channel last-seen
          const chLastSeen = lastEventByChannel.get(channel) || 0;
          return msgTs > chLastSeen + 60000; // 1 min grace for clock skew
        });
        if (missed) {
          const missedIso = new Date(parseFloat(missed.ts) * 1000).toISOString();
          const chLastIso = lastEventByChannel.has(channel) ? new Date(lastEventByChannel.get(channel)).toISOString() : 'never';
          console.warn(`[slack] Partial zombie detected: message in ${channel} at ${missedIso} but last event from channel at ${chLastIso}`);
          return restartBot(`partial zombie — missed message in ${channel}`);
        }
      } catch (err) {
        // not_in_channel is expected for channels the bot can't read
        if (err.data && err.data.error === 'not_in_channel') continue;
        console.warn(`[slack] Zombie probe error for ${channel}: ${err.message}`);
      }
    }

  }, HEALTH_INTERVAL);

  // ── Thread polling fallback ──────────────────────────
  // Socket Mode silently drops thread reply events. Every THREAD_POLL_INTERVAL,
  // check conversations.replies for active task threads and relay any messages
  // the bot missed. This replaces the old Step 3 zombie detection which could
  // only detect and restart — this detects and relays directly.
  const THREAD_POLL_INTERVAL = 150_000; // 2.5 min
  setInterval(async () => {
    if (!taskQueue) return;
    let relayed = 0;
    for (const t of taskQueue.tasks.values()) {
      if (t.status !== 'dispatched' || !t.slackChannel || !t.slackThreadTs || !t.assignedTo) continue;
      const threadKey = `${t.slackChannel}:${t.slackThreadTs}`;
      // Use persisted high-water mark (survives restarts), then in-memory, then thread parent
      const oldest = t._lastSeenSlackTs || lastSeenByThread.get(threadKey) || t.slackThreadTs;
      try {
        const resp = await app.client.conversations.replies({
          channel: t.slackChannel,
          ts: t.slackThreadTs,
          oldest,
          limit: 20,
        });
        const messages = (resp.messages || []).filter(m => {
          if (m.subtype) return false;
          if (botUserId && m.user === botUserId) return false;
          // Only messages strictly newer than our high-water mark
          return parseFloat(m.ts) > parseFloat(oldest);
        });
        if (messages.length === 0) continue;

        // Update high-water mark to newest message (in-memory + persisted on task)
        const newestTs = messages[messages.length - 1].ts;
        lastSeenByThread.set(threadKey, newestTs);
        t._lastSeenSlackTs = newestTs;
        taskQueue._saveState();

        // Relay missed messages to the session
        const found = await fleet.findSession(config, router, t.assignedTo);
        if (!found) continue;
        const node = router.getNode(found.nodeId);
        if (!node) continue;

        const parts = [];
        for (const m of messages) {
          const name = await userName(m.user);
          parts.push(`${name}: ${m.text || '[attachment]'}`);
        }
        const text = `Slack thread update (${messages.length} missed message${messages.length > 1 ? 's' : ''}):\n${parts.join('\n')}\n\nReply back on the thread when done.`;
        const result = await relay.tell(config, node, found.name, text, { vimMode: taskQueue.vimMode });
        if (result.success) {
          relayed += messages.length;
          console.log(`[slack-poll] Relayed ${messages.length} missed message(s) to S:${t.assignedTo} for thread ${threadKey}`);
        }
      } catch (err) {
        if (err.data && (err.data.error === 'not_in_channel' || err.data.error === 'thread_not_found')) continue;
        console.warn(`[slack-poll] Thread poll error for task ${t.id}: ${err.message}`);
      }
    }
    if (relayed > 0) console.log(`[slack-poll] Cycle complete: ${relayed} message(s) relayed`);
  }, THREAD_POLL_INTERVAL);

  // Start the bot and resolve bot user ID for @mention filtering
  let botUserId = null;
  app.start().then(async () => {
    console.log('Slack bot started (Socket Mode)');
    try {
      const authResult = await app.client.auth.test();
      botUserId = authResult.user_id;
      console.log(`[slack] Bot user ID: ${botUserId}`);
    } catch (err) {
      console.error(`[slack] Could not resolve bot user ID: ${err.message}`);
    }
  }).catch(err => {
    console.error('Slack bot failed to start:', err.message);
  });

  return app;
}

module.exports = { createSlackBot };
