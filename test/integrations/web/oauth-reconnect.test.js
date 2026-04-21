import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createFakeWs, sentMessages, findSent, createMockNode, createMockConfig, createMockWatcher } from '../../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fleet = require('../../../src/core/fleet.js');
const relay = require('../../../src/core/relay.js');
const auth = require('../../../src/core/auth.js');
const log = require('../../../src/core/log.js');

// ---------------------------------------------------------------------------
// OAuth WebSocket reconnection scenarios
//
// These tests verify the server-side auth behaviour that the client-side
// oauthMode fix relies on:
//   - valid cookie  → auth:ok immediately (no token message needed)
//   - expired cookie + empty token → auth:false + close
//   - /auth/me endpoint returns correct status for valid/invalid cookies
// ---------------------------------------------------------------------------

describe('OAuth WebSocket reconnection', () => {
  let config, node, router, serverHandle, wss, app;

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

    vi.spyOn(fleet, 'findSession').mockResolvedValue({ name: '1', nodeId: 'local' });
    vi.spyOn(fleet, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleet, 'sessionNum').mockReturnValue(1);
    vi.spyOn(fleet, 'getNodeConfig').mockImplementation((cfg) => cfg);
    vi.spyOn(fleet, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(fleet, 'peekSession').mockResolvedValue('');
    vi.spyOn(relay, 'ask').mockResolvedValue({ success: true, response: 'ok' });
    vi.spyOn(relay, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});

    // Enable OAuth mode
    vi.spyOn(auth, 'isOAuthEnabled').mockReturnValue(true);
    vi.spyOn(auth, 'wireAuthRoutes').mockImplementation(() => {});
    // Default: cookie invalid, WS auth fails (overridden per test)
    vi.spyOn(auth, 'parseCookie').mockReturnValue(null);
    vi.spyOn(auth, 'verifyToken').mockReturnValue(null);
    vi.spyOn(auth, 'authenticateWebSocket').mockReturnValue({ authenticated: false });

    const port = 30000 + Math.floor(Math.random() * 30000);
    process.env.WEB_PORT = String(port);
    process.env.WEB_TOKEN = 'test-token';

    const { createWebServer } = require('../../../src/integrations/web/server.js');
    const watcher = createMockWatcher();
    serverHandle = createWebServer(config, watcher, null, null, router);
    wss = serverHandle.wss;
    app = serverHandle.app;

    await vi.advanceTimersByTimeAsync(100);
  });

  afterAll(() => {
    if (serverHandle) serverHandle.close();
    delete process.env.WEB_TOKEN;
    delete process.env.WEB_PORT;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Reset to defaults for next test
    auth.parseCookie.mockReturnValue(null);
    auth.verifyToken.mockReturnValue(null);
    auth.authenticateWebSocket.mockReturnValue({ authenticated: false });
  });

  describe('WebSocket connection with valid OAuth cookie', () => {
    it('authenticates immediately via cookie without needing auth message', async () => {
      vi.spyOn(auth, 'parseCookie').mockReturnValue('valid-jwt');
      vi.spyOn(auth, 'verifyToken').mockReturnValue({
        sub: 'testuser', name: 'Test User', avatar: 'https://example.com/avatar.png',
      });

      const ws = createFakeWs();
      wss.emit('connection', ws, { headers: { cookie: 'hive_session=valid-jwt' } });
      await vi.advanceTimersByTimeAsync(50);

      const authMsg = findSent(ws, 'auth');
      expect(authMsg).toBeDefined();
      expect(authMsg.ok).toBe(true);
      expect(authMsg.user.login).toBe('testuser');
      // Connection should NOT be closed
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe('WebSocket reconnect with expired OAuth cookie', () => {
    it('sends auth:false when cookie is invalid and token is empty', async () => {
      // Simulate expired/invalid cookie
      vi.spyOn(auth, 'parseCookie').mockReturnValue('expired-jwt');
      vi.spyOn(auth, 'verifyToken').mockReturnValue(null);
      vi.spyOn(auth, 'authenticateWebSocket').mockReturnValue({ authenticated: false });

      const ws = createFakeWs();
      wss.emit('connection', ws, { headers: { cookie: 'hive_session=expired-jwt' } });
      await vi.advanceTimersByTimeAsync(50);

      // Client sends empty token (OAuth reconnect pattern)
      ws.emit('message', JSON.stringify({ type: 'auth', token: '' }));
      await vi.advanceTimersByTimeAsync(50);

      const authMsg = findSent(ws, 'auth');
      expect(authMsg).toBeDefined();
      expect(authMsg.ok).toBe(false);
      expect(ws.close).toHaveBeenCalled();
    });

    it('sends auth:false when cookie is missing entirely', async () => {
      vi.spyOn(auth, 'parseCookie').mockReturnValue(null);
      vi.spyOn(auth, 'verifyToken').mockReturnValue(null);
      vi.spyOn(auth, 'authenticateWebSocket').mockReturnValue({ authenticated: false });

      const ws = createFakeWs();
      wss.emit('connection', ws, { headers: {} });
      await vi.advanceTimersByTimeAsync(50);

      ws.emit('message', JSON.stringify({ type: 'auth', token: '' }));
      await vi.advanceTimersByTimeAsync(50);

      const authMsg = findSent(ws, 'auth');
      expect(authMsg).toBeDefined();
      expect(authMsg.ok).toBe(false);
    });
  });

  describe('WebSocket reconnect after server restart', () => {
    it('rejects old JWT when secret has changed (verifyToken returns null)', async () => {
      // Old JWT is syntactically valid but signed with old secret
      vi.spyOn(auth, 'parseCookie').mockReturnValue('old-secret-jwt');
      vi.spyOn(auth, 'verifyToken').mockReturnValue(null); // secret mismatch
      vi.spyOn(auth, 'authenticateWebSocket').mockReturnValue({ authenticated: false });

      const ws = createFakeWs();
      wss.emit('connection', ws, { headers: { cookie: 'hive_session=old-secret-jwt' } });
      await vi.advanceTimersByTimeAsync(50);

      // No immediate auth:ok since cookie is invalid
      const msgs = sentMessages(ws);
      const authOk = msgs.find(m => m.type === 'auth' && m.ok === true);
      expect(authOk).toBeUndefined();

      // Client sends empty token (OAuth reconnect)
      ws.emit('message', JSON.stringify({ type: 'auth', token: '' }));
      await vi.advanceTimersByTimeAsync(50);

      const authFail = sentMessages(ws).find(m => m.type === 'auth' && m.ok === false);
      expect(authFail).toBeDefined();
      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe('WEB_TOKEN still works in OAuth mode for MCP clients', () => {
    it('accepts WEB_TOKEN auth even when OAuth is enabled', async () => {
      vi.spyOn(auth, 'parseCookie').mockReturnValue(null);
      vi.spyOn(auth, 'verifyToken').mockReturnValue(null);

      const ws = createFakeWs();
      wss.emit('connection', ws, { headers: {} });
      await vi.advanceTimersByTimeAsync(50);

      // MCP/service client sends WEB_TOKEN
      ws.emit('message', JSON.stringify({ type: 'auth', token: 'test-token' }));
      await vi.advanceTimersByTimeAsync(50);

      const authMsg = sentMessages(ws).find(m => m.type === 'auth');
      expect(authMsg).toBeDefined();
      expect(authMsg.ok).toBe(true);
      expect(authMsg.user.login).toBe('__service__');
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe('auth timeout', () => {
    it('closes connection if no auth message within 5s when cookie is invalid', async () => {
      vi.spyOn(auth, 'parseCookie').mockReturnValue(null);
      vi.spyOn(auth, 'verifyToken').mockReturnValue(null);

      const ws = createFakeWs();
      wss.emit('connection', ws, { headers: {} });

      // Don't send any auth message — wait for timeout
      await vi.advanceTimersByTimeAsync(6000);

      const errorMsg = sentMessages(ws).find(m => m.type === 'error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toMatch(/auth timeout/i);
      expect(ws.close).toHaveBeenCalled();
    });
  });
});
