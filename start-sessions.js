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

// Determine what action to take for a session: 'skip' | 'recreate' | 'create' | 'noop'
//
// `explicit` = true when the user listed this slot on the CLI (or --force was passed).
// Non-explicit invocations (the default iteration over the roles map) are conservative:
//   - Missing slots are left alone ('noop') so killing a session keeps it dead across restarts.
//   - Running slots with a custom/mismatched path are left alone ('skip') so custom per-slot
//     paths configured via hive.config.js or manual tmuxinator runs aren't clobbered.
// Explicit invocations preserve the legacy behavior (create missing, recreate mismatched).
function resolveSessionAction(name, expectedRoot, existing, force, explicit = false) {
  if (!existing[name]) return explicit ? 'create' : 'noop';
  const currentPath = existing[name];
  if (pathMatchesRoot(currentPath, expectedRoot)) {
    return force ? 'recreate' : 'skip';
  }
  // Path mismatch — only recreate when explicitly requested
  return explicit ? 'recreate' : 'skip';
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
  // Load .env before config (config reads HIVE_REPO_DIR from env). Uses dotenv
  // so surrounding quotes are stripped (boot.sh's jq filter emits values like
  // WEB_BIND="0.0.0.0"; without quote stripping the literal quotes break
  // consumers like app.listen()). override: true preserves the prior behavior
  // of overriding existing env vars.
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath, override: true });
  }

  const config = require('./hive.config');
  const templatePath = path.join(__dirname, 'worker.yml');

  // Parse flags and session numbers
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const explicitNums = args.filter(a => a !== '--force').map(Number);
  // When slot numbers are listed on the CLI, those are "explicit" (legacy behavior).
  // With no slot numbers, iterate the roles map but treat it as non-explicit —
  // we only restart/verify already-running sessions, never auto-spawn missing ones.
  // --force upgrades everything to explicit.
  const hasExplicitNums = explicitNums.length > 0;
  const sessionNums = hasExplicitNums
    ? explicitNums
    : Object.keys(config.sessions.roles).map(Number);

  const existing = getExistingSessions();

  for (const n of sessionNums) {
    const root = config.sessions.repoDir(n);
    const name = String(n);
    const explicit = force || hasExplicitNums;
    const action = resolveSessionAction(name, root, existing, force, explicit);

    if (action === 'noop') {
      // Silent: slot is defined in roles map but not running — user killed it intentionally
      continue;
    }

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
      // Force a full-width window size — headless sessions default to 80x24
      // since no terminal client ever attaches. Without this, Claude output
      // wraps at 40 columns and becomes unreadable.
      execSync(`tmux resize-window -t ${JSON.stringify(name)} -x 311 -y 54 2>/dev/null || true`);
    } catch (err) {
      console.error(`Failed to start session ${n}: ${err.message}`);
    }

    // Write hive MCP config so the session has hive tools from the start
    try {
      const sessionMgr = require('./src/core/session-manager');
      const port = process.env.WEB_PORT || 3000;
      const token = process.env.WEB_TOKEN || process.env.HIVE_TOKEN || '';
      sessionMgr.writeMcpConfig(root, `ws://127.0.0.1:${port}`, token, name);
    } catch (err) {
      console.error(`Failed to write MCP config for session ${n}: ${err.message}`);
    }
  }
}
