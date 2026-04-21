import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createFakeWs, sentMessages, findSent, createMockNode, createMockConfig, createMockWatcher } from '../../helpers/mocks.js';

// ---------------------------------------------------------------------------
// CJS interop: server.js uses require(), so we must get the same module
// objects that CJS require() returns in order to spy on them.
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const fleet = require('../../../src/core/fleet.js');
const relay = require('../../../src/core/relay.js');
const auth = require('../../../src/core/auth.js');
const log = require('../../../src/core/log.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('multi-pane terminal viewer', () => {
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

    // Spy on real CJS modules so server.js sees our overrides
    vi.spyOn(fleet, 'findSession').mockResolvedValue({ name: '6-DEV-123', nodeId: 'local' });
    vi.spyOn(fleet, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleet, 'sessionNum').mockReturnValue(6);
    vi.spyOn(fleet, 'getNodeConfig').mockImplementation((cfg) => cfg);
    vi.spyOn(fleet, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(fleet, 'peekSession').mockResolvedValue('');

    vi.spyOn(relay, 'ask').mockResolvedValue({ success: true, response: 'ok' });
    vi.spyOn(relay, 'tell').mockResolvedValue({ success: true });

    vi.spyOn(auth, 'isOAuthEnabled').mockReturnValue(false);
    vi.spyOn(auth, 'wireAuthRoutes').mockImplementation(() => {});
    vi.spyOn(auth, 'authenticateWebSocket').mockReturnValue({ authenticated: true, user: null });
    vi.spyOn(auth, 'verifyToken').mockReturnValue(null);
    vi.spyOn(auth, 'parseCookie').mockReturnValue(null);

    // Silence log output
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
    // Reset call history and restore default implementations
    node.exec.mockClear();
    node.exec.mockResolvedValue('');
    node.sendKeys.mockClear();
    node.sendKeys.mockResolvedValue();
    relay.tell.mockClear();
    relay.tell.mockResolvedValue({ success: true });
    relay.ask.mockClear();
    fleet.findSession.mockClear();
    fleet.findSession.mockResolvedValue({ name: '6-DEV-123', nodeId: 'local' });
    router.getNode.mockReturnValue(node);

    // Authenticate a fresh fake WebSocket
    ws = createFakeWs();
    wss.emit('connection', ws, { headers: {} });
    ws.emit('message', JSON.stringify({ type: 'auth', token: 'test-token' }));

    // Let auth + initial state messages flush
    await vi.advanceTimersByTimeAsync(50);
    ws.send.mockClear();
  });

  afterEach(() => {
    if (ws) ws.emit('close');
  });

  // =====================================================================
  // terminal:panes
  // =====================================================================

  describe('terminal:panes', () => {
    it('returns pane list with claudePane marked active', async () => {
      node.exec.mockResolvedValue('0|zsh\n1|claude\n2|node');

      ws.emit('message', JSON.stringify({ type: 'terminal:panes', session: 6 }));
      await vi.advanceTimersByTimeAsync(50);

      const paneMsg = findSent(ws, 'terminal:panes');

      expect(paneMsg).toBeTruthy();
      expect(paneMsg.session).toBe(6);
      expect(paneMsg.panes).toHaveLength(3);
      expect(paneMsg.claudePane).toBe(config.sessions.claudePane);

      const claudeEntry = paneMsg.panes.find((p) => p.index === 1);
      expect(claudeEntry.active).toBe(true);
      expect(claudeEntry.command).toBe('claude');

      expect(paneMsg.panes.find((p) => p.index === 0).active).toBe(false);
      expect(paneMsg.panes.find((p) => p.index === 2).active).toBe(false);
    });

    it('returns empty array when exec throws (error handling)', async () => {
      node.exec.mockRejectedValue(new Error('tmux error'));

      ws.emit('message', JSON.stringify({ type: 'terminal:panes', session: 6 }));
      await vi.advanceTimersByTimeAsync(50);

      const paneMsg = findSent(ws, 'terminal:panes');

      expect(paneMsg).toBeTruthy();
      expect(paneMsg.panes).toEqual([]);
      expect(paneMsg.claudePane).toBe(config.sessions.claudePane);
    });

    it('sends error when session is not found', async () => {
      fleet.findSession.mockResolvedValue(null);

      ws.emit('message', JSON.stringify({ type: 'terminal:panes', session: 99 }));
      await vi.advanceTimersByTimeAsync(50);

      const errMsg = findSent(ws, 'error');
      expect(errMsg).toBeTruthy();
      expect(errMsg.message).toContain('99');
    });

    it('parses panes with empty commands as unknown', async () => {
      node.exec.mockResolvedValue('0|\n1|claude');

      ws.emit('message', JSON.stringify({ type: 'terminal:panes', session: 6 }));
      await vi.advanceTimersByTimeAsync(50);

      const paneMsg = findSent(ws, 'terminal:panes');

      expect(paneMsg.panes).toHaveLength(2);
      expect(paneMsg.panes[0].command).toBe('unknown');
      expect(paneMsg.panes[1].command).toBe('claude');
    });

    it('handles single pane output', async () => {
      node.exec.mockResolvedValue('1|claude');

      ws.emit('message', JSON.stringify({ type: 'terminal:panes', session: 6 }));
      await vi.advanceTimersByTimeAsync(50);

      const paneMsg = findSent(ws, 'terminal:panes');

      expect(paneMsg.panes).toHaveLength(1);
      expect(paneMsg.panes[0].index).toBe(1);
      expect(paneMsg.panes[0].active).toBe(true);
    });

    it('handles empty exec output gracefully', async () => {
      node.exec.mockResolvedValue('');

      ws.emit('message', JSON.stringify({ type: 'terminal:panes', session: 6 }));
      await vi.advanceTimersByTimeAsync(50);

      const paneMsg = findSent(ws, 'terminal:panes');
      expect(paneMsg).toBeTruthy();
      expect(paneMsg.panes).toEqual([]);
    });
  });

  // =====================================================================
  // terminal:subscribe with pane parameter
  // =====================================================================

  describe('terminal:subscribe', () => {
    it('uses claudePane by default when no pane specified (backward compat)', async () => {
      node.exec.mockResolvedValue('terminal content');

      ws.emit('message', JSON.stringify({ type: 'terminal:subscribe', session: 6 }));
      await vi.advanceTimersByTimeAsync(50);

      const dataMsg = findSent(ws, 'terminal:data');

      expect(dataMsg).toBeTruthy();
      expect(dataMsg.pane).toBe(config.sessions.claudePane);
      expect(dataMsg.session).toBe(6);

      const captureCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('capture-pane'));
      expect(captureCall[0]).toContain(`.${config.sessions.claudePane}`);
    });

    it('uses explicit pane when specified', async () => {
      node.exec.mockResolvedValue('shell output');

      ws.emit('message', JSON.stringify({ type: 'terminal:subscribe', session: 6, pane: 0 }));
      await vi.advanceTimersByTimeAsync(50);

      const dataMsg = findSent(ws, 'terminal:data');

      expect(dataMsg).toBeTruthy();
      expect(dataMsg.pane).toBe(0);

      const captureCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('capture-pane'));
      expect(captureCall[0]).toContain('.0');
    });

    it('terminal:data responses include pane index', async () => {
      node.exec.mockResolvedValue('pane2 content');

      ws.emit('message', JSON.stringify({ type: 'terminal:subscribe', session: 6, pane: 2 }));
      await vi.advanceTimersByTimeAsync(50);

      const dataMsg = findSent(ws, 'terminal:data');
      expect(dataMsg.pane).toBe(2);
      expect(dataMsg.content).toBeTruthy();
    });

    it('polling interval sends terminal:data with correct pane index', async () => {
      let callCount = 0;
      node.exec.mockImplementation(() => {
        callCount++;
        return Promise.resolve(`content-${callCount}`);
      });

      ws.emit('message', JSON.stringify({ type: 'terminal:subscribe', session: 6, pane: 2 }));
      await vi.advanceTimersByTimeAsync(50);
      ws.send.mockClear();

      await vi.advanceTimersByTimeAsync(2100);

      const dataMsgs = sentMessages(ws).filter((m) => m.type === 'terminal:data');

      expect(dataMsgs.length).toBeGreaterThanOrEqual(1);
      dataMsgs.forEach((m) => {
        expect(m.pane).toBe(2);
        expect(m.session).toBe(6);
      });
    });

    it('sends error when session is not found', async () => {
      fleet.findSession.mockResolvedValue(null);

      ws.emit('message', JSON.stringify({ type: 'terminal:subscribe', session: 99 }));
      await vi.advanceTimersByTimeAsync(50);

      const errMsg = findSent(ws, 'error');
      expect(errMsg).toBeTruthy();
    });

    it('clears previous subscription when subscribing again', async () => {
      node.exec.mockResolvedValue('content');

      ws.emit('message', JSON.stringify({ type: 'terminal:subscribe', session: 6, pane: 0 }));
      await vi.advanceTimersByTimeAsync(50);
      ws.send.mockClear();

      ws.emit('message', JSON.stringify({ type: 'terminal:subscribe', session: 6, pane: 2 }));
      await vi.advanceTimersByTimeAsync(50);
      ws.send.mockClear();

      await vi.advanceTimersByTimeAsync(2100);

      const dataMsgs = sentMessages(ws).filter((m) => m.type === 'terminal:data');
      dataMsgs.forEach((m) => {
        expect(m.pane).toBe(2);
      });
    });
  });

  // =====================================================================
  // keys with pane parameter
  // =====================================================================

  describe('keys', () => {
    it('routes to claudePane when no pane specified (backward compat)', async () => {
      ws.emit('message', JSON.stringify({ type: 'keys', session: 6, keys: ['Enter'] }));
      await vi.advanceTimersByTimeAsync(50);

      const sendKeyCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('send-keys'));
      expect(sendKeyCall).toBeTruthy();
      expect(sendKeyCall[0]).toContain(`.${config.sessions.claudePane}`);

      const doneMsg = findSent(ws, 'keys:done');
      expect(doneMsg).toBeTruthy();
    });

    it('routes to specified pane when pane is set', async () => {
      ws.emit('message', JSON.stringify({ type: 'keys', session: 6, pane: 2, keys: ['Up'] }));
      await vi.advanceTimersByTimeAsync(50);

      const sendKeyCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('send-keys'));
      expect(sendKeyCall).toBeTruthy();
      expect(sendKeyCall[0]).toContain('.2');
    });

    it('routes to pane 0 explicitly', async () => {
      ws.emit('message', JSON.stringify({ type: 'keys', session: 6, pane: 0, keys: ['Enter'] }));
      await vi.advanceTimersByTimeAsync(50);

      const sendKeyCall = node.exec.mock.calls.find(([cmd]) => cmd.includes('send-keys'));
      expect(sendKeyCall).toBeTruthy();
      expect(sendKeyCall[0]).toContain('.0');
    });

    it('sends multiple keys in sequence', async () => {
      ws.emit('message', JSON.stringify({ type: 'keys', session: 6, pane: 0, keys: ['Escape', 'Enter'] }));
      await vi.advanceTimersByTimeAsync(50);

      const sendKeyCalls = node.exec.mock.calls.filter(([cmd]) => cmd.includes('send-keys'));
      expect(sendKeyCalls).toHaveLength(2);
      expect(sendKeyCalls[0][0]).toContain('Escape');
      expect(sendKeyCalls[1][0]).toContain('Enter');
    });

    it('handles empty keys array gracefully', async () => {
      ws.emit('message', JSON.stringify({ type: 'keys', session: 6, keys: [] }));
      await vi.advanceTimersByTimeAsync(50);

      const doneMsg = findSent(ws, 'keys:done');
      expect(doneMsg).toBeTruthy();
    });

    it('sends error when session is not found', async () => {
      fleet.findSession.mockResolvedValue(null);

      ws.emit('message', JSON.stringify({ type: 'keys', session: 99, keys: ['Enter'] }));
      await vi.advanceTimersByTimeAsync(50);

      const errMsg = findSent(ws, 'error');
      expect(errMsg).toBeTruthy();
    });
  });

  // =====================================================================
  // tell with pane parameter
  // =====================================================================

  describe('tell', () => {
    it('uses relay when no pane is specified (backward compat)', async () => {
      ws.emit('message', JSON.stringify({ type: 'tell', session: 6, message: 'hello' }));
      await vi.advanceTimersByTimeAsync(50);

      expect(relay.tell).toHaveBeenCalled();
      expect(node.sendKeys).not.toHaveBeenCalled();

      const doneMsg = findSent(ws, 'tell:done');
      expect(doneMsg).toBeTruthy();
      expect(doneMsg.success).toBe(true);
    });

    it('uses relay when pane equals claudePane', async () => {
      ws.emit('message', JSON.stringify({
        type: 'tell',
        session: 6,
        message: 'hello claude',
        pane: config.sessions.claudePane,
      }));
      await vi.advanceTimersByTimeAsync(50);

      expect(relay.tell).toHaveBeenCalled();
      expect(node.sendKeys).not.toHaveBeenCalled();
    });

    it('uses sendKeys directly when pane differs from claudePane', async () => {
      ws.emit('message', JSON.stringify({
        type: 'tell',
        session: 6,
        message: 'ls -la',
        pane: 0,
      }));
      await vi.advanceTimersByTimeAsync(50);

      expect(relay.tell).not.toHaveBeenCalled();
      expect(node.sendKeys).toHaveBeenCalledWith(
        '6-DEV-123:.0',
        'ls -la',
        true,
      );

      const doneMsg = findSent(ws, 'tell:done');
      expect(doneMsg).toBeTruthy();
      expect(doneMsg.success).toBe(true);
    });

    it('uses sendKeys for pane 2 (non-claude)', async () => {
      ws.emit('message', JSON.stringify({
        type: 'tell',
        session: 6,
        message: 'npm start',
        pane: 2,
      }));
      await vi.advanceTimersByTimeAsync(50);

      expect(relay.tell).not.toHaveBeenCalled();
      expect(node.sendKeys).toHaveBeenCalledWith(
        '6-DEV-123:.2',
        'npm start',
        true,
      );
    });

    it('returns error when sendKeys fails for non-claude pane', async () => {
      node.sendKeys.mockRejectedValue(new Error('tmux send-keys failed'));

      ws.emit('message', JSON.stringify({
        type: 'tell',
        session: 6,
        message: 'some command',
        pane: 2,
      }));
      await vi.advanceTimersByTimeAsync(50);

      const doneMsg = findSent(ws, 'tell:done');
      expect(doneMsg).toBeTruthy();
      expect(doneMsg.success).toBe(false);
      expect(doneMsg.error).toContain('tmux send-keys failed');
    });

    it('sends error when session is not found', async () => {
      fleet.findSession.mockResolvedValue(null);

      ws.emit('message', JSON.stringify({ type: 'tell', session: 99, message: 'hello' }));
      await vi.advanceTimersByTimeAsync(50);

      const errMsg = findSent(ws, 'error');
      expect(errMsg).toBeTruthy();
    });

    it('passes vimMode false when taskQueue is null', async () => {
      ws.emit('message', JSON.stringify({ type: 'tell', session: 6, message: 'test' }));
      await vi.advanceTimersByTimeAsync(50);

      expect(relay.tell).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '6-DEV-123',
        'test',
        expect.objectContaining({ vimMode: false }),
      );
    });

    it('falls through to relay when pane is a string (type check)', async () => {
      ws.emit('message', JSON.stringify({
        type: 'tell',
        session: 6,
        message: 'test',
        pane: '0',
      }));
      await vi.advanceTimersByTimeAsync(50);

      expect(relay.tell).toHaveBeenCalled();
      expect(node.sendKeys).not.toHaveBeenCalled();
    });
  });
});
