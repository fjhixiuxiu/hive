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
      if (msg.type === 'mcp:exit') { process.exit(0); }
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
    ws.send(JSON.stringify({ type, _reqId: id, session: Number(session) || session, ...payload }));
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
    'Mark your current task as complete. Before completing, ensure you have set context (PR URL, branch) via hive_set_context if applicable.',
    { summary: z.string().optional().describe('Brief summary of what was done') },
    async ({ summary }) => {
      try {
        const resp = await sendRequest('mcp:complete_task', { summary });
        if (resp.pending) {
          return { content: [{ type: 'text', text: 'Task completion pending human approval. The task owner will review and approve or reject. Continue working if needed.' }] };
        }
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

// Tool: hive_report_learnings
if (!enabledTools || enabledTools.includes('hive_report_learnings')) {
  server.tool(
    'hive_report_learnings',
    'Report learnings/insights discovered during this task',
    { learnings: z.array(z.string()).describe('Array of insights or patterns discovered') },
    async ({ learnings }) => {
      try {
        const resp = await sendRequest('mcp:report_learnings', { learnings });
        return { content: [{ type: 'text', text: resp.ok ? 'Learnings recorded' : (resp.error || 'Failed') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Tool: hive_share_knowledge
if (!enabledTools || enabledTools.includes('hive_share_knowledge')) {
  server.tool(
    'hive_share_knowledge',
    'Share an insight with the fleet knowledge base so other sessions can benefit from your experience',
    {
      insight: z.string().describe('What you learned — a gotcha, pattern, root cause, or tip'),
      files: z.array(z.string()).optional().describe('File paths involved (e.g. ["evv-modal.js", "gps-suggestion.js"])'),
      domain: z.string().optional().describe('Domain area (e.g. "evv", "billing", "booking", "payroll")'),
      type: z.enum(['gotcha', 'pattern', 'fix', 'dependency', 'tip']).optional().describe('Type of insight'),
    },
    async ({ insight, files, domain, type: insightType }) => {
      try {
        const resp = await sendRequest('mcp:share_knowledge', { insight, files, domain, insightType });
        return { content: [{ type: 'text', text: resp.ok ? 'Knowledge shared with the fleet' : (resp.error || 'Failed') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Tool: hive_get_knowledge
if (!enabledTools || enabledTools.includes('hive_get_knowledge')) {
  server.tool(
    'hive_get_knowledge',
    'Query the fleet knowledge base for insights from other sessions about specific files, domains, or topics',
    {
      query: z.string().optional().describe('Free-text search (e.g. "GPS validation timezone")'),
      files: z.array(z.string()).optional().describe('File paths to find knowledge about'),
      domain: z.string().optional().describe('Domain to filter by (e.g. "evv", "billing")'),
    },
    async ({ query, files, domain }) => {
      try {
        const resp = await sendRequest('mcp:get_knowledge', { query, files, domain });
        const entries = resp.entries || [];
        const pmLearnings = resp.pmLearnings || [];
        const parts = [];
        if (pmLearnings.length) {
          parts.push(`Your team's learnings (${pmLearnings.length}):\n` + pmLearnings.map(m => `- ${m}`).join('\n'));
        }
        if (entries.length) {
          const kbText = entries.map(e => {
            const meta = [e.sourcePm, e.domain, e.type].filter(Boolean).join(' · ');
            const fileList = (e.files || []).length ? `\n  Files: ${e.files.join(', ')}` : '';
            return `- [${meta}] ${e.insight}${fileList}`;
          }).join('\n');
          parts.push(`Fleet knowledge (${entries.length}):\n${kbText}`);
        }
        if (!parts.length) {
          return { content: [{ type: 'text', text: 'No relevant knowledge found.' }] };
        }
        return { content: [{ type: 'text', text: parts.join('\n\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Tool: hive_get_context
if (!enabledTools || enabledTools.includes('hive_get_context')) {
  server.tool(
    'hive_get_context',
    'Get shared context for this session (plan file, PR, JIRA, etc.)',
    {},
    async () => {
      try {
        const resp = await sendRequest('mcp:get_context');
        return { content: [{ type: 'text', text: JSON.stringify(resp.context || {}, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Tool: hive_set_context
if (!enabledTools || enabledTools.includes('hive_set_context')) {
  server.tool(
    'hive_set_context',
    'Share context with hive. IMPORTANT: You MUST call this when you: (1) open or start working on a PR (set "pr"), (2) switch branches (set "branch"), (3) post to or engage in a Slack thread (set "slackThread" to "CHANNEL_ID:THREAD_TS") — this enables automatic routing of follow-up thread messages to your session. Set a value to null to remove it.',
    { updates: z.record(z.string(), z.union([z.string(), z.null()])).describe('Key-value pairs to set (e.g. { "pr": "https://github.com/owner/repo/pull/123", "branch": "feat/my-branch", "slackThread": "CHANNEL_ID:THREAD_TS", "plan": "/path/to/plan.md" })') },
    async ({ updates }) => {
      try {
        const resp = await sendRequest('mcp:set_context', { updates });
        return { content: [{ type: 'text', text: resp.ok ? `Context updated: ${JSON.stringify(resp.context)}` : (resp.error || 'Failed') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Tool: hive_set_working_dir
if (!enabledTools || enabledTools.includes('hive_set_working_dir')) {
  server.tool(
    'hive_set_working_dir',
    'Tell hive which git repository you are actually working in. Use this when you are working in a directory different from your default repo (e.g. a git worktree). This enables the hive dashboard to show the correct git diff and commit history for your session.',
    { dir: z.string().describe('Absolute path to the git repository you are working in (e.g. "/Users/me/projects/webplatform-worktree/DEV-123")') },
    async ({ dir }) => {
      try {
        const resp = await sendRequest('mcp:set_working_dir', { dir });
        return { content: [{ type: 'text', text: resp.ok ? `Working directory set to ${resp.dir}` : (resp.error || 'Failed') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}


// Tool: hive_create_task
if (!enabledTools || enabledTools.includes('hive_create_task')) {
  server.tool(
    'hive_create_task',
    'Create a new task in the hive queue for another session to pick up. Use this when you identify actionable work that needs to be done by a worker session.',
    {
      text: z.string().describe('Task description with full context'),
      designation: z.string().optional().describe('Routing designation — leave empty/omit to let any idle session pick it up. Only set if you know the exact designation name.'),
      slackChannel: z.string().optional().describe('Slack channel ID for thread routing'),
      slackThreadTs: z.string().optional().describe('Slack thread timestamp for follow-up routing'),
      requireHumanClose: z.boolean().optional().describe('Require human approval to complete'),
      targetSession: z.number().optional().describe('Specific session number to dispatch to'),
    },
    async ({ text, designation, slackChannel, slackThreadTs, requireHumanClose, targetSession }) => {
      try {
        const resp = await sendRequest('mcp:create_task', {
          text, designation, slackChannel, slackThreadTs, requireHumanClose, targetSession,
        });
        if (resp.ok) {
          return { content: [{ type: 'text', text: `Task created: #${resp.taskId}` }] };
        }
        return { content: [{ type: 'text', text: resp.error || 'Failed to create task' }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// ── Start ─────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
