#!/usr/bin/env node
// Starts tmux sessions for all configured slots using the worker.yml template.
// Usage: node start-sessions.js [sessionNumbers...]
// Examples:
//   node start-sessions.js          # starts all (1-4 by default)
//   node start-sessions.js 1 3      # starts sessions 1 and 3 only

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Exported helpers (testable) ─────────────────────────────

// Parse tmux list-sessions output into { name: path } map
function parseExistingSessions(output) {
  const map = {};
  if (!output || !output.trim()) return map;
  for (const line of output.trim().split('\n')) {
    const sep = line.indexOf(':');
    if (sep > 0) map[line.substring(0, sep)] = line.substring(sep + 1);
  }
  return map;
}

// Check whether currentPath belongs to expectedRoot
function pathMatchesRoot(currentPath, expectedRoot) {
  return currentPath === expectedRoot || currentPath.startsWith(expectedRoot + '/');
}

// Determine what action to take for a session: 'skip' | 'recreate' | 'create'
function resolveSessionAction(name, expectedRoot, existing, force) {
  if (!existing[name]) return 'create';
  const currentPath = existing[name];
  if (!force && pathMatchesRoot(currentPath, expectedRoot)) return 'skip';
  return 'recreate';
}

// Get existing tmux sessions and their paths (live)
function getExistingSessions() {
  try {
    const out = execSync('tmux list-sessions -F "#{session_name}:#{session_path}" 2>/dev/null', { encoding: 'utf8' });
    return parseExistingSessions(out);
  } catch {
    return {};
  }
}

module.exports = { parseExistingSessions, pathMatchesRoot, resolveSessionAction };

// ── CLI entry point ─────────────────────────────────────────

if (require.main === module) {
  // Load .env before config (config reads HIVE_REPO_DIR from env)
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        process.env[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
      }
    }
  }

  const config = require('./hive.config');
  const templatePath = path.join(__dirname, 'worker.yml');

  // Parse flags and session numbers
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const sessionNums = args.filter(a => a !== '--force').length
    ? args.filter(a => a !== '--force').map(Number)
    : Object.keys(config.sessions.roles).map(Number);

  const existing = getExistingSessions();

  for (const n of sessionNums) {
    const root = config.sessions.repoDir(n);
    const name = String(n);
    const action = resolveSessionAction(name, root, existing, force);

    if (action === 'skip') {
      console.log(`Session ${n} already running at ${existing[name]} — skipping (use --force to recreate)`);
      continue;
    }

    if (action === 'recreate') {
      console.log(`Killing stale session ${n} (was ${existing[name]}, expected ${root})`);
      try {
        execSync(`tmux kill-session -t ${JSON.stringify(name)}`, { stdio: 'inherit' });
      } catch { /* ignore */ }
    }

    const cmd = `tmuxinator start -p "${templatePath}" N=${n} ROOT="${root}" --no-attach`;
    console.log(`Starting session ${n} → ${root}`);
    try {
      execSync(`/bin/zsh -lc ${JSON.stringify(cmd)}`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`Failed to start session ${n}: ${err.message}`);
    }
  }
}
