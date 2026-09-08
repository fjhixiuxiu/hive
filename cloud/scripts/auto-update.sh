#!/bin/bash
# Hive auto-update script — pulls latest code, ensures node_modules matches
# package-lock.json, and restarts the hive server if new commits landed.
#
# Runs via systemd timer every 5 minutes. All git/npm commands run as
# ubuntu to avoid root-owned files in the repo.
#
# Uses HIVE_REPO_TOKEN for git auth, bypassing the system credential
# store (which gets overwritten by GITHUB_TOKEN for mavencare API calls).

set -euo pipefail

HIVE_DIR="/home/ubuntu/hive"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

# ── Load HIVE_REPO_TOKEN from .env ────────────────────────────────────
# Read specific key instead of sourcing (values may contain unquoted spaces)
if [ -f "${HIVE_DIR}/.env" ]; then
  HIVE_REPO_TOKEN=$(grep -m1 '^HIVE_REPO_TOKEN=' "${HIVE_DIR}/.env" | cut -d= -f2- | tr -d '"' || true)
  export HIVE_REPO_TOKEN
fi

# ── Build git env with token auth (bypasses credential store) ─────────
GIT_ENV="GIT_TERMINAL_PROMPT=0"
if [ -n "${HIVE_REPO_TOKEN:-}" ]; then
  GIT_ENV="${GIT_ENV} GIT_CONFIG_COUNT=1"
  GIT_ENV="${GIT_ENV} GIT_CONFIG_KEY_0=url.https://${HIVE_REPO_TOKEN}@github.com/.insteadOf"
  GIT_ENV="${GIT_ENV} GIT_CONFIG_VALUE_0=https://github.com/"
fi

run_as_ubuntu() {
  sudo -u ubuntu env $GIT_ENV bash -c "cd '${HIVE_DIR}' && $1"
}

OLD_HEAD=$(run_as_ubuntu "git rev-parse HEAD")
log "Current HEAD: ${OLD_HEAD:0:7}"

log "Fetching..."
run_as_ubuntu "git fetch origin"

# Stash any runtime-generated files that dirty the worktree
STASHED=false
if ! run_as_ubuntu "git diff --quiet" 2>/dev/null; then
  log "Stashing dirty worktree..."
  run_as_ubuntu "git stash --quiet"
  STASHED=true
fi

log "Pulling..."
run_as_ubuntu "git pull --ff-only"

if [ "${STASHED}" = true ]; then
  log "Reapplying stash..."
  run_as_ubuntu "git stash pop --quiet 2>/dev/null" || log "Stash pop conflict (discarding stale runtime files)"
fi

NEW_HEAD=$(run_as_ubuntu "git rev-parse HEAD")

# Ensure node_modules matches package-lock.json on every run — not just when
# package.json is in the pulled diff. The old conditional missed dep drift when
# a prior npm install partially failed, or when the pull range happened to skip
# the commit that added a devDep (e.g. jsdom was in package.json on origin but
# never landed in /home/ubuntu/hive/node_modules, breaking vitest with
# "Cannot find package 'jsdom'"). npm install is idempotent (~300ms when
# everything is in sync), so running it unconditionally self-heals cheaply.
log "Ensuring dependencies are installed..."
run_as_ubuntu "npm install --no-audit --no-fund"

if [ "${OLD_HEAD}" = "${NEW_HEAD}" ]; then
  log "No new commits. Nothing else to do."
  exit 0
fi

log "Updated: ${OLD_HEAD:0:7} → ${NEW_HEAD:0:7}"

# Copy service files in case they changed
sudo cp "${HIVE_DIR}"/cloud/templates/hive-update.service /etc/systemd/system/ 2>/dev/null || true
sudo cp "${HIVE_DIR}"/cloud/templates/hive-update.timer /etc/systemd/system/ 2>/dev/null || true
sudo cp "${HIVE_DIR}"/cloud/templates/hive.service /etc/systemd/system/ 2>/dev/null || true
sudo systemctl daemon-reload

log "Restarting hive..."
sudo -u ubuntu bash -c "cd '${HIVE_DIR}' && ./start-hive.sh --no-sessions --restart"

log "Update complete."
