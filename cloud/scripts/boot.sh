#!/bin/bash
# Hive boot script — runs on every boot via systemd.
# Pulls .env from Secrets Manager and starts Hive.

set -euo pipefail

HIVE_DIR="/home/ubuntu/hive"
SECRET_NAME="hive/env"
REGION="us-east-1"

log() { echo "[$(date '+%H:%M:%S')] $1"; }

# ── Merge .env with Secrets Manager ───────────────────────────────────
log "Merging .env with Secrets Manager..."
ENV_FILE="${HIVE_DIR}/.env"
SECRET_ENV=$(aws secretsmanager get-secret-value \
  --secret-id "${SECRET_NAME}" \
  --region "${REGION}" \
  --query 'SecretString' \
  --output text \
  | jq -r 'to_entries[] | "\(.key)=\(.value)"')

# Start with existing .env (preserves UI-configured credentials)
touch "${ENV_FILE}"
MERGED=$(cat "${ENV_FILE}")

# Upsert each secret key into .env
while IFS= read -r line; do
  KEY="${line%%=*}"
  if grep -q "^${KEY}=" "${ENV_FILE}" 2>/dev/null; then
    MERGED=$(echo "${MERGED}" | sed "s|^${KEY}=.*|${line}|")
  else
    MERGED="${MERGED}
${line}"
  fi
done <<< "${SECRET_ENV}"

echo "${MERGED}" > "${ENV_FILE}"
chown ubuntu:ubuntu "${ENV_FILE}"

# ── Start Hive ──────────────────────────────────────────────────────────
log "Starting Hive..."
sudo -u ubuntu bash -c "cd ${HIVE_DIR} && ./start-hive.sh --no-sessions --restart"

log "Boot complete."
