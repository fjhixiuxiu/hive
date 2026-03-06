# Hive EC2 Hosting

Hive runs on a single EC2 instance in the Viv root AWS account, fronted by an ALB with HTTPS.

## Architecture

```
Internet -> ALB (HTTPS :443) -> EC2 :3000 (Hive Node.js server in tmux)
```

- **Auth**: GitHub OAuth for dashboard login
- **Secrets**: AWS Secrets Manager `hive/env` stores `.env` contents as JSON
- **Boot**: systemd runs `boot.sh` on every start (merges secrets into `.env`, starts Hive)
- **Init**: `init.sh` runs once via EC2 user-data (installs deps, clones repo, enables systemd)
- **Integrations**: configured via Hive UI (Settings > Integrations), persisted in `.env`

## AWS Resources

| Resource | ID / ARN |
|---|---|
| EC2 Instance | `i-0f0feb87a350bed7c` |
| Public IP | `54.165.232.115` |
| ALB | `hive-alb-1373967289.us-east-1.elb.amazonaws.com` |
| ALB SG | `sg-02529ba214238ce85` |
| EC2 SG | `sg-00e38a5d5b01e0833` |
| IAM Role | `hive-ec2-role` |
| IAM Profile | `hive-ec2-profile` |
| Secret (env) | `arn:aws:secretsmanager:us-east-1:140947722076:secret:hive/env-lcBCtZ` |
| ACM Cert | `arn:aws:acm:us-east-1:140947722076:certificate/0b26d24c-d8d3-4a1e-89f3-38e4a5ee6a5a` |
| TF State | `s3://viv-infrastructure-backend/viv/hive` |

## Scripts

- **`cloud/scripts/init.sh`** - One-time setup (user-data). Installs Node 20, AWS CLI, gh, uv, Claude Code, tmuxinator, Jenkins CLI. Clones repo, runs npm install, enables systemd service, then calls boot.sh.
- **`cloud/scripts/boot.sh`** - Every boot (systemd). Pulls `hive/env` from Secrets Manager, merges into `.env` (preserving UI-configured credentials), starts Hive with `--no-sessions --restart`.
- **`start-hive.sh`** - Starts Hive server in a detached tmux session. Flags: `--no-sessions` (skip tmux worker sessions), `--restart` (kill existing server first).

## Terraform

All infrastructure is managed with OpenTofu from `cloud/terraform/`.

```bash
cd cloud/terraform
tofu init
tofu plan
tofu apply
```

State is stored in S3 (`viv-infrastructure-backend` bucket, key `viv/hive`).

## Operations

**SSH**: `ssh -i ~/.ssh/jenkins.pem ubuntu@54.165.232.115`

**Restart Hive**: `sudo bash ~/hive/cloud/scripts/boot.sh`

**View logs**: `tail -f ~/hive.log` or `tmux attach -t hive-server`

**Re-run init** (after code changes): `cd ~/hive && git pull && sudo bash ~/hive/cloud/scripts/init.sh`

**Update .env secret**: Update `hive/env` in Secrets Manager, then restart.

## DNS

CNAME `hive.vivtechnologies.com` -> ALB DNS (configured in GoDaddy).

Currently using ALB DNS directly until DNS is set up.
