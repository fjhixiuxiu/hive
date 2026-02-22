# hive

Command your AI coding fleet from your phone.

hive is a real-time dashboard and control plane for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions running in tmux. See what every session is doing, send messages, trigger slash commands, and get notified when things finish — all from a mobile-first web UI or Telegram.

## Why

If you run multiple Claude Code sessions in parallel (code reviews, feature work, CI fixes, tests), you need a way to monitor and steer them without switching between 16 terminal tabs. hive gives you a single screen with live status for every session, plus the ability to interact with any of them instantly.

## Features

- **Fleet grid** — See all sessions at a glance with state (idle/working/off), branch, PR number, CI status, and review badges
- **Live terminal** — Tap a session to view its terminal output with full ANSI colors via xterm.js, refreshing every 2 seconds
- **Ask/Tell** — Send messages to any Claude session. Ask waits for a response; Tell is fire-and-forget
- **Key buttons** — Send Enter, Escape, arrow keys, y/n, or number keys to answer Claude's prompts
- **Slash commands** — Auto-discovered from your `~/.claude/commands/` directory, rendered as tap-to-send buttons
- **Quick send** — Message a session directly from the grid without opening the detail view
- **Notifications** — Toast popups and native browser notifications when sessions finish or CI status changes
- **Telegram bot** — Full fleet control via Telegram for when you're away from the dashboard
- **PWA** — Installable as a home screen app on iOS/Android
- **Configurable links** — PR and CI badge URLs are templates in config, not hardcoded

## How it works

```
┌─────────────────────────────────────────────────┐
│  Your phone / browser                           │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ Web dashboard │  │ Telegram bot             │  │
│  └──────┬───────┘  └──────────┬──────────────┘  │
└─────────┼──────────────────────┼────────────────┘
          │ WebSocket            │ Telegram API
          ▼                      ▼
┌─────────────────────────────────────────────────┐
│  hive server (Node.js)                          │
│  ┌──────────┐ ┌───────┐ ┌───────┐ ┌─────────┐  │
│  │ fleet.js │ │relay.js│ │tmux.js│ │watcher.js│ │
│  └────┬─────┘ └───┬───┘ └───┬───┘ └────┬────┘  │
└───────┼────────────┼─────────┼──────────┼───────┘
        │            │         │          │
        ▼            ▼         ▼          ▼
┌─────────────────────────────────────────────────┐
│  tmux sessions                                  │
│  ┌─────┐ ┌─────┐ ┌─────┐       ┌─────┐        │
│  │  1  │ │  2  │ │  3  │  ...  │ 16  │        │
│  │Claude│ │Claude│ │Claude│       │Claude│        │
│  └─────┘ └─────┘ └─────┘       └─────┘        │
└─────────────────────────────────────────────────┘
```

Each tmux session runs Claude Code in a pane. hive reads terminal content via `tmux capture-pane`, detects idle/working state from screen patterns, and sends input via `tmux send-keys`. No modifications to Claude Code itself.

## Requirements

- **Node.js** 18+
- **tmux** 3.2+ with numbered sessions
- **tmuxinator** for session templates
- **Claude Code** running in a pane within each tmux session
- **gh** CLI for PR/CI data (optional)
- Optional: Telegram bot token for the Telegram integration

> **New to this?** See the **[full setup guide](docs/setup-guide.md)** for step-by-step instructions covering tmux configuration, session templates, background daemons, and phone access.

## Quick start

```bash
git clone https://github.com/nukulb/hive.git
cd hive
npm install

# Configure
cp .env.example .env
# Edit .env — set WEB_TOKEN (required), optionally TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID

# Edit hive.config.js to match your tmux layout
# (session naming pattern, pane index, repo directories, etc.)

npm start
# → Web dashboard: http://localhost:3000
```

Open `http://localhost:3000` on your phone (same network), enter your token, and you're in.

## Configuration

### `.env`

```bash
# Required for web dashboard
WEB_PORT=3000
WEB_TOKEN=your-secret-token

# Optional — Telegram bot
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

### `hive.config.js`

```javascript
module.exports = {
  sessions: {
    // Regex to match your tmux session names
    pattern: /^\d+/,

    // Map session number → repo directory
    repoDir: (n) => `/home/you/projects/repo${n}`,

    // Which pane index (1-based) runs Claude Code
    claudePane: 1,

    // Optional fixed roles for display
    roles: { 1: 'Reviews', 2: 'Ideas', 3: 'Urgent', 4: 'Tests' },
  },

  // Patterns in terminal output that mean Claude is waiting for input
  idlePatterns: [
    /bypass permissions/,
    /shift\+tab/,
    /ctrl-g to edit/,
  ],

  // Patterns that mean Claude isn't running
  offPatterns: [
    /conversation\./,
  ],

  // PR/CI cache files (if you use external cache-warming scripts)
  cache: {
    statusPrefix: '/tmp/tmux-status-',
    stateDir: '/tmp/tmux-claude-states',
  },

  relay: {
    pollInterval: 2000,    // How often to check for response
    cooldown: 5000,        // Wait after idle before declaring done
    timeout: 5 * 60 * 1000, // Max wait time
  },

  watcher: {
    interval: 10000,       // How often to poll fleet status
  },

  // URL templates for PR and CI links (use ${prNum} and ${ciBuild})
  links: {
    pr: 'https://github.com/your-org/your-repo/pull/${prNum}',
    ci: 'https://ci.example.com/job/your-repo/job/PR-${prNum}/${ciBuild}/',
  },
};
```

## Slash commands

hive auto-discovers Claude Code slash commands from `~/.claude/commands/` and renders them as buttons in the session detail view. Any `.md` file with YAML frontmatter (`name`, `description`) becomes a tappable command.

If your project also has `.claude/commands/` in the repo directory, those are discovered too (project commands override global ones with the same name).

## tmux session layout

hive expects numbered tmux sessions where Claude Code runs in a specific pane. Example layout:

```
┌────────────────────┬──────────────┐
│                    │   server     │
│   Claude Code      │   (pane 2)   │
│   (pane 1)         ├──────────────┤
│                    │   client     │
│                    │   (pane 3)   │
└────────────────────┴──────────────┘
```

Set `sessions.claudePane` in config to match whichever pane runs Claude.

## Project structure

```
hive/
├── hive.config.js          # Your fleet configuration
├── src/
│   ├── index.js            # Entry point — starts watcher + integrations
│   ├── core/
│   │   ├── fleet.js        # Fleet status queries (sessions, PR, CI, state)
│   │   ├── relay.js        # Send messages to Claude (ask/tell)
│   │   ├── tmux.js         # tmux helpers (capture, send-keys, state detection)
│   │   └── watcher.js      # EventEmitter — polls fleet, emits state changes
│   └── integrations/
│       ├── telegram/       # Telegram bot integration
│       │   ├── bot.js
│       │   └── commands.js
│       └── web/            # Web dashboard integration
│           ├── server.js   # Express + WebSocket server
│           └── public/
│               ├── index.html   # Single-file frontend (CSS + JS)
│               ├── manifest.json
│               └── sw.js
└── .env                    # Secrets (not committed)
```

## Adding integrations

hive's core layer (`fleet`, `relay`, `tmux`, `watcher`) is integration-agnostic. To add a new integration (Slack, Discord, CLI, etc.):

1. Create `src/integrations/yourservice/`
2. Export a setup function that takes `(config, watcher)`
3. Use `fleet.getFleetStatus(config)` for status, `relay.ask()`/`relay.tell()` for messaging
4. Listen to watcher events: `session:idle`, `session:working`, `ci:changed`
5. Wire it into `src/index.js`

## License

[MIT](LICENSE)
