# CLAUDE.md

## What is hive?

hive is a real-time dashboard and control plane for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions running in tmux. It provides a mobile-first web UI, Slack bot, and Telegram bot for monitoring, messaging, and steering your AI coding fleet.

## Quick Start

```bash
npm install
npm start        # production
npm run dev      # development (auto-restart on changes)
```

Configuration lives in `hive.config.js` — adjust session patterns, repo paths, idle detection, and dashboard links for your setup.

### Starting the Fleet

```bash
bash start-hive.sh              # idempotent: creates missing sessions + starts server
bash start-hive.sh --restart    # recreates server, skips healthy sessions
bash start-hive.sh --force      # kills everything and recreates from scratch
bash start-hive.sh --no-sessions # server only, no tmux sessions
```

After a clean reboot, just run `bash start-hive.sh`.

## Architecture

```
src/
├── index.js                  # Server entry point — wires up all modules
├── cli.js                    # CLI (hive start/stop/status/server)
├── worker.js                 # Remote node worker (WebSocket RPC)
├── core/
│   ├── fleet.js              # Fleet status (sessions, git, PR/CI, idle state)
│   ├── taskqueue.js          # Task lifecycle (create → queue → dispatch → complete)
│   ├── watcher.js            # Polls fleet for state changes, emits events
│   ├── relay.js              # Send messages to Claude, poll for response
│   ├── pm.js                 # Project Manager: auto-creates tasks from sources
│   ├── pm-sources.js         # PM integrations (Jira, GitHub, Linear, Slack)
│   ├── session-manager.js    # Creates tmux sessions with correct layout
│   ├── node-router.js        # Maps sessions to execution nodes (local/remote)
│   ├── tmux.js               # tmux commands, pane capture, state detection
│   ├── auth.js               # GitHub OAuth + JWT for dashboard
│   ├── git.js                # Git operations (log, diff, branch info)
│   └── pr-status.js          # PR/CI status cache (GitHub + Jenkins)
├── integrations/
│   ├── web/                  # Express dashboard + WebSocket server
│   ├── slack/                # Slack bot (Socket Mode)
│   ├── telegram/             # Telegram bot
│   └── voice/                # Voice agent (meetings, transcription, TTS)
└── mcp-server/
    └── index.mjs             # MCP tools exposed to Claude sessions
```

### Key Concepts

- **Fleet** — all tmux sessions matching `sessions.pattern` or `sessions.repoBase` in config
- **Watcher** — polls every 10s, detects idle/working/off, approvals, CI changes
- **Relay** — sends a message to Claude via tmux paste, polls for idle (5 consecutive checks), streams response
- **Task Queue** — tasks are created (manually or by PMs), queued, then auto-dispatched to idle sessions by designation
- **Project Manager** — pulls work items from Jira/GitHub/Linear/Slack, auto-creates tasks, tracks completion conditions
- **Knowledge Base** — fleet-wide shared learnings (`.hive-knowledge.json`), deduped, queryable by domain/files
- **Designations** — categories that map sessions to task types (e.g. session 1 handles "Reviews")

### MCP Tools

Sessions have access to these tools via the hive MCP server:

| Tool | Purpose |
|------|---------|
| `hive_get_task` | Get current task assignment |
| `hive_complete_task` | Mark task complete with summary |
| `hive_post_update` | Post status to activity feed |
| `hive_get_sessions` | List all fleet sessions |
| `hive_report_learnings` | Report learnings to PM |
| `hive_share_knowledge` | Share insight to knowledge base |
| `hive_get_knowledge` | Query knowledge base |
| `hive_get_context` | Get shared context (plan, PR, JIRA) |
| `hive_set_context` | Update shared context |
| `hive_set_working_dir` | Override repo directory (for worktrees) |
| `hive_reply_thread` | Reply to the Slack thread for current task |

### State Persistence

All state lives in `.hive-state.json`:
- Tasks (queued, active, completed), active task → session mapping
- PM configs, seen keys, created tasks, learnings
- Activity feed (ring buffer, max 200)
- Session context (plan, PR, JIRA per session)
- Pending approvals, user list

Saved to disk on every task/PM change.

## Configuration

### hive.config.js

Loaded from `.hive-setup.json` (onboarding wizard) or hardcoded defaults:

- `sessions.repoBase` — path prefix for fleet discovery (from `HIVE_REPO_DIR` env)
- `sessions.pattern` — regex fallback for session name matching
- `sessions.repoDir(n)` — maps session number to repo directory
- `sessions.claudePane` — which pane runs Claude (default: 1)
- `sessions.roles` — display names per session slot
- `relay.timeout` — max wait for Claude response (default: 5min)
- `watcher.interval` — fleet poll interval (default: 10s)
- `github.repo` — owner/repo for PR status
- `jenkins.baseUrl` / `jenkins.jobPath` — CI status URLs

### .env Variables

```
HIVE_REPO_DIR=~/path/to/repos/   # Session repo base directory
WEB_PORT=3001                     # Dashboard port
WEB_TOKEN=<token>                 # Dashboard auth token
TELEGRAM_BOT_TOKEN=<token>        # Telegram bot (optional)
TELEGRAM_CHAT_ID=<id>             # Telegram chat (optional)
GITHUB_TOKEN=<token>              # GitHub API access
SLACK_BOT_TOKEN=<token>           # Slack bot (optional)
SLACK_APP_TOKEN=<token>           # Slack Socket Mode (optional)
JENKINS_URL=<url>                 # Jenkins base URL
JENKINS_USER=<user>               # Jenkins auth
JENKINS_API_TOKEN=<token>         # Jenkins auth
DEEPGRAM_API_KEY=<key>            # Voice TTS (optional)
```

## Sandboxed User (hivebot)

- hive runs as `hivebot`, a sandboxed macOS user with no sudo, no prod SSH keys, no AWS creds
- `execSync` and `exec` use `/bin/sh` by default, which does NOT have gem/tmuxinator in PATH. Always use `shell: '/bin/zsh -l'` when calling `tmuxinator` or other user-installed tools (e.g. ruby gems)
- When testing commands as hivebot: `sudo -u hivebot -i` (login shell) not `sudo -u hivebot` (inherits your cwd which hivebot may not be able to access)
- Paths resolve via `os.homedir()` → `/Users/hivebot` when running as hivebot

## Cloud Deployment

Infrastructure in `cloud/terraform/` — EC2 + ALB + HTTPS, state in S3 (`viv-infrastructure-backend/viv/hive`).

- `cloud/scripts/init.sh` — one-time setup (Node, gh, Claude Code, tmuxinator)
- `cloud/scripts/boot.sh` — every boot: fetch secrets from AWS Secrets Manager, start hive

## Running Tests

```bash
npm test             # run all tests (vitest)
npm run test:watch   # watch mode
npm run test:coverage # with coverage
```

Tests live in `test/core/` (unit), `test/e2e/` (integration), and `test/integrations/web/` (web). The test framework is [vitest](https://vitest.dev/).

## Contributing

1. Fork the repo
2. Create a feature branch from `main`
3. Make your changes
4. Open a PR to `nukulb/hive` (upstream)

Keep PRs focused — one feature or fix per PR.
