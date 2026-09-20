import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockWatcher, createMockNode } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const fleetModule = require('../../src/core/fleet');
const logModule = require('../../src/core/log');
const sessionManager = require('../../src/core/session-manager');
const relayModule = require('../../src/core/relay');
const TaskQueue = require('../../src/core/taskqueue');
const NodeRouter = require('../../src/core/node-router');

/**
 * hive spawns an agent into a brand-new directory, starts Claude in it, and
 * dispatches a task — but never writes a `.mcp.json`. The session comes up with
 * no hive MCP server at all, so `hive_get_task` and `hive_complete_task` are not
 * registered. Seen in the wild: a session spawned into a fresh `repos/a1` listed
 * 7 MCP servers and no hive; the directory had no `.mcp.json` whatsoever. The
 * agent ran the task and had no way to report or complete it.
 *
 * The distinction this suite pins down: a `.mcp.json` that EXISTS without a hive
 * entry is a decision (never deployed, or removed with mcp:remove) and is left
 * alone. NO `.mcp.json` at all, in a directory hive itself just created for the
 * session it is spawning, is not a decision — nobody has had the chance to make
 * one yet.
 */
describe('a freshly spawned repo gets its hive MCP config', () => {
  let tmpRoot;

  const mcpPath = (dir) => path.join(dir, '.mcp.json');
  const hiveArgs = (dir) =>
    JSON.parse(fs.readFileSync(mcpPath(dir), 'utf8')).mcpServers?.hive?.args || [];
  const flag = (args, name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-spawn-mcp-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('sessionManager.seedMcpConfig', () => {
    it('writes a full hive entry into a repo with no .mcp.json', () => {
      const wrote = sessionManager.seedMcpConfig(tmpRoot, 'ws://127.0.0.1:3960', 'tok', 7);

      expect(wrote).toBe(true);
      const args = hiveArgs(tmpRoot);
      expect(args[0]).toMatch(/mcp-server[/\\]index\.mjs$/);
      expect(flag(args, '--hive-url')).toBe('ws://127.0.0.1:3960');
      expect(flag(args, '--session')).toBe('7');
      expect(flag(args, '--token')).toBe('tok');
      expect(JSON.parse(fs.readFileSync(mcpPath(tmpRoot), 'utf8')).mcpServers.hive.command).toBe(
        'node',
      );
    });

    it('carries a --tools restriction through so a spawn matches the deployed fleet', () => {
      sessionManager.seedMcpConfig(tmpRoot, 'ws://127.0.0.1:3960', 'tok', 7, [
        'hive_get_task',
        'hive_complete_task',
      ]);

      expect(flag(hiveArgs(tmpRoot), '--tools')).toBe('hive_get_task,hive_complete_task');
    });

    it('leaves a .mcp.json that exists without a hive entry alone', () => {
      // mcp:remove deletes only the hive entry and keeps the rest. Re-adding
      // hive here would undo that decision behind the operator's back.
      const before = JSON.stringify({
        mcpServers: { playwright: { command: 'npx', args: ['playwright-mcp'] } },
      });
      fs.writeFileSync(mcpPath(tmpRoot), before);

      const wrote = sessionManager.seedMcpConfig(tmpRoot, 'ws://127.0.0.1:3960', 'tok', 7);

      expect(wrote).toBe(false);
      expect(fs.readFileSync(mcpPath(tmpRoot), 'utf8')).toBe(before);
    });

    it('leaves a deployed hive entry exactly as deployed', () => {
      // Seeding is not a refresh. Spawning has never rewritten a deployed
      // entry, and rewriting one here would replace its URL and token with
      // spawn-time values.
      const before = JSON.stringify({
        mcpServers: {
          hive: {
            command: 'node',
            args: ['/hive/index.mjs', '--hive-url', 'ws://127.0.0.1:4000', '--token', 'deployed'],
          },
        },
      });
      fs.writeFileSync(mcpPath(tmpRoot), before);

      const wrote = sessionManager.seedMcpConfig(tmpRoot, 'ws://127.0.0.1:3960', 'tok', 7);

      expect(wrote).toBe(false);
      expect(fs.readFileSync(mcpPath(tmpRoot), 'utf8')).toBe(before);
    });
  });

  describe('spawnSession', () => {
    let tq, config, router;

    beforeEach(() => {
      vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
      vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
      vi.spyOn(logModule, 'info').mockImplementation(() => {});
      vi.spyOn(logModule, 'warn').mockImplementation(() => {});
      vi.spyOn(logModule, 'error').mockImplementation(() => {});
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue({
        created: true,
        skipped: false,
      });
      vi.spyOn(sessionManager, 'startClaude').mockResolvedValue();
      vi.spyOn(TaskQueue.prototype, '_saveState').mockImplementation(() => {});
      vi.spyOn(TaskQueue.prototype, '_debounceSave').mockImplementation(() => {});

      process.env.WEB_PORT = '3960';
      process.env.WEB_TOKEN = 'spawn-token';

      config = createMockConfig();
      router = new NodeRouter();
      router.addNode(createMockNode());
      tq = new TaskQueue(config, createMockWatcher(), router);
    });

    afterEach(() => {
      delete process.env.WEB_PORT;
      delete process.env.WEB_TOKEN;
    });

    it('writes a hive entry into the directory it just created', async () => {
      const { repoDir } = await tq.spawnSession({ num: 4, name: 'a', baseDir: tmpRoot });

      expect(fs.existsSync(mcpPath(repoDir))).toBe(true);
      const args = hiveArgs(repoDir);
      expect(flag(args, '--hive-url')).toBe('ws://127.0.0.1:3960');
      expect(flag(args, '--session')).toBe('4');
      expect(flag(args, '--token')).toBe('spawn-token');
    });

    it('writes it before Claude starts — Claude reads .mcp.json once, at startup', async () => {
      let existedWhenClaudeStarted = false;
      sessionManager.startClaude.mockImplementation(async () => {
        existedWhenClaudeStarted = fs.existsSync(mcpPath(path.join(tmpRoot, 'a4')));
      });

      await tq.spawnSession({ num: 4, name: 'a', baseDir: tmpRoot });

      expect(existedWhenClaudeStarted).toBe(true);
    });

    it('inherits the --tools restriction the fleet was deployed with', async () => {
      fs.mkdirSync(path.join(tmpRoot, 'session-1'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'session-1', '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            hive: { command: 'node', args: ['/hive/index.mjs', '--tools', 'hive_get_task'] },
          },
        }),
      );
      config.sessions.repoDir = (n) => path.join(tmpRoot, `session-${n}`);
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '1', num: 1, state: 'idle' }]);

      const { repoDir } = await tq.spawnSession({ num: 4, name: 'a', baseDir: tmpRoot });

      expect(flag(hiveArgs(repoDir), '--tools')).toBe('hive_get_task');
    });

    it('leaves a directory that already existed alone — its missing hive entry is a decision', async () => {
      // A repo hive did not create this spawn is one the operator has already
      // had the chance to deploy to, or to run mcp:remove on.
      const repoDir = path.join(tmpRoot, 'a4');
      fs.mkdirSync(repoDir, { recursive: true });

      await tq.spawnSession({ num: 4, name: 'a', baseDir: tmpRoot });

      expect(fs.existsSync(mcpPath(repoDir))).toBe(false);
    });

    it('leaves a .mcp.json already in the repo alone', async () => {
      // A repo can carry its own .mcp.json — checked in, or written by a
      // previous deploy. That file is the project's, not ours.
      const repoDir = path.join(tmpRoot, 'a4');
      fs.mkdirSync(repoDir, { recursive: true });
      const before = JSON.stringify({
        mcpServers: { playwright: { command: 'npx', args: ['playwright-mcp'] } },
      });
      fs.writeFileSync(mcpPath(repoDir), before);

      await tq.spawnSession({ num: 4, name: 'a', baseDir: tmpRoot });

      expect(fs.readFileSync(mcpPath(repoDir), 'utf8')).toBe(before);
    });
  });

  describe('dispatching to a session with no hive entry warns', () => {
    let tq, config, router, node;

    beforeEach(() => {
      vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
      vi.spyOn(fleetModule, 'findSession').mockResolvedValue({ name: '3', nodeId: 'local' });
      vi.spyOn(logModule, 'info').mockImplementation(() => {});
      vi.spyOn(logModule, 'warn').mockImplementation(() => {});
      vi.spyOn(logModule, 'error').mockImplementation(() => {});
      vi.spyOn(TaskQueue.prototype, '_saveState').mockImplementation(() => {});
      vi.spyOn(TaskQueue.prototype, '_debounceSave').mockImplementation(() => {});
      // The relay send is fire-and-forget; keep it out of the test.
      vi.spyOn(relayModule, 'ask').mockResolvedValue({ success: true });
      vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });

      config = createMockConfig();
      node = createMockNode();
      router = new NodeRouter();
      router.addNode(node);
      tq = new TaskQueue(config, createMockWatcher(), router);
    });

    const dispatch = async () => {
      const task = tq.createTask('do a thing', 'manual', null);
      await tq._dispatchTask(task, 3);
      await new Promise((r) => setTimeout(r, 10));
    };

    const warnings = () =>
      tq.feed.filter((e) => /no hive MCP entry/i.test(e.detail || '')).map((e) => e.detail);

    it('warns when the repo has no .mcp.json at all', async () => {
      node.readFile.mockResolvedValue(null);

      await dispatch();

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('Session 3');
    });

    it('warns when the .mcp.json has no hive entry', async () => {
      node.readFile.mockResolvedValue(
        JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: [] } } }),
      );

      await dispatch();

      expect(warnings()).toHaveLength(1);
    });

    it('stays quiet when the repo has a hive entry', async () => {
      node.readFile.mockResolvedValue(
        JSON.stringify({ mcpServers: { hive: { command: 'node', args: ['/hive/index.mjs'] } } }),
      );

      await dispatch();

      expect(warnings()).toHaveLength(0);
    });

    it('warns once per session, not once per task', async () => {
      node.readFile.mockResolvedValue(null);

      await dispatch();
      tq.dispatchLock.delete(3);
      tq.activeTaskBySession.delete(3);
      await dispatch();

      expect(warnings()).toHaveLength(1);
    });

    it('does not block the dispatch when the repo cannot be read', async () => {
      node.readFile.mockRejectedValue(new Error('node unreachable'));

      await dispatch();

      expect(tq.activeTaskBySession.get(3)).toBeTruthy();
    });
  });
});
