import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMockConfig, createMockNode, createMockWatcher } from '../../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fleet = require('../../../src/core/fleet.js');
const relay = require('../../../src/core/relay.js');
const auth = require('../../../src/core/auth.js');
const log = require('../../../src/core/log.js');
const plansStore = require('../../../src/core/plans-store.js');
const tqFeatures = require('../../../src/core/tq-features.js');
const createMessageHandler = require('../../../src/integrations/web/ws-handlers.js');
const { setupPath } = require('../../../src/integrations/web/ws-helpers.js');

// ---------------------------------------------------------------------------
// Plan comments go to the session that OWNS the plan, not the one that
// published v1.
//
// A plan outlives its author: the PR-watch PM seeds a plan's planRef into the
// next task's context seed, so the session doing the work is frequently one
// that never published a version. Routing off meta.sessionId delivered a
// reviewer's comments to the previous owner — which silently interrupted that
// session's unrelated work and left the real owner waiting.
// ---------------------------------------------------------------------------

const SAMPLE_HTML = `<!DOCTYPE html><html><body>
<section data-id="decisions"><p>plan</p></section>
<script type="application/json" id="hive-comments">[]</script>
</body></html>`;

let contexts = {};
// Node id → node, read by the router. Tests add a remote node here.
let nodes = {};
let taskQueue;

function makeTaskQueueStub() {
  return {
    vimMode: false,
    taskAutoComplete: false,
    agentFilesList: [],
    agentRoots: [],
    tasks: new Map(),
    activeTaskBySession: new Map(),
    getWorkStates: () => [],
    getTasksList: () => [],
    getAutoSessions: () => [],
    getPendingApprovals: () => [],
    getFeed: () => ({ entries: [], hasMore: false }),
    getRules: () => [],
    getDesignations: () => ({}),
    getRepoCaps: () => ({}),
    getDesignationDefs: () => [],
    getAgentRoots: () => [],
    getChecklistTemplates: () => [],
    getSpawnedAgentsList: () => [],
    getUsersList: () => [],
    getAllSessionContexts: () => contexts,
    setSessionContext: (num, updates) => ({ ...(contexts[num] || {}), ...updates }),
    getUser: () => ({ permissions: ['admin'] }),
    ensureUser: () => {},
    hasPermission: () => true,
    on: () => {},
    emit: () => {},
  };
}

describe('plan comment routing', () => {
  let serverHandle, port, tmpDir;
  let setupFileCreated = false;

  beforeAll(async () => {
    if (!fs.existsSync(setupPath)) {
      fs.writeFileSync(setupPath, '{}');
      setupFileCreated = true;
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-plan-routing-'));
    process.env.HIVE_PLANS_DIR = tmpDir;

    const config = createMockConfig();
    const node = createMockNode();
    nodes = { local: node };
    const router = {
      getNode: vi.fn((id) => nodes[id] || null),
      nodeFor: vi.fn().mockReturnValue(node),
      listAllSessions: vi.fn().mockResolvedValue([]),
      allNodes: vi.fn().mockReturnValue([node]),
      addNode: vi.fn(),
      removeNode: vi.fn(),
    };

    vi.spyOn(fleet, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleet, 'getNodeConfig').mockImplementation((cfg) => cfg);
    vi.spyOn(fleet, 'invalidateCache').mockImplementation(() => {});
    // Any session number resolves to a live pane on the local node.
    vi.spyOn(fleet, 'findSession').mockImplementation(async (_cfg, _router, query) => ({
      name: String(query),
      nodeId: 'local',
    }));
    vi.spyOn(relay, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(auth, 'isOAuthEnabled').mockReturnValue(false);
    vi.spyOn(auth, 'wireAuthRoutes').mockImplementation(() => {});

    port = 55000 + Math.floor(Math.random() * 4000);
    process.env.WEB_PORT = String(port);
    process.env.WEB_TOKEN = 'test-token';
    process.env.WEB_BIND = '127.0.0.1';

    const { createWebServer } = require('../../../src/integrations/web/server.js');
    taskQueue = makeTaskQueueStub();
    serverHandle = createWebServer(config, createMockWatcher(), taskQueue, null, router);
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(() => {
    if (serverHandle) serverHandle.close();
    delete process.env.WEB_TOKEN;
    delete process.env.WEB_PORT;
    delete process.env.WEB_BIND;
    delete process.env.HIVE_PLANS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    if (setupFileCreated) {
      try {
        fs.unlinkSync(setupPath);
      } catch {}
    }
  });

  beforeEach(() => {
    contexts = {};
    relay.tell.mockClear();
  });

  async function publishWithDraft(sessionNum) {
    const { planId } = plansStore.publishPlan({
      sessionNum,
      html: SAMPLE_HTML,
      title: 'Pay Stubs',
    });
    await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionId: 'decisions', text: 'Is anyone doing this right?' }),
    });
    return planId;
  }

  it('sends to the session that pins the plan, not the one that published it', async () => {
    const planId = await publishWithDraft(10);
    contexts = { 12: { planRef: { planId, version: 2 } } };

    const res = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
      method: 'POST',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ sent: 1, session: 12 });
    expect(relay.tell).toHaveBeenCalledTimes(1);
    expect(relay.tell.mock.calls[0][2]).toBe('12'); // session name the relay targeted
  });

  it('falls back to the publisher when no session pins the plan', async () => {
    const planId = await publishWithDraft(10);
    contexts = {};

    const res = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
      method: 'POST',
    });
    const body = await res.json();

    expect(body).toMatchObject({ sent: 1, session: 10 });
    expect(relay.tell.mock.calls[0][2]).toBe('10');
  });

  it('keeps the publisher when it still pins the plan alongside another session', async () => {
    const planId = await publishWithDraft(10);
    contexts = {
      10: { planRef: { planId } },
      12: { planRef: { planId } },
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
      method: 'POST',
    });
    expect((await res.json()).session).toBe(10);
  });

  it('reports the owning session in the plan meta the editor renders', async () => {
    const planId = await publishWithDraft(10);
    contexts = { 12: { planRef: { planId } } };

    const meta = await (await fetch(`http://127.0.0.1:${port}/api/plans/${planId}`)).json();
    expect(meta.sessionId).toBe(12);
    expect(meta.publishedBySessionId).toBe(10);
  });

  it('reports the owning session in the plans index too', async () => {
    const planId = await publishWithDraft(10);
    contexts = { 12: { planRef: { planId } } };

    const { plans } = await (await fetch(`http://127.0.0.1:${port}/api/plans?status=all`)).json();
    const row = plans.find((p) => p.id === planId);
    expect(row.sessionId).toBe(12);
    expect(row.publishedBySessionId).toBe(10);
  });

  it('filters the index by the owning session, matching the sessionId each row reports', async () => {
    const planId = await publishWithDraft(10);
    contexts = { 12: { planRef: { planId } } };

    const idsFor = async (session) => {
      const url = `http://127.0.0.1:${port}/api/plans?status=all&session=${session}`;
      const { plans } = await (await fetch(url)).json();
      return plans.map((p) => p.id);
    };
    expect(await idsFor(12)).toContain(planId);
    expect(await idsFor(10)).not.toContain(planId);
  });

  it('picks the lowest-numbered pinner, and warns, when several pin it and the publisher does not', async () => {
    const planId = await publishWithDraft(10);
    contexts = {
      15: { planRef: { planId } },
      4: { planRef: { planId } },
      12: { planRef: { planId } },
    };
    log.warn.mockClear();

    const res = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
      method: 'POST',
    });
    expect((await res.json()).session).toBe(4);
    expect(relay.tell.mock.calls[0][2]).toBe('4');
    const warning = log.warn.mock.calls.map((c) => c[0]).find((m) => m.includes(planId));
    expect(warning).toContain('4, 12, 15');
  });

  it('ignores sessions pinning a different plan, or holding no planRef at all', async () => {
    const planId = await publishWithDraft(10);
    contexts = {
      3: { planRef: { planId: 'deadbeef' } },
      7: { pr: 'https://github.com/o/r/pull/1' },
      8: { planRef: null },
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
      method: 'POST',
    });
    expect((await res.json()).session).toBe(10);
  });

  it('routes a plan with no recorded publisher to its pinner, and 400s when nobody pins it', async () => {
    // Plans published with no session (sessionId: null in meta.json) had no
    // route at all. A live pin is now enough to reach one.
    const { planId } = plansStore.publishPlan({ html: SAMPLE_HTML, title: 'Orphan' });
    await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionId: 'decisions', text: 'who owns this?' }),
    });

    contexts = {};
    const orphan = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
      method: 'POST',
    });
    expect(orphan.status).toBe(400);
    expect(relay.tell).not.toHaveBeenCalled();

    contexts = { 12: { planRef: { planId } } };
    const pinned = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
      method: 'POST',
    });
    expect(await pinned.json()).toMatchObject({ sent: 1, session: 12 });
  });

  it('503s naming the owner, and leaves the drafts unsent, when the owner is not in the fleet', async () => {
    const planId = await publishWithDraft(10);
    contexts = { 12: { planRef: { planId } } };
    fleet.findSession.mockImplementationOnce(async () => null);

    const res = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
      method: 'POST',
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('Session 12');
    expect(relay.tell).not.toHaveBeenCalled();
    const statuses = plansStore.getComments(planId).map((c) => c.status);
    expect(statuses).toEqual(['draft']);
  });

  describe('owner on a remote node', () => {
    let remote;

    beforeEach(() => {
      remote = createMockNode('mac-mini');
      nodes['mac-mini'] = remote;
    });

    afterEach(() => {
      delete nodes['mac-mini'];
    });

    it('relays through the node the owning session lives on', async () => {
      const planId = await publishWithDraft(10);
      contexts = { 12: { planRef: { planId } } };
      fleet.findSession.mockImplementationOnce(async (_cfg, _router, query) => ({
        name: `${query}-remote`,
        nodeId: 'mac-mini',
      }));

      const res = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
        method: 'POST',
      });

      expect(await res.json()).toMatchObject({ sent: 1, session: 12 });
      expect(fleet.findSession.mock.lastCall[2]).toBe(12); // looked up the owner, not the publisher
      const [, node, name] = relay.tell.mock.calls[0];
      expect(node).toBe(remote);
      expect(name).toBe('12-remote');
      expect(plansStore.getComments(planId).map((c) => c.status)).toEqual(['open']);
    });

    it('503s naming the node, and leaves the drafts unsent, when that node is gone', async () => {
      const planId = await publishWithDraft(10);
      contexts = { 12: { planRef: { planId } } };
      delete nodes['mac-mini'];
      fleet.findSession.mockImplementationOnce(async () => ({ name: '12', nodeId: 'mac-mini' }));

      const res = await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, {
        method: 'POST',
      });

      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain('mac-mini');
      expect(relay.tell).not.toHaveBeenCalled();
      expect(plansStore.getComments(planId).map((c) => c.status)).toEqual(['draft']);
    });
  });

  describe('publish → handoff → republish, through the real handlers', () => {
    // Everything a PR-watch handoff relies on except the PM that seeds it:
    // the real mcp:publish_plan and mcp:set_context handlers, writing through
    // TaskQueue's own session-context functions, read back by the send route.
    // The handoff is mcp:set_context — the same setSessionContext write the
    // dispatch seed performs — and the old owner finishing its task is the
    // clearSessionContext that task completion runs.
    let real, originals, mcp;

    beforeEach(() => {
      real = {
        sessionContext: new Map(),
        config: createMockConfig(),
        emit: () => {},
        _saveState: () => {},
      };
      originals = {
        getAllSessionContexts: taskQueue.getAllSessionContexts,
        setSessionContext: taskQueue.setSessionContext,
      };
      taskQueue.getSessionContext = tqFeatures.getSessionContext.bind(real);
      taskQueue.getAllSessionContexts = tqFeatures.getAllSessionContexts.bind(real);
      taskQueue.setSessionContext = tqFeatures.setSessionContext.bind(real);

      const sent = [];
      const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
      const handler = createMessageHandler({
        config: createMockConfig(),
        taskQueue,
        pmManager: null,
        router: { getNode: () => nodes.local, listAllSessions: vi.fn().mockResolvedValue([]) },
        broadcast: () => {},
        checkPermission: () => true,
        resolveSession: vi.fn(),
        clearTermSub: vi.fn(),
        clearConsoleSub: vi.fn(),
        termSubs: new Map(),
        consoleSubs: new Map(),
        clearCardSub: vi.fn(),
        clearAllCardSubs: vi.fn(),
        cardTermSubs: new Map(),
        sendFleetStatus: vi.fn(),
        broadcastFleetStatus: vi.fn(),
        sendInitialState: vi.fn(),
        _previewCache: new Map(),
        commands: new Map(),
        clients: new Set(),
        wsUser: new Map(),
        workers: new Map(),
        mcpClients: new Map(),
      });
      let reqId = 0;
      mcp = async (msg) => {
        const id = ++reqId;
        await handler(ws, { ...msg, _reqId: id }, {});
        return sent.find((m) => m._reqId === id);
      };
    });

    afterEach(() => {
      Object.assign(taskQueue, originals);
      delete taskQueue.getSessionContext; // the stub has none; only publish_plan reads it
    });

    const draft = (planId, text) =>
      fetch(`http://127.0.0.1:${port}/api/plans/${planId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId: 'decisions', text }),
      });
    const send = async (planId) =>
      (await fetch(`http://127.0.0.1:${port}/api/plans/${planId}/send`, { method: 'POST' })).json();

    it('routes to whoever holds the plan at every step, and keeps it there once the holder lets go', async () => {
      // S10 publishes v1.
      const v1 = await mcp({
        type: 'mcp:publish_plan',
        session: 10,
        html: SAMPLE_HTML,
        title: 'Pay Stubs',
      });
      expect(v1).toMatchObject({ ok: true, version: 1 });
      const { planId } = v1;

      // Handoff: the plan is pinned into S12, and S10 finishes its task.
      const pin = await mcp({
        type: 'mcp:set_context',
        session: 12,
        updates: { planRef: { planId, version: 1, title: 'Pay Stubs' } },
      });
      expect(pin.ok).toBe(true);
      tqFeatures.clearSessionContext.call(real, 10);

      // A reviewer comments before S12 has published anything.
      await draft(planId, 'first pass');
      expect(await send(planId)).toMatchObject({ sent: 1, session: 12 });
      const meta = await (await fetch(`http://127.0.0.1:${port}/api/plans/${planId}`)).json();
      expect(meta).toMatchObject({ sessionId: 12, publishedBySessionId: 10 });

      // S12 republishes: same plan, v2, and it is now the recorded publisher.
      const v2 = await mcp({ type: 'mcp:publish_plan', session: 12, html: SAMPLE_HTML });
      expect(v2).toMatchObject({ ok: true, planId, version: 2 });
      expect(real.sessionContext.get(12).planRef).toMatchObject({ planId, version: 2 });

      // S12 finishes too. Nobody pins the plan, so the route falls back to
      // meta.sessionId — which must now be S12, not the long-gone S10.
      tqFeatures.clearSessionContext.call(real, 12);
      await draft(planId, 'second pass');
      expect(await send(planId)).toMatchObject({ sent: 1, session: 12 });

      expect(relay.tell.mock.calls.map((c) => c[2])).toEqual(['12', '12']);
    });
  });
});
