#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const tmux = require('./core/tmux');

const hubUrl = process.argv[2] || process.env.HIVE_HUB_URL;
const secret = process.argv[3] || process.env.HIVE_SECRET;
const nodeId = process.argv[4] || process.env.HIVE_NODE_ID || require('os').hostname();

if (!hubUrl || !secret) {
  console.error('Usage: hive-worker <hub-url> <secret> [node-id]');
  console.error('  or set HIVE_HUB_URL, HIVE_SECRET, and optionally HIVE_NODE_ID env vars');
  process.exit(1);
}

let ws;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connect() {
  console.log(`Connecting to ${hubUrl} as "${nodeId}"...`);
  ws = new WebSocket(hubUrl);

  ws.on('open', () => {
    console.log('Connected to hub, registering...');
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: 'worker:register', secret, nodeId }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'worker:registered') {
      console.log(`Registered as node "${msg.nodeId}"`);
      return;
    }

    if (msg.type === 'rpc') {
      try {
        const result = await handleRpc(msg.method, msg.params);
        ws.send(JSON.stringify({ type: 'rpc:response', id: msg.id, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'rpc:response', id: msg.id, error: err.message }));
      }
    }
  });

  ws.on('close', () => {
    console.log(`Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

async function handleRpc(method, params) {
  switch (method) {
    case 'exec':
      return tmux.exec(params.cmd, params.opts);
    case 'listSessions':
      return tmux.listSessions();
    case 'capturePane':
      return tmux.capturePane(params.target, params.opts || {});
    case 'sendKeys':
      return tmux.sendKeys(params.target, params.keys, params.enter);
    case 'hasSession':
      return tmux.hasSession(params.name);
    case 'killSession':
      return tmux.killSession(params.name);
    case 'readFile':
      try { return fs.readFileSync(params.filePath, 'utf8'); } catch { return null; }
    case 'fileExists':
      return fs.existsSync(params.filePath);
    case 'gitInfo':
      return tmux.gitInfo(params.repoDir);
    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
}

// Heartbeat every 30s
setInterval(() => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'heartbeat' }));
  }
}, 30000);

connect();
