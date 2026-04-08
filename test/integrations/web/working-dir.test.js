import { describe, it, expect, vi, beforeEach } from 'vitest';

import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';
import { createMockNode, createMockConfig } from '../../helpers/mocks.js';

/**
 * Tests for the session working directory override feature.
 * When a Claude session reports a working dir via mcp:set_working_dir,
 * git operations should use that directory instead of the configured repoDir.
 */

// Minimal deps builder for createMessageHandler
function makeDeps(overrides = {}) {
  const config = createMockConfig();
  const node = createMockNode();
  // Sessions that the fleet module will discover
  const sessionsList = overrides.sessions || [
    { name: '3-test', nodeId: 'local', path: '/home/user/dev/session-3' },
  ];
  const router = {
    getNode: () => node,
    findNodeForSession: () => 'local',
    nodeIds: () => ['local'],
    listAllSessions: vi.fn().mockResolvedValue(sessionsList),
  };
  const sent = [];
  const broadcasts = [];
  const ws = {
    send: vi.fn((data) => sent.push(JSON.parse(data))),
    readyState: 1,
  };
  const taskQueue = {
    getSessionContext: vi.fn().mockReturnValue({}),
    setSessionContext: vi.fn().mockReturnValue({}),
    getAllSessionContexts: vi.fn().mockReturnValue({}),
    activeTaskBySession: new Map(),
  };
  return {
    config, node, router, ws, sent, broadcasts, taskQueue,
    deps: {
      config,
      taskQueue,
      pmManager: null,
      router,
      broadcast: vi.fn((msg) => broadcasts.push(msg)),
      checkPermission: vi.fn().mockReturnValue(true),
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
      ...overrides,
    },
  };
}

describe('working directory override', () => {
  let handleMessage, ctx;

  beforeEach(() => {
    ctx = makeDeps();
    handleMessage = createMessageHandler(ctx.deps);
  });

  it('mcp:set_working_dir stores the override and responds ok', async () => {
    await handleMessage(ctx.ws, {
      type: 'mcp:set_working_dir',
      _reqId: 1,
      session: 3,
      dir: '/Users/me/webplatform-worktree/DEV-123',
    }, {});

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatchObject({
      _reqId: 1,
      ok: true,
      dir: '/Users/me/webplatform-worktree/DEV-123',
    });
    // Should broadcast the change
    expect(ctx.broadcasts).toHaveLength(1);
    expect(ctx.broadcasts[0]).toMatchObject({
      type: 'working_dir:updated',
      session: 3,
      dir: '/Users/me/webplatform-worktree/DEV-123',
    });
  });

  it('mcp:set_working_dir expands ~ in paths', async () => {
    await handleMessage(ctx.ws, {
      type: 'mcp:set_working_dir',
      _reqId: 2,
      session: 1,
      dir: '~/projects/my-repo',
    }, {});

    expect(ctx.sent[0].ok).toBe(true);
    expect(ctx.sent[0].dir).not.toContain('~');
    expect(ctx.sent[0].dir).toMatch(/^\//); // absolute path (works on macOS /Users and Linux /home)
  });

  it('mcp:set_working_dir rejects empty dir', async () => {
    await handleMessage(ctx.ws, {
      type: 'mcp:set_working_dir',
      _reqId: 3,
      session: 1,
      dir: '',
    }, {});

    expect(ctx.sent[0]).toMatchObject({ _reqId: 3, ok: false });
  });

  it('git:info uses the working dir override when set', async () => {
    // Create handler with session 3 discoverable by fleet
    const c = makeDeps({
      sessions: [{ name: '3-test', nodeId: 'local', path: '/home/user/dev/session-3' }],
    });
    const handler = createMessageHandler(c.deps);

    // Set working dir for session 3
    await handler(c.ws, {
      type: 'mcp:set_working_dir',
      _reqId: 1,
      session: 3,
      dir: '/custom/worktree/path',
    }, {});

    // Mock git commands to return something
    c.node.exec.mockResolvedValue('');

    // Now request git:info — fleet will find session '3-test' and extract num=3
    await handler(c.ws, {
      type: 'git:info',
      session: '3-test',
    }, {});

    // All git commands should have been called with the override path
    const gitCalls = c.node.exec.mock.calls;
    const gitInfoCalls = gitCalls.filter(([cmd]) => cmd.includes('git -C'));
    expect(gitInfoCalls.length).toBeGreaterThan(0);
    for (const [cmd] of gitInfoCalls) {
      expect(cmd).toContain('/custom/worktree/path');
      expect(cmd).not.toContain('session-3');
    }

    // Response should include workingDir
    const gitInfoResp = c.sent.find(m => m.type === 'git:info');
    expect(gitInfoResp.workingDir).toBe('/custom/worktree/path');
  });

  it('git:info uses default repoDir when no override set', async () => {
    const c = makeDeps({
      sessions: [{ name: '2-test', nodeId: 'local', path: '/home/user/dev/session-2' }],
    });
    const handler = createMessageHandler(c.deps);

    c.node.exec.mockResolvedValue('');

    await handler(c.ws, {
      type: 'git:info',
      session: '2-test',
    }, {});

    // Git commands should use the default repoDir (session-2)
    const gitCalls = c.node.exec.mock.calls.filter(([cmd]) => cmd.includes('git -C'));
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const [cmd] of gitCalls) {
      expect(cmd).toContain('session-2');
    }

    // Response should not have workingDir
    const gitInfoResp = c.sent.find(m => m.type === 'git:info');
    expect(gitInfoResp.workingDir).toBeNull();
  });
});
