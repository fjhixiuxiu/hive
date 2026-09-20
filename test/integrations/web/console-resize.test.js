import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import {
  createFakeWs,
  findSent,
  createMockNode,
  createMockConfig,
  createMockWatcher,
} from '../../helpers/mocks.js';

// CJS interop: server.js uses require()
const require = createRequire(import.meta.url);
const fleet = require('../../../src/core/fleet.js');
const relay = require('../../../src/core/relay.js');
const auth = require('../../../src/core/auth.js');
const tmux = require('../../../src/core/tmux.js');
const log = require('../../../src/core/log.js');

// The Ask side panel's expand/collapse toggle relies on this server contract:
// every time the panel width changes, the frontend sends
//   { type: 'terminal:resize', session: 'hive-console', cols, rows }
// and the server must run `tmux resize-window -t hive-console -x cols -y rows`
// so the embedded Session 0 tmux pane matches the visible width.
//
// `resize-window` (not `resize-pane`) is required: hive-console is a
// single-pane detached session with no client attached. `tmux resize-pane`
// on a single-pane window is a no-op (the pane snaps to client/default
// window size). `resize-window` sets the window size directly, which sizes
// the only pane to match.
//
// This test pins that contract. If a future refactor breaks the path (wrong
// command, wrong target, dropped because no console sub), the expand toggle
// would silently stop syncing tmux — these tests catch it.
describe('terminal:resize for hive-console (Ask panel width sync)', () => {
  let config, node, router, serverHandle, wss;

  beforeAll(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    config = createMockConfig();
    node = createMockNode();
    router = {
      getNode: vi.fn().mockReturnValue(node),
      addNode: vi.fn(),
      removeNode: vi.fn(),
      nodeFor: vi.fn().mockReturnValue(node),
      listAllSessions: vi.fn().mockResolvedValue([]),
      allNodes: vi.fn().mockReturnValue([node]),
    };

    vi.spyOn(fleet, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleet, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleet, 'getNodeConfig').mockImplementation((cfg) => cfg);
    vi.spyOn(fleet, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(fleet, 'peekSession').mockResolvedValue('');

    vi.spyOn(relay, 'ask').mockResolvedValue({ success: true });
    vi.spyOn(relay, 'tell').mockResolvedValue({ success: true });

    vi.spyOn(auth, 'isOAuthEnabled').mockReturnValue(false);
    vi.spyOn(auth, 'wireAuthRoutes').mockImplementation(() => {});
    vi.spyOn(auth, 'authenticateWebSocket').mockReturnValue({ authenticated: true, user: null });
    vi.spyOn(auth, 'verifyToken').mockReturnValue(null);
    vi.spyOn(auth, 'parseCookie').mockReturnValue(null);

    // hive-console session resolves locally — required for the subscribe step
    // that registers the console subscription the resize handler depends on.
    vi.spyOn(tmux, 'hasSession').mockResolvedValue(true);

    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});

    const port = 30000 + Math.floor(Math.random() * 30000);
    process.env.WEB_PORT = String(port);
    process.env.WEB_TOKEN = 'test-token';

    const { createWebServer } = require('../../../src/integrations/web/server.js');
    const watcher = createMockWatcher();
    serverHandle = createWebServer(config, watcher, null, null, router);
    wss = serverHandle.wss;

    await vi.advanceTimersByTimeAsync(100);
  });

  afterAll(() => {
    if (serverHandle) serverHandle.close();
    delete process.env.WEB_TOKEN;
    delete process.env.WEB_PORT;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  let ws;

  beforeEach(async () => {
    node.exec.mockClear();
    node.exec.mockResolvedValue('');
    node.sendKeys.mockClear();
    node.sendKeys.mockResolvedValue();
    router.getNode.mockReturnValue(node);

    ws = createFakeWs();
    wss.emit('connection', ws, { headers: {} });
    ws.emit('message', JSON.stringify({ type: 'auth', token: 'test-token' }));
    await vi.advanceTimersByTimeAsync(50);

    // Register the console subscription that terminal:resize requires
    ws.emit(
      'message',
      JSON.stringify({ type: 'terminal:subscribe', session: 'hive-console', cols: 80, rows: 24 }),
    );
    await vi.advanceTimersByTimeAsync(50);
    node.exec.mockClear();
    ws.send.mockClear();
  });

  afterEach(() => {
    if (ws) ws.emit('close');
  });

  it('runs `tmux resize-window` on the hive-console session with the supplied cols/rows', async () => {
    ws.emit(
      'message',
      JSON.stringify({ type: 'terminal:resize', session: 'hive-console', cols: 220, rows: 50 }),
    );
    await vi.advanceTimersByTimeAsync(50);

    const resizeCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('resize-window'));
    expect(resizeCall).toBeTruthy();
    // Window form (trailing colon): a bare "=hive-console" target-window is
    // looked up as a *window named* hive-console in the current session first.
    expect(resizeCall[0]).toContain('-t "=hive-console:"');
    expect(resizeCall[0]).toContain('-x 220');
    expect(resizeCall[0]).toContain('-y 50');
    // Specifically NOT resize-pane — that's a no-op on a single-pane detached session.
    const panePaneCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('resize-pane'));
    expect(panePaneCall).toBeUndefined();
  });

  it('runs resize-window with the larger cols on expand, then the smaller cols on collapse', async () => {
    // Expand
    ws.emit(
      'message',
      JSON.stringify({ type: 'terminal:resize', session: 'hive-console', cols: 220, rows: 50 }),
    );
    await vi.advanceTimersByTimeAsync(50);
    // Collapse
    ws.emit(
      'message',
      JSON.stringify({ type: 'terminal:resize', session: 'hive-console', cols: 110, rows: 50 }),
    );
    await vi.advanceTimersByTimeAsync(50);

    const resizeCalls = node.exec.mock.calls.filter(([cmd]) => cmd.includes('resize-window'));
    expect(resizeCalls).toHaveLength(2);
    expect(resizeCalls[0][0]).toContain('-x 220');
    expect(resizeCalls[1][0]).toContain('-x 110');
    // Both must target hive-console — never leaks to fleet sessions
    expect(resizeCalls[0][0]).toContain('-t "=hive-console:"');
    expect(resizeCalls[1][0]).toContain('-t "=hive-console:"');
  });

  it('ignores resize without an active subscription', async () => {
    // Drop the subscription
    ws.emit('message', JSON.stringify({ type: 'terminal:unsubscribe', session: 'hive-console' }));
    await vi.advanceTimersByTimeAsync(50);
    node.exec.mockClear();

    ws.emit(
      'message',
      JSON.stringify({ type: 'terminal:resize', session: 'hive-console', cols: 220, rows: 50 }),
    );
    await vi.advanceTimersByTimeAsync(50);

    const resizeCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('resize-window'));
    expect(resizeCall).toBeUndefined();
  });

  it('ignores resize with zero/missing cols (defensive against bad client input)', async () => {
    ws.emit(
      'message',
      JSON.stringify({ type: 'terminal:resize', session: 'hive-console', cols: 0, rows: 50 }),
    );
    ws.emit(
      'message',
      JSON.stringify({ type: 'terminal:resize', session: 'hive-console', rows: 50 }),
    );
    await vi.advanceTimersByTimeAsync(50);

    const resizeCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('resize-window'));
    expect(resizeCall).toBeUndefined();
  });
});
