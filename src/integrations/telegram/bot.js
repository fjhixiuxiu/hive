const TelegramBot = require('node-telegram-bot-api');
const commands = require('./commands');

/**
 * Create and start the Telegram bot.
 */
function createBot(config, watcher) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
    process.exit(1);
  }

  const bot = new TelegramBot(token, { polling: true });
  const allowedChatId = String(chatId);

  // Auth middleware — only respond to the configured user
  function auth(msg) {
    return String(msg.chat.id) === allowedChatId;
  }

  // Helper to send a message
  function send(text, opts = {}) {
    return bot.sendMessage(allowedChatId, text, { parse_mode: 'Markdown', ...opts });
  }

  // ── Command routing ──────────────────────────────────

  bot.onText(/\/start/, (msg) => {
    if (!auth(msg)) return;
    send([
      '*hive* — AI Fleet Command',
      '',
      '`/status` — all sessions at a glance',
      '`/idle` — list idle sessions',
      '`/working` — list working sessions',
      '`/session <N>` — detailed session status',
      '`/peek <N>` — last output from Claude',
      '`/ask <N> <msg>` — send message, get response',
      '`/tell <N> <msg>` — fire and forget',
      '`/restart <N>` — restart Claude',
      '`/kill <N>` — kill session',
      '`/prs` — all open PRs',
    ].join('\n'));
  });

  bot.onText(/\/status/, (msg) => {
    if (!auth(msg)) return;
    commands.status(config, send);
  });

  bot.onText(/\/idle/, (msg) => {
    if (!auth(msg)) return;
    commands.idle(config, send);
  });

  bot.onText(/\/working/, (msg) => {
    if (!auth(msg)) return;
    commands.working(config, send);
  });

  bot.onText(/\/session\s+(\S+)/, (msg, match) => {
    if (!auth(msg)) return;
    commands.session(config, send, match[1]);
  });

  bot.onText(/\/peek\s+(\S+)/, (msg, match) => {
    if (!auth(msg)) return;
    commands.peek(config, send, match[1]);
  });

  bot.onText(/\/ask\s+(\S+)\s+(.+)/, (msg, match) => {
    if (!auth(msg)) return;
    commands.ask(config, send, match[1], match[2]);
  });

  bot.onText(/\/tell\s+(\S+)\s+(.+)/, (msg, match) => {
    if (!auth(msg)) return;
    commands.tell(config, send, match[1], match[2]);
  });

  bot.onText(/\/restart\s+(\S+)/, (msg, match) => {
    if (!auth(msg)) return;
    commands.restart(config, send, match[1]);
  });

  bot.onText(/\/kill\s+(\S+)/, (msg, match) => {
    if (!auth(msg)) return;
    commands.kill(config, send, match[1]);
  });

  bot.onText(/\/prs/, (msg) => {
    if (!auth(msg)) return;
    commands.prs(config, send);
  });

  // ── Watcher notifications ────────────────────────────

  watcher.on('session:idle', ({ name, num }) => {
    send(`✅ *Session ${num}* finished\\.\n_${esc(name)}_`, { parse_mode: 'MarkdownV2' })
      .catch(() => send(`✅ Session ${num} finished. ${name}`));
  });

  watcher.on('ci:changed', ({ name, num, from, to, pr }) => {
    const icon = to === 'SUCCESS' ? '🟢' : to === 'FAILURE' ? '🔴' : '🟡';
    send(`${icon} CI changed for session ${num}: ${from} → *${to}*\nPR #${pr} — ${name}`);
  });

  // ── Error handling ───────────────────────────────────

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err.message);
  });

  console.log('Telegram bot started. Listening for commands...');
  return bot;
}

// Escape MarkdownV2 special chars
function esc(s) {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

module.exports = { createBot };
