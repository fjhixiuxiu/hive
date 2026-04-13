#!/bin/bash
# Start tmux sessions and hive server as the current user.
# Usage: start-hive.sh [--no-sessions] [--restart]
# Designed for the sandboxed user — run via:
#   sudo -u hivebot /path/to/start-hive.sh

set -e

# Resolve HOME from the running user (sudo without -i doesn't set it)
export HOME=$(eval echo "~$(whoami)")

HIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$HOME/hive.log"

# Source the user's shell profile for PATH (tmuxinator, claude, node)
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

cd "$HIVE_DIR"

# Parse flags
NO_SESSIONS=false
RESTART=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --no-sessions) NO_SESSIONS=true ;;
    --restart)     RESTART=true ;;
    --force)       FORCE=true; RESTART=true ;;
  esac
done

if [ "$NO_SESSIONS" = false ]; then
  SESSION_ARGS=""
  [ "$FORCE" = true ] && SESSION_ARGS="--force"
  node start-sessions.js $SESSION_ARGS

  # Save tmux state so tmux-resurrect/continuum restores correct sessions on next reboot.
  # Without this, continuum may restore stale sessions with wrong paths.
  RESURRECT_SAVE="$HOME/.tmux/plugins/tmux-resurrect/scripts/save.sh"
  if [ -x "$RESURRECT_SAVE" ] && tmux list-sessions >/dev/null 2>&1; then
    "$RESURRECT_SAVE" >/dev/null 2>&1 || true
    echo "Saved tmux-resurrect state"
  fi
else
  echo "Skipping session startup (--no-sessions)"
fi

# Kill existing hive-server if --restart (--force implies --restart)
if [ "$RESTART" = true ]; then
  echo "Stopping existing hive server..."
  # Kill tmux session
  tmux kill-session -t hive-server 2>/dev/null || true
  # Kill any orphaned hive node processes (zombies holding port/Slack connections)
  # Match node processes running src/index.js from the hive directory, exclude MCP servers
  for pid in $(lsof -ti :3000 2>/dev/null); do
    kill "$pid" 2>/dev/null && echo "  killed process $pid (held port 3000)"
  done
  # Also kill any node --watch or direct node src/index.js in the hive dir
  pgrep -f "node.*${HIVE_DIR}/src/index" 2>/dev/null | while read pid; do
    kill "$pid" 2>/dev/null && echo "  killed orphan hive process $pid"
  done
  sleep 1
fi

# Run hive server in a dedicated tmux session
if tmux has-session -t hive-server 2>/dev/null; then
  echo "hive server already running (tmux session: hive-server)"
else
  tmux new-session -d -s hive-server -c "$HIVE_DIR" "node src/index.js 2>&1 | tee -a $LOG_FILE"
  echo "hive server started (tmux session: hive-server, log $LOG_FILE)"
fi
