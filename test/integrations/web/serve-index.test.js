import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import { createMockConfig, createMockNode, createMockWatcher } from '../../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fleet = require('../../../src/core/fleet.js');
const auth = require('../../../src/core/auth.js');
const log = require('../../../src/core/log.js');
const { setupPath } = require('../../../src/integrations/web/ws-helpers.js');

// ---------------------------------------------------------------------------
// serveIndex — dynamic asset versioning + cache headers (PR #270)
//
// `/` and the `/ui/*` SPA fallback both serve index.html with `{{V}}` swapped
// for a mtime-derived asset version, and with no-store cache headers so the
// browser always re-fetches the shell. These tests pin both: the substitution
// fully resolves (no `{{V}}` leaks to the client) and the cache header is set.
// ---------------------------------------------------------------------------

function makeTaskQueueStub() {
  return {
    vimMode: false, taskAutoComplete: false, agentFilesList: [], agentRoots: [],
    getWorkStates: () => [], getTasksList: () => [], getAutoSessions: () => [],
    getPendingApprovals: () => [], getFeed: () => ({ entries: [], hasMore: false }),
    getRules: () => [], getDesignations: () => ({}), getRepoCaps: () => ({}),
    getDesignationDefs: () => [], getAgentRoots: () => [], getChecklistTemplates: () => [],
    getSpawnedAgentsList: () => [], getAllSessionContexts: () => ({}), getUsersList: () => [],
    getUser: () => ({ permissions: ['admin'] }), ensureUser: () => {}, hasPermission: () => true,
    on: () => {}, emit: () => {},
  };
}

describe('serveIndex asset versioning', () => {
  let serverHandle, port;
  let setupFileCreated = false;

  beforeAll(async () => {
    if (!fs.existsSync(setupPath)) {
      fs.writeFileSync(setupPath, '{}');
      setupFileCreated = true;
    }

    const config = createMockConfig();
    const node = createMockNode();
    const router = {
      getNode: vi.fn().mockReturnValue(node),
      nodeFor: vi.fn().mockReturnValue(node),
      listAllSessions: vi.fn().mockResolvedValue([]),
      allNodes: vi.fn().mockReturnValue([node]),
      addNode: vi.fn(), removeNode: vi.fn(),
    };

    vi.spyOn(fleet, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleet, 'getNodeConfig').mockImplementation((cfg) => cfg);
    vi.spyOn(fleet, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});

    // Token mode (OAuth off) — `/` is not auth-gated, so we can fetch it directly.
    vi.spyOn(auth, 'isOAuthEnabled').mockReturnValue(false);
    vi.spyOn(auth, 'wireAuthRoutes').mockImplementation(() => {});

    port = 55000 + Math.floor(Math.random() * 4000);
    process.env.WEB_PORT = String(port);
    process.env.WEB_TOKEN = 'test-token';
    process.env.WEB_BIND = '127.0.0.1'; // avoid binding the tailscale IP in CI

    const { createWebServer } = require('../../../src/integrations/web/server.js');
    const watcher = createMockWatcher();
    serverHandle = createWebServer(config, watcher, makeTaskQueueStub(), null, router);

    // Give the listener a tick to come up.
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(() => {
    if (serverHandle) serverHandle.close();
    delete process.env.WEB_TOKEN;
    delete process.env.WEB_PORT;
    delete process.env.WEB_BIND;
    vi.restoreAllMocks();
    if (setupFileCreated) {
      try { fs.unlinkSync(setupPath); } catch {}
    }
  });

  it('serves / with {{V}} fully substituted and no-store cache header', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).not.toContain('{{V}}'); // every placeholder resolved
    // Substitution produced a concrete numeric version on the asset refs.
    expect(body).toMatch(/\/app\.js\?v=\d+/);
    expect(body).toMatch(/\/styles\.css\?v=\d+/);
  });

  it('serves the /ui/* SPA fallback as the versioned index shell', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/ui/some/deep/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.text();
    expect(body).not.toContain('{{V}}');
    expect(body).toMatch(/\/app\.js\?v=\d+/);
  });

  it('uses a stable version across requests when assets do not change', async () => {
    const a = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const b = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const va = a.match(/\/app\.js\?v=(\d+)/)[1];
    const vb = b.match(/\/app\.js\?v=(\d+)/)[1];
    expect(va).toBe(vb); // mtime-derived, deterministic between requests
  });

  it('serves /session-links.js from src/core with a JS content-type', async () => {
    // Every chip in the app depends on this route; a 404 would blank the UI.
    // The file lives outside public/ so backend and browser share one source
    // (ws-handlers + tq-features both `require` it).
    const res = await fetch(`http://127.0.0.1:${port}/session-links.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/i);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.text();
    expect(body).toContain('function parsePrList');
    expect(body).toContain('function canonicalizePrRef');
    expect(body).toContain('root.SessionLinks'); // UMD attach for the browser
  });
});
