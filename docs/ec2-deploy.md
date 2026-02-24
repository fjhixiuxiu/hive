# Deploying hive on EC2

Run your Claude Code fleet on a dedicated EC2 instance. Each Claude Code session uses ~500 MB of memory, so size your instance accordingly (e.g. 4 sessions → t3.medium, 8+ sessions → t3.large).

## 1. Launch an instance

- **AMI:** Ubuntu 22.04+ (arm64 or x86_64)
- **Instance type:** t3.medium or larger (2 vCPU, 4 GB RAM minimum for 4 sessions)
- **Storage:** 30 GB+ (repos, node_modules, Claude Code)
- **Security group:** SSH only — the dashboard is accessed via Tailscale or SSH tunnel, not exposed to the internet

## 2. Install dependencies

```bash
# System packages
sudo apt update && sudo apt install -y tmux ruby git

# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# tmuxinator
gem install tmuxinator --user-install
echo 'export PATH="$(ruby -e "puts Gem.user_dir")/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# gh CLI (optional, for PR/CI data)
sudo apt install -y gh
```

## 3. Create a sandbox user (optional)

On a shared instance, a sandbox user prevents Claude from accessing other users' credentials. On a dedicated instance this is optional — you're already isolated by the instance boundary.

```bash
sudo useradd -m -s /bin/bash hivebot
sudo usermod -aG $(id -gn) hivebot

# Passwordless sudo to hivebot
echo "$(whoami) ALL=(hivebot) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/hivebot

# SSH key for GitHub
sudo -u hivebot ssh-keygen -t ed25519 -f /home/hivebot/.ssh/id_ed25519 -N "" -C "hivebot-ec2"
sudo -u hivebot cat /home/hivebot/.ssh/id_ed25519.pub
# → Add this key to GitHub (Settings > SSH Keys)
```

If you skip the sandbox user, run everything as your regular user and ignore the `sudo -u hivebot` prefixes below.

## 4. Install Claude Code

```bash
# As hivebot (or your user if no sandbox)
sudo -u hivebot -i sh -c 'curl -fsSL https://claude.ai/install.sh | sh'
echo 'export PATH="$HOME/.local/bin:$PATH"' | sudo -u hivebot tee -a /home/hivebot/.bashrc

# Install tmuxinator for hivebot
sudo -u hivebot -i gem install tmuxinator --user-install
echo 'export PATH="$(ruby -e "puts Gem.user_dir")/bin:$PATH"' | sudo -u hivebot tee -a /home/hivebot/.bashrc

# Git identity
sudo -u hivebot -i git config --global user.name "Your Name (hivebot)"
sudo -u hivebot -i git config --global user.email "you@example.com"
sudo -u hivebot -i git config --global --add safe.directory '*'
```

### Authenticate Claude Code

Claude Code requires a one-time interactive authentication. On a headless instance, it prints a URL — open it in your local browser and paste the code back:

```bash
sudo -u hivebot -i claude
# → Opens a URL. Copy it, open in your browser, authorize, paste the code back.
```

## 5. Clone repos and install hive

```bash
# Accept GitHub's host key
sudo -u hivebot -i ssh -T git@github.com 2>&1 || true

# Clone hive
sudo -u hivebot -i git clone git@github.com:nukulb/hive.git ~/git/hive
sudo -u hivebot -i bash -c 'cd ~/git/hive && npm install'

# Clone your managed repos
sudo -u hivebot -i git clone git@github.com:your-org/your-repo.git ~/ai-dev/repo1
# ... repeat for each repo
```

## 6. Configure hive

```bash
sudo -u hivebot -i bash -c 'cd ~/git/hive && cp .env.example .env'
```

Edit `.env` with your token and optional Telegram credentials. Edit `hive.config.js` to match your repo layout — see [Configuration](../README.md#configuration) for details.

## 7. Start hive

```bash
sudo -u hivebot ~/git/hive/start-hive.sh
# → hive server started (pid 12345, log /home/hivebot/hive.log)
```

This launches the tmux sessions and starts the hive server in the background. Logs go to `~/hive.log`, pid to `~/hive.pid`.

To restart the server (e.g. after a config change):

```bash
kill $(cat /home/hivebot/hive.pid)
sudo -u hivebot ~/git/hive/start-hive.sh
```

You generally don't need to restart the tmux sessions — they hold your running Claude Code instances with their conversation history and in-progress work. Killing a tmux session kills the Claude process inside it, losing any unsaved context. Only kill sessions if you need to change the tmux layout or re-clone repos:

```bash
sudo -u hivebot tmux kill-server           # destroys all sessions — use sparingly
```

## 8. Access the dashboard

The hive server binds to `127.0.0.1` by default — it's not exposed to the internet. Two options for remote access:

### Option A: Tailscale (recommended)

Install [Tailscale](https://tailscale.com/download) on the instance and your phone/laptop. hive auto-detects the Tailscale IP and binds to it alongside localhost.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then open `http://<tailscale-ip>:3000` from any device on your tailnet.

### Option B: SSH tunnel

From your local machine:

```bash
ssh -L 3000:localhost:3000 your-ec2-host
```

Then open `http://localhost:3000` in your browser.

## Persistence

### Survive reboots

Add a cron job to start hive on boot:

```bash
echo "@reboot /home/hivebot/git/hive/start-hive.sh >> /home/hivebot/hive-boot.log 2>&1" | sudo -u hivebot crontab -
```

### Survive SSH disconnects

The tmux sessions and hive server already run detached from your SSH session. Disconnecting won't stop them.

## Sizing guide

| Sessions | Instance type | RAM   | Notes |
|----------|--------------|-------|-------|
| 1–4      | t3.medium    | 4 GB  | Good for small teams |
| 4–8      | t3.large     | 8 GB  | Comfortable headroom |
| 8–16     | t3.xlarge    | 16 GB | Heavy parallel workloads |

Claude Code is CPU-light but memory-heavy. Each session idles at ~300 MB and peaks around 500–700 MB during active work. Budget ~700 MB per session plus 1 GB for the OS and hive server.
