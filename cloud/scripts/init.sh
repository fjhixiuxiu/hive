#!/bin/bash
# Hive init script — one-time setup via EC2 user-data.
# Installs system dependencies, clones the repo, and kicks off boot.sh.
# Run as root. Subsequent reboots use boot.sh via systemd.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

UBUNTU_HOME="/home/ubuntu"
HIVE_DIR="${UBUNTU_HOME}/hive"

log() { echo "[$(date '+%H:%M:%S')] $1"; }

# ══════════════════════════════════════════════════════════════════════════════
# FIRST-RUN: Install system dependencies (skips if already done)
# ══════════════════════════════════════════════════════════════════════════════

if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  log "Installing system packages..."
  apt-get update -qq
  apt-get install -y -qq tmux git jq curl unzip build-essential ruby software-properties-common

  log "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v aws &>/dev/null; then
  log "Installing AWS CLI v2..."
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp/aws-install
  /tmp/aws-install/aws/install
  rm -rf /tmp/awscliv2.zip /tmp/aws-install
fi

if ! command -v gh &>/dev/null; then
  log "Installing GitHub CLI..."
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  apt-get update -qq
  apt-get install -y -qq gh
fi

if [ ! -f /usr/local/lib/jenkins-cli.jar ]; then
  log "Installing Jenkins CLI..."
  curl -fsSL --connect-timeout 10 https://jenkins.vivtechnologies.com/jnlpJars/jenkins-cli.jar \
    -o /usr/local/lib/jenkins-cli.jar || log "WARNING: Jenkins CLI download failed"
fi

if ! command -v uv &>/dev/null; then
  log "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh
  ln -sf /root/.local/bin/uv /usr/local/bin/uv 2>/dev/null || true
  ln -sf /root/.local/bin/uvx /usr/local/bin/uvx 2>/dev/null || true
fi

log "Installing Claude Code..."
npm install -g @anthropic-ai/claude-code
sudo -u ubuntu bash -c 'mkdir -p ~/.local/bin && claude install' 2>/dev/null || true

if ! command -v tmuxinator &>/dev/null; then
  log "Installing tmuxinator..."
  gem install tmuxinator --no-document
fi

# ── Configure ubuntu user (idempotent) ────────────────────────────────────
sudo -u ubuntu git config --global user.name "hive-bot[bot]"
sudo -u ubuntu git config --global user.email "hive-bot[bot]@users.noreply.github.com"

sudo -u ubuntu mkdir -p "${UBUNTU_HOME}/.ssh" "${UBUNTU_HOME}/hive_fleet" "${UBUNTU_HOME}/.claude"
ssh-keyscan -t ed25519 github.com >> "${UBUNTU_HOME}/.ssh/known_hosts" 2>/dev/null || true
chown ubuntu:ubuntu "${UBUNTU_HOME}/.ssh/known_hosts"

# ── Claude Code config ───────────────────────────────────────────────────
if [ ! -f "${UBUNTU_HOME}/.claude/settings.json" ]; then
  log "Writing Claude Code settings..."
  cat > "${UBUNTU_HOME}/.claude/settings.json" << 'CLAUDE_EOF'
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "additionalDirectories": [
      "/home/ubuntu"
    ]
  },
  "skipDangerousModePermissionPrompt": true
}
CLAUDE_EOF
  chown ubuntu:ubuntu "${UBUNTU_HOME}/.claude/settings.json"
fi

timedatectl set-timezone America/Toronto 2>/dev/null || true

# ── Clone hive repo if missing ────────────────────────────────────────────
if [ ! -d "${HIVE_DIR}" ]; then
  log "Cloning hive repo..."
  sudo -u ubuntu git clone https://github.com/nukulb/hive.git "${HIVE_DIR}"
fi

# ── tmux config ───────────────────────────────────────────────────────────
cp "${HIVE_DIR}/cloud/templates/tmux.conf" "${UBUNTU_HOME}/.tmux.conf"
chown ubuntu:ubuntu "${UBUNTU_HOME}/.tmux.conf"

# ── npm install ───────────────────────────────────────────────────────────
cd "${HIVE_DIR}"
sudo -u ubuntu npm install 2>&1 | tail -1

# ── Install systemd service + auto-update timer ───────────────────────
log "Installing hive systemd service..."
cp "${HIVE_DIR}/cloud/templates/hive.service" /etc/systemd/system/hive.service
cp "${HIVE_DIR}/cloud/templates/hive-update.service" /etc/systemd/system/hive-update.service
cp "${HIVE_DIR}/cloud/templates/hive-update.timer" /etc/systemd/system/hive-update.timer
chmod +x "${HIVE_DIR}/cloud/scripts/auto-update.sh"
systemctl daemon-reload
systemctl enable hive.service
systemctl enable --now hive-update.timer

# ── Run boot.sh to write .env and start Hive ────────────────────────────
log "Running boot.sh..."
bash "${HIVE_DIR}/cloud/scripts/boot.sh"

log "Init complete."
