#!/usr/bin/env bash
# check-access.sh — Audit what the current user can access.
# Run as your main user and as the sandbox user to compare blast radius.
#
# Usage:
#   ./check-access.sh              # check current user
#   sudo -u hivebot ./check-access.sh  # check sandbox user

set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
RESET='\033[0m'

pass() { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
header() { echo -e "\n${BOLD}$1${RESET}"; }

echo -e "${BOLD}Access check for: $(whoami)${RESET}"
echo -e "${DIM}$(date)${RESET}"

# ── Identity ──────────────────────────────────────────
header "Identity"
echo -e "  user:   $(whoami)"
echo -e "  uid:    $(id -u)"
echo -e "  groups: $(id -Gn 2>/dev/null || groups)"
echo -e "  home:   $HOME"
echo -e "  shell:  ${SHELL:-unknown}"

# ── SSH ───────────────────────────────────────────────
header "SSH keys"
if [ -d "$HOME/.ssh" ]; then
  key_count=0
  for key in "$HOME/.ssh"/id_* "$HOME/.ssh"/*.pem; do
    [ -f "$key" ] || continue
    # Skip .pub files
    [[ "$key" == *.pub ]] && continue
    key_count=$((key_count + 1))
    comment=$(ssh-keygen -lf "$key" 2>/dev/null | awk '{print $3}' || echo "unknown")
    type=$(ssh-keygen -lf "$key" 2>/dev/null | awk '{print $4}' || echo "")
    warn "SSH key: $(basename "$key") ($comment $type)"
  done
  if [ "$key_count" -eq 0 ]; then
    pass "No SSH private keys"
  fi

  if [ -f "$HOME/.ssh/config" ]; then
    host_count=$(grep -c "^Host " "$HOME/.ssh/config" 2>/dev/null || echo 0)
    warn "SSH config: $host_count hosts configured"
  else
    pass "No SSH config"
  fi
else
  pass "No .ssh directory"
fi

# ── GitHub ────────────────────────────────────────────
header "GitHub (gh CLI)"
if command -v gh &>/dev/null; then
  if gh auth status &>/dev/null 2>&1; then
    user=$(gh api user --jq .login 2>/dev/null || echo "unknown")
    warn "Authenticated as: $user"
    # Check scopes
    scopes=$(gh auth status 2>&1 | grep -i "token scopes" || echo "")
    if [ -n "$scopes" ]; then
      echo -e "  ${DIM}$scopes${RESET}"
    fi
  else
    pass "Not authenticated"
  fi
else
  pass "gh CLI not installed"
fi

# ── Git ───────────────────────────────────────────────
header "Git"
if command -v git &>/dev/null; then
  git_name=$(git config --global user.name 2>/dev/null || echo "")
  git_email=$(git config --global user.email 2>/dev/null || echo "")
  if [ -n "$git_name" ]; then
    echo -e "  identity: $git_name <$git_email>"
  else
    echo -e "  identity: ${DIM}not configured${RESET}"
  fi
fi

# ── SSH connectivity ──────────────────────────────────
header "SSH connectivity"
github_out=$(ssh -T git@github.com 2>&1 || true)
if echo "$github_out" | grep -q "Hi "; then
  user=$(echo "$github_out" | sed -n 's/.*Hi \(.*\)!.*/\1/p')
  warn "GitHub SSH access as: $user"
else
  pass "No GitHub SSH access"
fi

# ── sudo ──────────────────────────────────────────────
header "sudo"
if sudo -n true 2>/dev/null; then
  fail "Has passwordless sudo (root)"
elif sudo -n -l 2>/dev/null | grep -q "(ALL)"; then
  fail "Has sudo access (with password)"
else
  pass "No sudo access"
fi

# ── JIRA / Atlassian ──────────────────────────────────
header "JIRA"
jira_found=false
if [ -f "$HOME/.env" ]; then
  jira_user=$(grep '^JIRA_USERNAME=' "$HOME/.env" 2>/dev/null | cut -d= -f2-)
  jira_token=$(grep '^JIRA_API_TOKEN=' "$HOME/.env" 2>/dev/null | cut -d= -f2-)
  jira_url=$(grep '^JIRA_URL=' "$HOME/.env" 2>/dev/null | cut -d= -f2-)
  if [ -n "$jira_token" ]; then
    jira_found=true
    warn "JIRA API token in ~/.env (user: ${jira_user:-unknown}, url: ${jira_url:-unknown})"
  fi
fi
if [ -n "${JIRA_API_TOKEN:-}" ]; then
  jira_found=true
  warn "JIRA_API_TOKEN set in environment"
fi
if ! $jira_found; then
  pass "No JIRA credentials"
fi

# ── AWS ───────────────────────────────────────────────
header "AWS"
if [ -d "$HOME/.aws" ]; then
  if [ -f "$HOME/.aws/credentials" ]; then
    profiles=$(grep -c '^\[' "$HOME/.aws/credentials" 2>/dev/null || echo 0)
    fail "AWS credentials: $profiles profile(s)"
  elif [ -f "$HOME/.aws/config" ]; then
    warn "AWS config exists (may use SSO/role)"
  fi
else
  pass "No .aws directory"
fi

if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  fail "AWS_ACCESS_KEY_ID set in environment"
else
  pass "No AWS env vars"
fi

# ── Docker ────────────────────────────────────────────
header "Docker"
if command -v docker &>/dev/null; then
  if docker info &>/dev/null 2>&1; then
    warn "Docker access (can run containers)"
  else
    pass "Docker installed but no access"
  fi
else
  pass "Docker not available"
fi

# ── Claude Code ───────────────────────────────────────
header "Claude Code"
if command -v claude &>/dev/null; then
  echo -e "  installed: $(claude --version 2>/dev/null || echo 'yes')"
  if [ -f "$HOME/.claude/settings.json" ]; then
    mode=$(python3 -c "import json; print(json.load(open('$HOME/.claude/settings.json')).get('defaultMode','not set'))" 2>/dev/null || echo "unknown")
    if [ "$mode" = "bypassPermissions" ]; then
      warn "Permissions: bypassed (all tools auto-approved)"
    else
      echo -e "  permissions: $mode"
    fi
  else
    echo -e "  permissions: ${DIM}default (prompts for approval)${RESET}"
  fi
else
  echo -e "  ${DIM}not installed${RESET}"
fi

# ── Sensitive files ───────────────────────────────────
header "Sensitive files"
for f in \
  "$HOME/.env" \
  "$HOME/git/hive/.env" \
  "$HOME/.netrc" \
  "$HOME/.npmrc" \
  "$HOME/.pypirc" \
  "$HOME/.kube/config" \
  "$HOME/.docker/config.json" \
; do
  if [ -f "$f" ]; then
    warn "$(echo "$f" | sed "s|$HOME|~|")"
  fi
done

# Check for any .pem or .key files
pem_count=$(find "$HOME" -maxdepth 3 -name "*.pem" -o -name "*.key" 2>/dev/null | grep -cv ".ssh" || true)
if [ "$pem_count" -gt 0 ]; then
  fail "$pem_count .pem/.key files found in ~"
else
  pass "No .pem/.key files in ~"
fi

# ── Summary ───────────────────────────────────────────
header "Network"
# Check known_hosts for non-GitHub hosts
if [ -f "$HOME/.ssh/known_hosts" ]; then
  total=$(wc -l < "$HOME/.ssh/known_hosts" | tr -d ' ')
  echo -e "  known_hosts: $total entries"
fi

echo ""
