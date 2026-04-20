#!/bin/bash
# Hive boot script — runs on every boot via systemd.
# Pulls .env from Secrets Manager and starts Hive.
# SECRET_NAME is read from the EC2 instance tag "hive-secret-name",
# falling back to "hive/env" if the tag is not set.

set -euo pipefail

HIVE_DIR="/home/ubuntu/hive"
REGION="us-east-1"

log() { echo "[$(date '+%H:%M:%S')] $1"; }

# ── Resolve secret name from EC2 instance tag ────────────────────────
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
TAG_VALUE=$(aws ec2 describe-tags \
  --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=hive-secret-name" \
  --query "Tags[0].Value" --output text --region "$REGION" 2>/dev/null || echo "None")
SECRET_NAME="${TAG_VALUE}"
[ "$SECRET_NAME" = "None" ] || [ -z "$SECRET_NAME" ] && SECRET_NAME="hive/env"
log "Using secret: $SECRET_NAME"

# ── Merge .env with Secrets Manager ───────────────────────────────────
log "Merging .env with Secrets Manager..."
ENV_FILE="${HIVE_DIR}/.env"
SECRET_ENV=$(aws secretsmanager get-secret-value \
  --secret-id "${SECRET_NAME}" \
  --region "${REGION}" \
  --query 'SecretString' \
  --output text \
  | jq -r 'to_entries[] | "\(.key)=\"\(.value)\""')

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
