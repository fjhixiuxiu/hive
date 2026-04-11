# Hive EC2 Hosting

Hive instances run on EC2 in the Viv root AWS account (140947722076), fronted by ALBs with HTTPS. Multiple hive instances can coexist via Terraform workspaces — each gets its own EC2, ALB, SGs, IAM role, and Secrets Manager secret.

All hive instances live in the **Jenkins VPC** (`vpc-02651295c24f8bc7f`), in shared `internal-tools-*` subnets alongside Jenkins and future internal tooling (Nectar, etc.).

## Architecture

```
Internet
  |
  v
GoDaddy DNS (CNAME: <hive>.vivtechnologies.com -> ALB DNS)
  |
  v
ALB (HTTPS :443, TLS 1.3) ---- ACM cert: *.vivtechnologies.com
  |  HTTP :80 -> 301 redirect to HTTPS
  v
Target Group (<hive>-tg, HTTP :3000, health check: GET / -> 200,302)
  |
  v
EC2 t3.large (Ubuntu 22.04) ---- port 3000 (Node.js/Express in tmux)
  |
  +-- systemd (hive.service) -> boot.sh -> start-hive.sh
  +-- Secrets Manager (hive/<name>-env) -> .env (via hive-secret-name tag)
  +-- tmux sessions (hive-server + fleet workers)
  +-- GitHub OAuth for dashboard auth
```

- **Auth**: GitHub OAuth for dashboard login
- **Secrets**: AWS Secrets Manager stores `.env` contents as JSON. The EC2 tag `hive-secret-name` tells `boot.sh` which secret to fetch.
- **Boot**: systemd runs `boot.sh` on every start (merges secrets into `.env`, starts Hive)
- **Init**: `init.sh` runs once via EC2 user-data (installs deps, clones repo, enables systemd)
- **Integrations**: can also be configured via Hive UI (Settings > Integrations), persisted in `.env`

## Deployed Instances

### Review Hive (`default` workspace)

URL: `https://review-hive.vivtechnologies.com`
SSH: `ssh hive-review`

| Resource | ID / ARN |
|---|---|
| EC2 Instance | `i-047ee18a12869de7e` |
| Public IP | `44.211.42.149` |
| Private IP | `10.0.3.236` |
| VPC | `vpc-02651295c24f8bc7f` (Jenkins) |
| Subnet | `subnet-0d5dee6be35a20916` (`internal-tools-1a`, us-east-1a) |
| ALB | `hive-alb-356434589.us-east-1.elb.amazonaws.com` |
| ALB Subnets | `subnet-0d5dee6be35a20916` (1a), `subnet-094867cafbdcc387d` (1b) |
| Target Group | `hive-tg` |
| ALB SG | `sg-03aa7820005e9beae` (`hive-alb-sg`) |
| EC2 SG | `sg-0b5380be9c0080f90` (`hive-ec2-sg`) |
| Office SSH SG | `sg-043c84f65239ea620` (`toronto-office-jenkins-ssh`) |
| Fleet SG | `sg-0eccb5c1f5c931f9c` (`hive-fleet-sg`, Jenkins VPC) |
| IAM Role | `hive-ec2-role` |
| IAM Profile | `hive-ec2-profile` |
| Secret | `hive/env` |
| TF Workspace | `default` (uses `review.tfvars`) |
| HIVE_TITLE | `Viv Review Hive` |

### Support Hive (`support` workspace)

URL: `https://support-hive.vivtechnologies.com`
SSH: `ssh hive-support`

| Resource | ID / ARN |
|---|---|
| EC2 Instance | `i-0dfe9e1e464866a15` |
| Public IP | `54.166.91.211` |
| Private IP | `10.0.4.7` |
| VPC | `vpc-02651295c24f8bc7f` (Jenkins) |
| Subnet | `subnet-094867cafbdcc387d` (`internal-tools-1b`, us-east-1b) |
| ALB | `support-hive-alb-2018772839.us-east-1.elb.amazonaws.com` |
| ALB Subnets | `subnet-0d5dee6be35a20916` (1a), `subnet-094867cafbdcc387d` (1b) |
| Target Group | `support-hive-tg` |
| ALB SG | `sg-0f04d9e1d63804382` (`support-hive-alb-sg`) |
| EC2 SG | `sg-0e0a231aff050f9c7` (`support-hive-ec2-sg`) |
| Office SSH SG | `sg-043c84f65239ea620` (`toronto-office-jenkins-ssh`) |
| Fleet SG | `sg-0eccb5c1f5c931f9c` (`hive-fleet-sg`, Jenkins VPC) |
| IAM Role | `support-hive-ec2-role` |
| IAM Profile | `support-hive-ec2-profile` |
| Secret | `hive/support-env` |
| TF Workspace | `support` (uses `support.tfvars`) |
| HIVE_TITLE | `Viv Support Hive` |

### Shared Resources (across all hives)

| Resource | ID / ARN | Purpose |
|---|---|---|
| ACM Cert | `arn:aws:acm:us-east-1:140947722076:certificate/2bd943c9-7692-430b-b46b-b9a5cee983f3` | `*.vivtechnologies.com` wildcard |
| SSH Key | `jenkins` | Reused from Jenkins infra |
| AMI | `ami-04680790a315cd58d` | Ubuntu 22.04 (default for new hives) |
| TF State Bucket | `s3://viv-infrastructure-backend` | Key: `viv/hive` (workspaces isolate state) |
| TF State Lock | `viv-infrastructure-state-lock` | DynamoDB |
| Prefix List | `pl-00a38e5148e01f014` (`viv-internal-tools-ips`) | Jenkins ALB allows 443 from this list. Add new hive IPs here. |

### Jenkins VPC shared subnets (internal dev tooling)

Created outside Terraform state for cross-project use (Nectar, Hive, future services):

| Subnet | CIDR | AZ |
|---|---|---|
| `subnet-0d5dee6be35a20916` (`internal-tools-1a`) | 10.0.3.0/24 | us-east-1a |
| `subnet-094867cafbdcc387d` (`internal-tools-1b`) | 10.0.4.0/24 | us-east-1b |

Both associated with Jenkins public route table `rtb-03867c69d62c50896` (IGW egress via `igw-020c46ecf820bb014`).

## Scripts

- **`cloud/scripts/init.sh`** — One-time setup (user-data). Installs Node 20, AWS CLI, gh, uv, Claude Code, tmuxinator, Jenkins CLI. Clones the hive repo, runs `npm install`, writes `~/.claude/settings.json` (bypass permissions + trusted `/home/ubuntu`), enables the systemd service, and calls `boot.sh`.
- **`cloud/scripts/boot.sh`** — Every boot (systemd). Reads the `hive-secret-name` EC2 tag to resolve the secret (falls back to `hive/env`), pulls the secret, merges into `.env` (preserving UI-configured credentials), and starts Hive with `--no-sessions --restart`.
- **`start-hive.sh`** — Starts the Hive server in a detached tmux session. Flags: `--no-sessions` (skip tmux worker sessions), `--restart` (kill existing server first).

## Terraform

Infrastructure is managed with OpenTofu from `cloud/terraform/`. Terraform workspaces isolate state per hive instance.

### Existing workspaces

```bash
cd cloud/terraform
tofu init
tofu workspace list
# * default    (review-hive)
#   support    (support-hive)
```

### Apply to an existing hive

```bash
# Review hive
tofu workspace select default
tofu plan -var-file=review.tfvars
tofu apply -var-file=review.tfvars

# Support hive
tofu workspace select support
tofu plan -var-file=support.tfvars
tofu apply -var-file=support.tfvars
```

### Spawning a new hive

1. **Create a new workspace:**
   ```bash
   tofu workspace new <hive-name>
   ```

2. **Create a tfvars file** (`<hive-name>.tfvars`) pointing at the Jenkins VPC shared subnets:
   ```hcl
   hive_name       = "<hive-name>-hive"
   env_name        = "<hive-name>-hive"
   secret_name     = "hive/<hive-name>-env"
   ebs_volume_size = 500

   # Jenkins VPC (internal tools subnets)
   vpc_id = "vpc-02651295c24f8bc7f"
   subnet_ids = [
     "subnet-0d5dee6be35a20916", # internal-tools-1a
     "subnet-094867cafbdcc387d", # internal-tools-1b
   ]
   ec2_subnet_id    = "subnet-094867cafbdcc387d"
   office_ssh_sg_id = "sg-043c84f65239ea620"     # toronto-office-jenkins-ssh (also Jenkins ALB SG)
   hive_fleet_sg_id = "sg-0eccb5c1f5c931f9c"     # hive-fleet-sg
   ```

3. **Create the Secrets Manager secret** with `.env` contents:
   ```bash
   aws secretsmanager create-secret --name "hive/<hive-name>-env" \
     --secret-string '{"WEB_PORT":"3000","WEB_BIND":"0.0.0.0","WEB_TOKEN":"...","GITHUB_CLIENT_ID":"...","GITHUB_CLIENT_SECRET":"...","GITHUB_CALLBACK_URL":"https://<hive-name>-hive.vivtechnologies.com/auth/github/callback","GITHUB_ORG":"mavencare","HIVE_TITLE":"Viv <Name> Hive"}'
   ```

4. **Plan and apply:**
   ```bash
   tofu plan -var-file=<hive-name>.tfvars
   tofu apply -var-file=<hive-name>.tfvars
   ```

5. **Configure DNS** in GoDaddy: create CNAME `<hive-name>-hive.vivtechnologies.com` → the new ALB DNS from `tofu output`.

6. **Add the GitHub OAuth callback URL** to the existing OAuth App (one app supports multiple callbacks).

7. **Add the new EC2's public IP to the `viv-internal-tools-ips` prefix list** (`pl-00a38e5148e01f014`) so it can reach Jenkins:
   ```bash
   VERSION=$(aws ec2 describe-managed-prefix-lists --prefix-list-ids pl-00a38e5148e01f014 --query 'PrefixLists[0].Version' --output text)
   aws ec2 modify-managed-prefix-list --prefix-list-id pl-00a38e5148e01f014 --current-version $VERSION \
     --add-entries "Cidr=<new-public-ip>/32,Description=<hive-name>-hive"
   ```

8. **SSH in and verify** via the instance public IP.

## Operations

### Review Hive
```bash
ssh hive-review                          # alias for ubuntu@44.211.42.149
ssh -i ~/.ssh/jenkins.pem ubuntu@44.211.42.149
```

### Support Hive
```bash
ssh hive-support                          # alias for ubuntu@54.166.91.211
ssh -i ~/.ssh/jenkins.pem ubuntu@54.166.91.211
```

### Common Operations

**Restart Hive (picks up new secret values):**
```bash
sudo bash ~/hive/cloud/scripts/boot.sh
```

**View logs:**
```bash
tail -f ~/hive.log
# or attach to the server tmux session
tmux attach -t hive-server
```

**Update code:**
```bash
cd ~/hive && git pull && npm install
sudo bash ~/hive/cloud/scripts/boot.sh
```

**Re-run init (after changes to init.sh):**
```bash
sudo bash ~/hive/cloud/scripts/init.sh
```

**Update secret:** Update the secret in AWS Secrets Manager (`hive/env` or `hive/support-env`), then restart via `boot.sh`.

## Jenkins access (from hive instances)

Hive instances reach `jenkins.vivtechnologies.com` via a **managed prefix list** on the Jenkins ALB SG:

- **Prefix list:** `pl-00a38e5148e01f014` (`viv-internal-tools-ips`)
- **Referenced from:** Jenkins ALB SG `sg-043c84f65239ea620` port 443 ingress
- **Currently contains:** review-hive IP, support-hive IP, Jenkins VPC NAT EIP (for lambdas)
- **When adding a new hive or dev tool:** add its public IP to this prefix list (single edit, no SG change)

Note: even though hives live in the Jenkins VPC, SG-to-SG rules don't work for Jenkins access because traffic hairpins through the IGW (Jenkins ALB is internet-facing, public DNS resolves to public IPs, traffic leaves and re-enters the VPC with the hive's public source IP). The prefix list is the simplest alternative.

**Stale Route 53 private zone gotcha:** A legacy private hosted zone `Z017674111TRYVPI02EZ8` is associated with the Jenkins VPC and resolves `jenkins.vivtechnologies.com` to a non-existent IP. Each new hive needs an `/etc/hosts` workaround pointing at a current Jenkins ALB public IP (see REMOTE-HIVE-SETUP.md for details).

## DNS

DNS is managed in **GoDaddy** (not Route 53). The wildcard ACM cert `*.vivtechnologies.com` covers all hive subdomains.

| Subdomain | Points to |
|---|---|
| `review-hive.vivtechnologies.com` | `hive-alb-356434589.us-east-1.elb.amazonaws.com` |
| `support-hive.vivtechnologies.com` | `support-hive-alb-2018772839.us-east-1.elb.amazonaws.com` |
