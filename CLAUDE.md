# CLAUDE.md

## Development tips

### Sandboxed user (hivebot)

- hive runs as `hivebot`, a sandboxed macOS user with no sudo, no prod SSH keys, no AWS creds
- `execSync` and `exec` use `/bin/sh` by default, which does NOT have gem/tmuxinator in PATH. Always use `shell: '/bin/zsh -l'` when calling `tmuxinator` or other user-installed tools (e.g. ruby gems)
- When testing commands as hivebot: `sudo -u hivebot -i` (login shell) not `sudo -u hivebot` (inherits your cwd which hivebot may not be able to access)
- Paths resolve via `os.homedir()` → `/Users/hivebot` when running as hivebot

TBD
