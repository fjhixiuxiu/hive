#!/usr/bin/env node
// Starts tmux sessions for all configured slots using the worker.yml template.
// Usage: node start-sessions.js [sessionNumbers...]
// Examples:
//   node start-sessions.js          # starts all (1-4 by default)
//   node start-sessions.js 1 3      # starts sessions 1 and 3 only

const { execSync } = require('child_process');
const path = require('path');
const config = require('./hive.config');

const templatePath = path.join(__dirname, 'worker.yml');

// Determine which sessions to start
const args = process.argv.slice(2);
const sessionNums = args.length
  ? args.map(Number)
  : Object.keys(config.sessions.roles).map(Number);

for (const n of sessionNums) {
  const root = config.sessions.repoDir(n);
  const cmd = `tmuxinator start -p "${templatePath}" N=${n} ROOT="${root}" --no-attach`;
  console.log(`Starting session ${n} → ${root}`);
  try {
    execSync(`/bin/zsh -lc ${JSON.stringify(cmd)}`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to start session ${n}: ${err.message}`);
  }
}
