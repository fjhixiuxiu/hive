const os = require('os');
const path = require('path');
const fs = require('fs');

// Load .hive-setup.json if it exists (written by the onboarding wizard)
let setup = null;
try {
  setup = JSON.parse(fs.readFileSync(path.join(__dirname, '.hive-setup.json'), 'utf8'));
} catch { /* no setup file — use hardcoded defaults */ }

// Build roles map from setup or use defaults
function buildRoles() {
  if (setup && setup.roles) return setup.roles;
  if (setup && setup.agentCount) {
    const roles = {};
    for (let i = 1; i <= setup.agentCount; i++) {
      roles[i] = `Slot ${i}`;
    }
    return roles;
  }
  return {
    1: 'Reviews', 2: 'Ideas', 3: 'Urgent', 4: 'Tests',
    5: 'Slot 5', 6: 'Slot 6', 7: 'Slot 7', 8: 'Slot 8',
    9: 'Slot 9', 10: 'Slot 10', 11: 'Slot 11', 12: 'Slot 12',
    13: 'Slot 13', 14: 'Slot 14', 15: 'Slot 15', 16: 'Slot 16',
  };
}

module.exports = {
  // ── Session discovery ───────────────────────────────────
  sessions: {
    // Unique name for this hive instance (used as tmux session prefix)
    hiveName: (setup && setup.hiveName) || process.env.HIVE_NAME || '',
    namePrefix: (() => {
      const name = (setup && setup.hiveName) || process.env.HIVE_NAME || '';
      return name ? name + '-' : '';
    })(),

    // Base directory for session discovery (path-based filtering).
    // Sessions whose tmux session_path starts with this prefix are considered fleet members.
    // Falls back to pattern matching when null.
    repoBase: (() => {
      if (setup && setup.repoDir) return setup.repoDir.replace(/^~/, os.homedir());
      const envDir = process.env.HIVE_REPO_DIR;
      if (envDir) return envDir.replace(/^~/, os.homedir());
      return null;
    })(),

    // Regex to match tmux session names that are part of your fleet (legacy fallback)
    // When hiveName is set, pattern auto-matches prefixed names.
    pattern: (() => {
      const name = (setup && setup.hiveName) || process.env.HIVE_NAME || '';
      return name ? new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d+') : /^\d+/;
    })(),

    // Map session number → repo directory
    // Set HIVE_REPO_DIR in .env (e.g. ~/Desktop/Viv/webplatform) — session number is appended
    repoDir: (n) => {
      if (setup && setup.repoDir) {
        const base = setup.repoDir.replace(/^~/, os.homedir());
        return setup.sharedRepo ? base : path.join(base, String(n));
      }
      const base = (
        process.env.HIVE_REPO_DIR ||
        path.join(os.homedir(), 'ai-dev', 'webplatform')
      ).replace(/^~/, os.homedir());
      return path.join(base, String(n));
    },

    // Which pane index runs Claude Code (depends on your tmux layout)
    claudePane: 1,

    // Set to true if Claude Code is configured with vim keybindings
    vimMode: false,

    // Fixed session roles (optional, for display)
    roles: buildRoles(),
  },

  // ── tmux session creation ──────────────────────────────
  tmux: {
    defaultSize: { cols: 200, rows: 50 },
    defaultCommand: 'env -u CLAUDECODE bash --login',
  },

  // ── Idle detection ──────────────────────────────────────
  // Patterns that indicate Claude is waiting for input (idle)
  idlePatterns: [
    /bypass permissions/,
    /shift\+tab/,
    /ctrl-g to edit/,
    /\? for shortcuts/,
    /Try "/,
    /^\s*❯/,
    /Do you want to proceed/,
    /Esc to cancel/,
    /Enter to select/,
  ],

  // Patterns that indicate Claude isn't running
  offPatterns: [
    /conversation\./,
  ],

  // ── Cache (from tmux dashboard scripts) ─────────────────
  cache: {
    // Directory for PR/CI/review cache files (written by cache-warmer.sh)
    statusPrefix: '/tmp/tmux-status-',
    // Directory for Claude state files (written by idle-watcher.sh)
    stateDir: '/tmp/tmux-claude-states',
  },

  // ── Relay settings ──────────────────────────────────────
  relay: {
    // How often to poll for response (ms)
    pollInterval: 2000,
    // How long to wait before declaring done after idle detected (ms)
    cooldown: 5000,
    // Max time to wait for a response (ms)
    timeout: 5 * 60 * 1000,
  },

  // ── Watcher settings ────────────────────────────────────
  watcher: {
    // How often to check for state changes (ms)
    interval: 10000,
  },

  // ── GitHub + Jenkins (for PR/CI status) ───────────────
  github: {
    repo: (setup && setup.githubRepo) || 'mavencare/webplatform', // owner/repo
  },
  jenkins: {
    baseUrl: 'https://jenkins.vivtechnologies.com',
    jobPath: 'job/webplatform/job', // PR jobs at {baseUrl}/{jobPath}/PR-{prNum}/
  },

  // ── Web dashboard links ───────────────────────────────
  // URL templates for PR and CI links in the dashboard.
  // Use ${prNum} and ${ciBuild} as placeholders.
  // Set to null to disable linking.
  links: {
    pr: (setup && setup.githubRepo)
      ? `https://github.com/${setup.githubRepo}/pull/\${prNum}`
      : 'https://github.com/mavencare/webplatform/pull/${prNum}',
    ci: 'https://jenkins.vivtechnologies.com/job/webplatform/job/PR-${prNum}/${ciBuild}/',
  },
};
