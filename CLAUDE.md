# CLAUDE.md

## What is hive?

hive is a real-time dashboard and control plane for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions running in tmux. It provides a mobile-first web UI and Telegram bot for monitoring, messaging, and steering your AI coding fleet.

## Quick Start

```bash
npm install
npm start        # production
npm run dev      # development (auto-restart on changes)
```

Configuration lives in `hive.config.js` — adjust session patterns, repo paths, idle detection, and dashboard links for your setup.

## Sandboxed User (hivebot)

- hive runs as `hivebot`, a sandboxed macOS user with no sudo, no prod SSH keys, no AWS creds
- `execSync` and `exec` use `/bin/sh` by default, which does NOT have gem/tmuxinator in PATH. Always use `shell: '/bin/zsh -l'` when calling `tmuxinator` or other user-installed tools (e.g. ruby gems)
- When testing commands as hivebot: `sudo -u hivebot -i` (login shell) not `sudo -u hivebot` (inherits your cwd which hivebot may not be able to access)
- Paths resolve via `os.homedir()` -> `/Users/hivebot` when running as hivebot

## Running Tests

```bash
npm test             # run all tests (vitest)
npm run test:watch   # watch mode
npm run test:coverage # with coverage
```

Tests live in `test/core/` (unit) and `test/e2e/` (integration). The test framework is [vitest](https://vitest.dev/).

## Contributing

1. Fork the repo
2. Create a feature branch from `main`
3. Make your changes
4. Open a PR to `nukulb/hive` (upstream)

Keep PRs focused — one feature or fix per PR.
