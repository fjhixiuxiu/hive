import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';
import plansStore from '../../../src/core/plans-store.js';
import { createMockNode, createMockConfig } from '../../helpers/mocks.js';

const SAMPLE_HTML = `<!DOCTYPE html><html><body>
<section data-id="overview"><p>plan</p></section>
<script type="application/json" id="hive-comments">[]</script>
</body></html>`;

function makeDeps() {
  const config = createMockConfig();
  const node = createMockNode();
  const router = {
    getNode: () => node,
    findNodeForSession: () => 'local',
    nodeIds: () => ['local'],
    listAllSessions: vi.fn().mockResolvedValue([]),
  };
  const sent = [];
  const broadcasts = [];
  const ws = {
    send: vi.fn((data) => sent.push(JSON.parse(data))),
    readyState: 1,
  };
  // Live in-memory context map so the handler can read what it writes.
  const contexts = new Map();
  const taskQueue = {
    getSessionContext: vi.fn((num) => contexts.get(Number(num)) || {}),
    setSessionContext: vi.fn((num, updates) => {
      const existing = contexts.get(Number(num)) || {};
      const merged = { ...existing };
      for (const [k, v] of Object.entries(updates)) {
        if (v == null) delete merged[k]; else merged[k] = v;
      }
      contexts.set(Number(num), merged);
      return merged;
    }),
    getAllSessionContexts: vi.fn().mockReturnValue({}),
    activeTaskBySession: new Map(),
  };
  return {
    config, node, router, ws, sent, broadcasts, taskQueue, contexts,
    deps: {
      config, taskQueue, pmManager: null, router,
      broadcast: vi.fn((msg) => broadcasts.push(msg)),
      checkPermission: vi.fn().mockReturnValue(true),
      resolveSession: vi.fn(),
      clearTermSub: vi.fn(), clearConsoleSub: vi.fn(),
      termSubs: new Map(), consoleSubs: new Map(),
      clearCardSub: vi.fn(), clearAllCardSubs: vi.fn(),
      cardTermSubs: new Map(),
      sendFleetStatus: vi.fn(), broadcastFleetStatus: vi.fn(),
      sendInitialState: vi.fn(),
      _previewCache: new Map(),
      commands: new Map(),
      clients: new Set(), wsUser: new Map(),
      workers: new Map(), mcpClients: new Map(),
    },
  };
}

describe('mcp:publish_plan handler', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-plans-handler-'));
    process.env.HIVE_PLANS_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.HIVE_PLANS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('publishes a new plan, updates context, and broadcasts', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, {
      type: 'mcp:publish_plan',
      _reqId: 1,
      session: 3,
      html: SAMPLE_HTML,
      title: 'Plans feature',
    }, {});

    const resp = ctx.sent.find(m => m._reqId === 1);
    expect(resp).toBeDefined();
    expect(resp.ok).toBe(true);
    expect(resp.version).toBe(1);
    expect(resp.planId).toMatch(/^[a-f0-9]{8}$/);
    expect(resp.url).toBe(`/plans/${resp.planId}`);

    // Context updated with planRef
    const sessionCtx = ctx.contexts.get(3);
    expect(sessionCtx.planRef).toMatchObject({
      planId: resp.planId,
      version: 1,
      openCommentCount: 0,
      title: 'Plans feature',
    });

    // Broadcasts: context:updated and plan:published
    const planPublished = ctx.broadcasts.find(b => b.type === 'plan:published');
    expect(planPublished).toMatchObject({
      type: 'plan:published',
      session: 3,
      planRef: { planId: resp.planId, version: 1 },
    });
    expect(ctx.broadcasts.find(b => b.type === 'context:updated')).toBeDefined();

    // Plan file exists on disk
    expect(plansStore.getPlanHtml(resp.planId)).toContain('section data-id="overview"');
  });

  it('bumps the version when the same session republishes', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, {
      type: 'mcp:publish_plan', _reqId: 1, session: 5,
      html: SAMPLE_HTML, title: 'v1',
    }, {});
    const firstResp = ctx.sent.find(m => m._reqId === 1);

    await handler(ctx.ws, {
      type: 'mcp:publish_plan', _reqId: 2, session: 5,
      html: '<p>v2 content</p>',
    }, {});
    const secondResp = ctx.sent.find(m => m._reqId === 2);

    expect(secondResp.planId).toBe(firstResp.planId);
    expect(secondResp.version).toBe(2);

    // Context now points to v2
    expect(ctx.contexts.get(5).planRef.version).toBe(2);
  });

  it('rejects empty html', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, {
      type: 'mcp:publish_plan', _reqId: 1, session: 3, html: '',
    }, {});

    const resp = ctx.sent.find(m => m._reqId === 1);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/html is required/);
  });

  it('rejects when session cannot be resolved to a fleet number', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, {
      type: 'mcp:publish_plan', _reqId: 1, session: 'hive-console',
      html: SAMPLE_HTML,
    }, {});

    const resp = ctx.sent.find(m => m._reqId === 1);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/Cannot resolve session/);
  });
});

describe('mcp:reply_to_comment + mcp:resolve_comment handlers', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-plans-reply-'));
    process.env.HIVE_PLANS_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.HIVE_PLANS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reply_to_comment writes thread + broadcasts + responds ok', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    // Publish a plan for session 7 first
    await handler(ctx.ws, { type: 'mcp:publish_plan', _reqId: 1, session: 7, html: SAMPLE_HTML, title: 'P' }, {});
    const pub = ctx.sent.find(m => m._reqId === 1);
    expect(pub.ok).toBe(true);
    const planId = pub.planId;

    // Add a comment via the store directly (simulating user input)
    const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'why?' });

    // Claude replies
    await handler(ctx.ws, {
      type: 'mcp:reply_to_comment', _reqId: 2, session: 7,
      commentId: c.id, text: 'because Postgres',
    }, {});
    const resp = ctx.sent.find(m => m._reqId === 2);
    expect(resp.ok).toBe(true);
    expect(resp.comment.thread).toHaveLength(2);
    expect(resp.comment.thread[1].author).toBe('claude');

    // Broadcasts plan:comments-changed
    const changed = ctx.broadcasts.find(b => b.type === 'plan:comments-changed');
    expect(changed).toMatchObject({ type: 'plan:comments-changed', planId, hasPatch: false });
  });

  it('reply_to_comment with patch auto-resolves and flags hasPatch=true', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, { type: 'mcp:publish_plan', _reqId: 1, session: 7, html: SAMPLE_HTML, title: 'P' }, {});
    const planId = ctx.sent.find(m => m._reqId === 1).planId;
    const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'use redis?' });

    await handler(ctx.ws, {
      type: 'mcp:reply_to_comment', _reqId: 2, session: 7,
      commentId: c.id, text: 'switching',
      patch: { sectionId: 'overview', html: '<p>uses redis now</p>' },
    }, {});
    const resp = ctx.sent.find(m => m._reqId === 2);
    expect(resp.ok).toBe(true);
    expect(resp.comment.status).toBe('resolved');

    const changed = ctx.broadcasts.find(b => b.type === 'plan:comments-changed');
    expect(changed.hasPatch).toBe(true);
    // HTML was patched
    expect(plansStore.getPlanHtml(planId)).toContain('uses redis now');
  });

  it('reply_to_comment fails when session has no active plan', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, {
      type: 'mcp:reply_to_comment', _reqId: 1, session: 9,
      commentId: 'cabc', text: 'reply',
    }, {});
    const resp = ctx.sent.find(m => m._reqId === 1);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/no active plan/i);
  });

  it('resolve_comment marks resolved and broadcasts', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, { type: 'mcp:publish_plan', _reqId: 1, session: 7, html: SAMPLE_HTML, title: 'P' }, {});
    const planId = ctx.sent.find(m => m._reqId === 1).planId;
    const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'q' });
    // Flip to open so we can verify resolve transitions it
    plansStore.updateCommentStatus(planId, c.id, 'open');

    await handler(ctx.ws, {
      type: 'mcp:resolve_comment', _reqId: 2, session: 7,
      commentId: c.id, reason: 'agreed',
    }, {});
    const resp = ctx.sent.find(m => m._reqId === 2);
    expect(resp.ok).toBe(true);
    expect(resp.comment.status).toBe('resolved');
    expect(resp.comment.thread.at(-1)).toMatchObject({ author: 'claude', text: 'agreed' });
  });

  it('reply_to_comment fails for missing commentId', async () => {
    const ctx = makeDeps();
    const handler = createMessageHandler(ctx.deps);

    await handler(ctx.ws, { type: 'mcp:publish_plan', _reqId: 1, session: 7, html: SAMPLE_HTML, title: 'P' }, {});

    await handler(ctx.ws, {
      type: 'mcp:reply_to_comment', _reqId: 2, session: 7,
      commentId: 'cdoesnotexist', text: 'reply',
    }, {});
    const resp = ctx.sent.find(m => m._reqId === 2);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/not found/);
  });
});
