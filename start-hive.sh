#!/bin/bash
# Start tmux sessions and hive server as the current user.
# Usage: start-hive.sh [--no-sessions]
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

if [ "$1" != "--no-sessions" ]; then
  node start-sessions.js
else
  echo "Skipping session startup (--no-sessions)"
fi

# Run hive server in a dedicated tmux session
if tmux has-session -t hive-server 2>/dev/null; then
  echo "hive server already running (tmux session: hive-server)"
else
  tmux new-session -d -s hive-server -c "$HIVE_DIR" "node src/index.js 2>&1 | tee -a $LOG_FILE"
  echo "hive server started (tmux session: hive-server, log $LOG_FILE)"
fi
