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
else
  echo "Skipping session startup (--no-sessions)"
fi

# Kill existing hive-server if --restart (--force implies --restart)
if [ "$RESTART" = true ] && tmux has-session -t hive-server 2>/dev/null; then
  echo "Stopping existing hive server..."
  tmux kill-session -t hive-server
fi

# Run hive server in a dedicated tmux session
if tmux has-session -t hive-server 2>/dev/null; then
  echo "hive server already running (tmux session: hive-server)"
else
  tmux new-session -d -s hive-server -c "$HIVE_DIR" "node src/index.js 2>&1 | tee -a $LOG_FILE"
  echo "hive server started (tmux session: hive-server, log $LOG_FILE)"
fi
