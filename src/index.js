#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// Load .env from project root
const envPath = path.join(__dirname, '..', '.env');
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

// Load config
const configPath = path.join(__dirname, '..', 'hive.config.js');
if (!fs.existsSync(configPath)) {
  console.error('Missing hive.config.js — copy from hive.config.example.js and customize.');
  process.exit(1);
}
const config = require(configPath);

// Start core watcher
const Watcher = require('./core/watcher');
const watcher = new Watcher(config);
watcher.start();
console.log(`Watcher started (polling every ${config.watcher.interval / 1000}s)`);

// Start Telegram integration
const { createBot } = require('./integrations/telegram/bot');
createBot(config, watcher);

// Start Web dashboard
const { createWebServer } = require('./integrations/web/server');
const webServer = createWebServer(config, watcher);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  watcher.stop();
  if (webServer) webServer.server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  watcher.stop();
  if (webServer) webServer.server.close();
  process.exit(0);
});
