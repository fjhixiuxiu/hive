# Setup Guide

This guide walks you through setting up hive from scratch: tmux sessions, Claude Code, background daemons, and the hive dashboard.

## Prerequisites

- **macOS or Linux** (macOS instructions shown, adapt for Linux)
- **tmux** 3.2+ (`brew install tmux`)
- **tmuxinator** (`gem install tmuxinator`)
- **Node.js** 18+ (`brew install node`)
- **Claude Code** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **gh** CLI for PR/CI data (`brew install gh` and `gh auth login`)
- **jq** for JSON parsing (`brew install jq`)

## 1. Create your repo directories

hive manages N copies of the same repo, one per tmux session. Each session works independently on a different branch.

```bash
# Example: 4 sessions, 4 repo copies
mkdir -p ~/fleet
for i in 1 2 3 4; do
  git clone git@github.com:your-org/your-repo.git ~/fleet/repo${i}
done
```

Scale to as many as you want. The original hive setup runs 16 sessions.

## 2. Configure tmux

### tmux.conf

Add these to your `~/.tmux.conf` (or copy the whole file):

```bash
# Required: use login shell so PATH, nvm, etc. load correctly
# The -u CLAUDECODE prevents conflicts with Claude Code's MCP server
set -g default-command "env -u CLAUDECODE bash --login"

# 256 color support (needed for ANSI colors in terminal capture)
set -g default-terminal "tmux-256color"
set -ag terminal-overrides ",xterm-256color:RGB"

# Large scrollback (hive captures up to 500 lines)
set -g history-limit 50000

# 1-based pane indexing (hive expects pane 1 = Claude)
set -g base-index 1
setw -g pane-base-index 1

# Mouse support
set -g mouse on

# Navigate panes with Alt+Arrow (no prefix needed)
bind -n M-Left  select-pane -L
bind -n M-Right select-pane -R
bind -n M-Up    select-pane -U
bind -n M-Down  select-pane -D
```

After editing, reload: `tmux source-file ~/.tmux.conf`

> **iTerm2 users**: Set Option key to "Esc+" in Preferences → Profiles → Keys for Alt+Arrow navigation to work.

### tmuxinator session template

Create `~/.config/tmuxinator/worker.yml`:

```yaml
# Usage: tmuxinator start worker N=1
# Creates session "1" rooted at ~/fleet/repo1
name: <%= @settings["N"] %>
root: ~/fleet/repo<%= @settings["N"] %>

windows:
  - work:
      layout: main-vertical
      panes:
        - claude --resume   # Pane 1 (left, 50%) — Claude Code
        -                    # Pane 2 (top-right) — your dev server
        -                    # Pane 3 (bottom-right) — tests, git, etc.
```

This creates a 3-pane layout:

```
┌──────────────────────┬───────────────┐
│                      │  Pane 2       │
│  Pane 1              │  (server)     │
│  Claude Code         ├───────────────┤
│                      │  Pane 3       │
│                      │  (shell)      │
└──────────────────────┴───────────────┘
```

Pane 1 runs `claude --resume` which starts Claude Code (or resumes the last conversation). This is the pane hive reads from and sends input to.

## 3. Start tmux sessions

### Manual start

```bash
# Start 4 sessions
for i in 1 2 3 4; do
  tmuxinator start worker N=$i --no-attach
done

# Attach to session 1
tmux attach -t 1
```

### Start script (recommended)

Create a start script for convenience:

```bash
#!/usr/bin/env bash
# start-fleet.sh — start or stop all sessions

set -euo pipefail

if [[ "${1:-}" == "stop" ]]; then
  for s in $(tmux list-sessions -F '#S' 2>/dev/null | grep -E '^[0-9]'); do
    tmux kill-session -t "=$s"
  done
  echo "All sessions stopped"
  exit 0
fi

SESSIONS=${@:-$(seq 1 4)}  # Default: sessions 1-4
for n in $SESSIONS; do
  if tmux list-sessions -F '#S' 2>/dev/null | grep -qE "^${n}(-|$)"; then
    echo "  $n — already running"
  else
    tmuxinator start worker "N=$n" --no-attach 2>/dev/null
    echo "  $n ✓"
  fi
done

echo "Attach: tmux attach -t 1"
```

```bash
chmod +x start-fleet.sh

# Start all
./start-fleet.sh

# Start specific sessions
./start-fleet.sh 1 3

# Stop all
./start-fleet.sh stop
```

## 4. Background daemons (optional but recommended)

hive can show PR numbers, CI status, and review state on each session card. This data comes from cache files written by background scripts.

### Cache warmer (PR + CI status)

This script loops through sessions, fetches PR/CI data via `gh` and your CI API, and writes cache files to `/tmp/tmux-status-{N}`.

Create `cache-warmer.sh`:

```bash
#!/usr/bin/env bash
# Polls PR + CI status for each session and writes cache files
# Cache format: one value per line
#   1: PR_NUM  2: PR_ADDS  3: PR_DELS  4: PR_FILES
#   5: CI_RESULT  6: CI_BUILD  7: REVIEW_STATE

INTERVAL=${1:-60}
REPO_DIR_PREFIX="$HOME/fleet/repo"

warm_session() {
    local num="$1"
    local repo_dir="${REPO_DIR_PREFIX}${num}"
    local cache_file="/tmp/tmux-status-${num}"

    [[ ! -d "$repo_dir/.git" ]] && return

    local pr_json
    pr_json=$(cd "$repo_dir" && gh pr view --json number,additions,deletions,changedFiles,reviewDecision 2>/dev/null || echo "")

    if [[ -n "$pr_json" ]]; then
        local pr_num pr_adds pr_dels pr_files review_state
        pr_num=$(echo "$pr_json" | jq -r '.number // ""')
        pr_adds=$(echo "$pr_json" | jq -r '.additions // 0')
        pr_dels=$(echo "$pr_json" | jq -r '.deletions // 0')
        pr_files=$(echo "$pr_json" | jq -r '.changedFiles // 0')
        review_state=$(echo "$pr_json" | jq -r '.reviewDecision // ""')

        if [[ -n "$pr_num" ]]; then
            # Customize this section for your CI system
            # Example: GitHub Actions
            local ci_result ci_build
            ci_result=$(cd "$repo_dir" && gh pr checks --json bucket,name --jq '
              if any(.[]; .bucket == "fail") then "FAILURE"
              elif all(.[]; .bucket == "pass") then "SUCCESS"
              else "RUNNING" end' 2>/dev/null || echo "")
            ci_build=""

            cat > "$cache_file" <<CACHE
${pr_num}
${pr_adds}
${pr_dels}
${pr_files}
${ci_result}
${ci_build}
${review_state}
CACHE
            return
        fi
    fi

    echo "" > "$cache_file"
}

while true; do
    for num in $(tmux list-sessions -F '#S' 2>/dev/null | grep -oE '^[0-9]+'); do
        warm_session "$num" &
    done
    wait
    sleep "$INTERVAL"
done
```

### Idle watcher (state detection)

This script detects when Claude transitions from working to idle and writes state files to `/tmp/tmux-claude-states/`.

Create `idle-watcher.sh`:

```bash
#!/usr/bin/env bash
# Detects Claude idle/working/off state for each session
# Writes state to /tmp/tmux-claude-states/{N}

INTERVAL=${1:-10}
STATE_DIR="/tmp/tmux-claude-states"
mkdir -p "$STATE_DIR"

detect_state() {
    local session="$1"
    local last_line
    last_line=$(tmux capture-pane -t "${session}:.1" -p -S -3 2>/dev/null | grep -v '^$' | tail -1)
    local clean
    clean=$(echo "$last_line" | LC_ALL=C tr -cd '[:print:]')

    if echo "$clean" | grep -qE '(bypass permissions|shift\+tab|ctrl-g to edit)'; then
        echo "idle"
    elif echo "$clean" | grep -qE '(conversation\.|^$)'; then
        echo "off"
    else
        echo "working"
    fi
}

while true; do
    for s in $(tmux list-sessions -F '#S' 2>/dev/null | sort -V); do
        num="${s%%-*}"
        [[ ! "$num" =~ ^[0-9]+$ ]] && continue
        detect_state "$s" > "$STATE_DIR/$num"
    done
    sleep "$INTERVAL"
done
```

### Start the daemons

```bash
# Run in background
./cache-warmer.sh 60 &
./idle-watcher.sh 10 &
```

Add these to your start script if you want them to launch automatically.

> **Note**: The daemons are optional. Without them, hive still works — it just won't show PR/CI badges or pre-cached state on the fleet grid. The terminal view and ask/tell always work regardless.

## 5. Install and configure hive

```bash
git clone https://github.com/nukulb/hive.git
cd hive
npm install

cp .env.example .env
```

Edit `.env`:

```bash
# Required — pick any secret string
WEB_TOKEN=my-secret-token

# Optional — change the port
WEB_PORT=3000

# Optional — Telegram bot (see Telegram section below)
# TELEGRAM_BOT_TOKEN=...
# TELEGRAM_CHAT_ID=...
```

Edit `hive.config.js` to match your setup:

```javascript
const os = require('os');
const path = require('path');

module.exports = {
  sessions: {
    // Match your tmux session names (numbers)
    pattern: /^\d+/,

    // Must match where you cloned your repos
    repoDir: (n) => path.join(os.homedir(), `fleet/repo${n}`),

    // Pane index where Claude Code runs (1-based)
    claudePane: 1,

    // Optional: fixed names for specific sessions
    roles: {
      // 1: 'Reviews',
      // 2: 'Urgent',
    },
  },

  // These patterns detect Claude's state from terminal output.
  // The defaults work with Claude Code's standard prompts.
  idlePatterns: [
    /bypass permissions/,
    /shift\+tab/,
    /ctrl-g to edit/,
  ],

  offPatterns: [
    /conversation\./,
  ],

  cache: {
    statusPrefix: '/tmp/tmux-status-',
    stateDir: '/tmp/tmux-claude-states',
  },

  relay: {
    pollInterval: 2000,
    cooldown: 5000,
    timeout: 5 * 60 * 1000,
  },

  watcher: {
    interval: 10000,
  },

  // URL templates for clickable PR/CI badges
  // Set to null to disable
  links: {
    pr: 'https://github.com/your-org/your-repo/pull/${prNum}',
    ci: null,  // Set to your CI URL template if you have one
  },
};
```

## 6. Start hive

```bash
# Make sure tmux sessions are running first
./start-fleet.sh

# Start hive
cd hive
npm start
# → Watcher started (polling every 10s)
# → Web dashboard: http://localhost:3000
```

Open `http://localhost:3000` on your phone (must be on the same network), enter your token, and you'll see your fleet.

### Access from your phone

Your Mac and phone need to be on the same network. Find your Mac's IP:

```bash
ipconfig getifaddr en0
# e.g., 192.168.1.42
```

Then open `http://192.168.1.42:3000` on your phone.

**To install as an app**: In Safari, tap Share → Add to Home Screen. It opens as a standalone PWA.

## 7. Telegram bot (optional)

If you want Telegram access in addition to the web dashboard:

1. Message [@BotFather](https://t.me/BotFather) on Telegram, create a bot, get the token
2. Message [@userinfobot](https://t.me/userinfobot) to get your chat ID
3. Add both to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   TELEGRAM_CHAT_ID=your-numeric-id
   ```
4. Restart hive

## Scaling up

The example uses 4 sessions. To scale:

```bash
# Clone more repos
for i in $(seq 5 16); do
  git clone git@github.com:your-org/your-repo.git ~/fleet/repo${i}
done

# Start more sessions
for i in $(seq 5 16); do
  tmuxinator start worker N=$i --no-attach
done
```

hive auto-discovers all numbered tmux sessions — no config change needed.

## Troubleshooting

### "No session matching X"
The tmux session isn't running. Check with `tmux list-sessions`.

### Terminal view shows nothing
Make sure `claudePane` in config matches the pane where Claude Code runs. Check with:
```bash
tmux list-panes -t 1  # lists panes in session 1
```

### Ask/Tell messages don't reach Claude
Claude Code has vim-like modes. hive sends `Escape` then `i` to ensure INSERT mode before typing. If Claude is in a special state (e.g., permission prompt), you may need to send a key press (Enter, y, Escape) first.

### Cache files not updating
Make sure the cache-warmer and idle-watcher scripts are running:
```bash
ps aux | grep cache-warmer
ps aux | grep idle-watcher
```

### Port already in use
```bash
lsof -ti :3000 | xargs kill
npm start
```
