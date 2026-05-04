import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import EventEmitter from 'events';
import fs from 'fs';
import { createFakeWs, sentMessages, createMockNode, createMockConfig, createMockWatcher } from '../../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fleet = require('../../../src/core/fleet.js');
const auth = require('../../../src/core/auth.js');
const log = require('../../../src/core/log.js');
// `sendInitialState` short-circuits with `setup:required` unless this sentinel
// exists, so we ensure it's present for the duration of the test. Restore
// whatever was there afterwards so we don't pollute dev environments.
const { setupPath } = require('../../../src/integrations/web/ws-helpers.js');

// ---------------------------------------------------------------------------
// Send order on initial WebSocket state push.
//
// When the dashboard connects (or reconnects after a long idle), the server
// pushes a batch of state messages. Two of them are coupled:
//   - `designationDefs:list`  → the color/agent definitions
//   - `designations:status`   → which session is in which designation
//
// The client resolves a designation NAME → color via the defs cache. If
// `designations:status` is processed before `designationDefs:list`, the
// triggered re-render falls through to the orange fallback and labels lose
// their color until something else forces another render.
//
// Defs are the dependency, so the server must send them first.
// ---------------------------------------------------------------------------

function makeTaskQueueStub() {
  return Object.assign(new EventEmitter(), {
    vimMode: false,
    taskAutoComplete: false,
    agentFilesList: [],
    agentRoots: [],
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
    getAllSessionContexts: () => ({}),
    getUsersList: () => [],
    getUser: () => ({ permissions: ['admin'] }),
    ensureUser: () => {},
    hasPermission: () => true,
  });
}

describe('initial state send order', () => {
  let serverHandle, wss;
  let setupFileCreated = false;

  beforeAll(async () => {
    if (!fs.existsSync(setupPath)) {
      fs.writeFileSync(setupPath, '{}');
      setupFileCreated = true;
    }
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const config = createMockConfig();
    const node = createMockNode();
    const router = {
      getNode: vi.fn().mockReturnValue(node),
      addNode: vi.fn(),
      removeNode: vi.fn(),
      nodeFor: vi.fn().mockReturnValue(node),
      listAllSessions: vi.fn().mockResolvedValue([]),
      allNodes: vi.fn().mockReturnValue([node]),
    };

    vi.spyOn(fleet, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleet, 'getNodeConfig').mockImplementation((cfg) => cfg);
    vi.spyOn(fleet, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});

    // Plain token mode (OAuth disabled) keeps the auth path simple.
    vi.spyOn(auth, 'isOAuthEnabled').mockReturnValue(false);
    vi.spyOn(auth, 'wireAuthRoutes').mockImplementation(() => {});
    vi.spyOn(auth, 'authenticateWebSocket').mockReturnValue({
      authenticated: true,
      user: { login: 'tester', name: 'Tester', avatar: null },
    });

    // High range, non-overlapping with oauth-reconnect.test.js (30000–60000) to
    // avoid worker-parallel collisions (the server doesn't accept port 0).
    process.env.WEB_PORT = String(61000 + Math.floor(Math.random() * 4500));
    process.env.WEB_TOKEN = 'test-token';

    const { createWebServer } = require('../../../src/integrations/web/server.js');
    const watcher = createMockWatcher();
    serverHandle = createWebServer(config, watcher, makeTaskQueueStub(), null, router);
    wss = serverHandle.wss;

    await vi.advanceTimersByTimeAsync(50);
  });

  afterAll(() => {
    if (serverHandle) serverHandle.close();
    delete process.env.WEB_TOKEN;
    delete process.env.WEB_PORT;
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (setupFileCreated) {
      try { fs.unlinkSync(setupPath); } catch {}
    }
  });

  it('sends designationDefs:list before designations:status on the initial state push', async () => {
    const ws = createFakeWs();
    wss.emit('connection', ws, { headers: {} });
    await vi.advanceTimersByTimeAsync(10);

    // Authenticate as a regular client (sendInitialState fires after this).
    ws.emit('message', JSON.stringify({ type: 'auth', token: 'test-token' }));
    await vi.advanceTimersByTimeAsync(50);

    const types = sentMessages(ws).map((m) => m.type);
    const defsIdx = types.indexOf('designationDefs:list');
    const assignmentsIdx = types.indexOf('designations:status');

    expect(defsIdx, 'designationDefs:list must be sent').toBeGreaterThanOrEqual(0);
    expect(assignmentsIdx, 'designations:status must be sent').toBeGreaterThanOrEqual(0);
    expect(defsIdx, 'defs must precede assignments so the client cache is hot when the grid re-renders')
      .toBeLessThan(assignmentsIdx);
  });
});
