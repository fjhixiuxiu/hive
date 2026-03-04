#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';

// ── CLI args ──────────────────────────────────────────
function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const hiveUrl = getArg('hive-url') || 'ws://127.0.0.1:3000';
const session = getArg('session') || '0';
const token = getArg('token') || '';
const enabledTools = getArg('tools')?.split(',') || null; // null = all

// ── WS connection to hive ─────────────────────────────
let ws = null;
let wsReady = false;
const pending = new Map();
let reqId = 0;

function connectWs() {
  const url = `${hiveUrl}?token=${encodeURIComponent(token)}&session=${session}&role=mcp`;
  ws = new WebSocket(url);
  ws.on('open', () => {
    // Must authenticate before sending any requests
    ws.send(JSON.stringify({ type: 'auth', token }));
  });
  ws.on('close', () => { wsReady = false; setTimeout(connectWs, 3000); });
  ws.on('error', () => {});
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth' && msg.ok) { wsReady = true; return; }
      if (msg.type === 'auth' && !msg.ok) { ws.close(); return; }
      if (msg._reqId && pending.has(msg._reqId)) {
        pending.get(msg._reqId)(msg);
        pending.delete(msg._reqId);
      }
    } catch {}
  });
}

function sendRequest(type, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!wsReady) return reject(new Error('Not connected to hive'));
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Request timed out'));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ type, _reqId: id, session: Number(session), ...payload }));
  });
}

connectWs();

// ── MCP Server ────────────────────────────────────────
const server = new McpServer({
  name: 'hive',
  version: '1.0.0',
});

// Tool: hive_get_task
if (!enabledTools || enabledTools.includes('hive_get_task')) {
  server.tool(
    'hive_get_task',
    'Get your currently assigned task from hive',
    {},
    async () => {
      try {
        const resp = await sendRequest('mcp:get_task');
        return { content: [{ type: 'text', text: JSON.stringify(resp.task || { message: 'No task assigned' }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Tool: hive_complete_task
if (!enabledTools || enabledTools.includes('hive_complete_task')) {
  server.tool(
    'hive_complete_task',
    'Mark your current task as complete',
    { summary: z.string().optional().describe('Brief summary of what was done') },
    async ({ summary }) => {
      try {
        const resp = await sendRequest('mcp:complete_task', { summary });
        return { content: [{ type: 'text', text: resp.ok ? 'Task marked as complete' : (resp.error || 'Failed') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Tool: hive_post_update
if (!enabledTools || enabledTools.includes('hive_post_update')) {
  server.tool(
    'hive_post_update',
    'Post a status update to the hive activity feed',
    { message: z.string().describe('The status update message') },
    async ({ message }) => {
      try {
        const resp = await sendRequest('mcp:post_update', { message });
        return { content: [{ type: 'text', text: resp.ok ? 'Update posted' : (resp.error || 'Failed') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Tool: hive_get_sessions
if (!enabledTools || enabledTools.includes('hive_get_sessions')) {
  server.tool(
    'hive_get_sessions',
    'Get the status of all active sessions',
    {},
    async () => {
      try {
        const resp = await sendRequest('mcp:get_sessions');
        return { content: [{ type: 'text', text: JSON.stringify(resp.sessions || [], null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// ── Start ─────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
