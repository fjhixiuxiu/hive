import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockWatcher, createMockNode } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const fleet = require('../../src/core/fleet');
const tmux = require('../../src/core/tmux');
const relayModule = require('../../src/core/relay');
const logModule = require('../../src/core/log');
const sessionManagerModule = require('../../src/core/session-manager');
const TaskQueue = require('../../src/core/taskqueue');
const NodeRouter = require('../../src/core/node-router');

/**
 * The session state cache, and the session that reported idle forever.
 *
 * fleet.getSession() prefers `config.cache.stateDir/<num>` over live detection —
 * detectState only runs when that file is missing or empty. The file's only
 * other writer is the optional idle-watcher.sh daemon in docs/setup-guide.md.
 *
 * completeTask/failTask used to write the literal 'idle' there (f525370, to stop
 * a stale cached 'working' from looking busy). On a fleet where the directory
 * exists but the daemon is not running, nothing ever corrected that value, and
 * nothing in hive deletes these files — so the session reported idle
 * permanently, however busy it actually was.
 */
describe('state cache invalidation', () => {
  let tq, config, watcher, router, stateDir;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-state-cache-'));

    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.spyOn(fleet, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleet, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleet, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(relayModule, 'ask').mockResolvedValue({ success: true, response: 'done' });
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManagerModule, 'createSession').mockRejectedValue(new Error('no tmux in test'));

    config = createMockConfig({ cache: { stateDir } });
    watcher = createMockWatcher();
    router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(config, watcher, router);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const stateFile = (num) => path.join(stateDir, String(num));
  const dispatched = (num) => {
    const task = tq.createTask('work', 'manual', num);
    task.status = 'dispatched';
    task.assignedTo = num;
    tq.activeTaskBySession.set(num, task.id);
    return task;
  };

  describe('completing a task', () => {
    it('removes the session entry instead of asserting idle', () => {
      fs.writeFileSync(stateFile(3), 'working');
      tq.completeTask(dispatched(3).id, 'done');

      expect(fs.existsSync(stateFile(3))).toBe(false);
    });

    it('never writes a state value of its own', () => {
      const task = dispatched(4);
      tq.completeTask(task.id, 'done');

      // The regression: a written 'idle' outlives the task, and on a fleet with
      // no daemon nothing ever corrects it.
      expect(fs.existsSync(stateFile(4))).toBe(false);
    });

    it('leaves other sessions alone', () => {
      fs.writeFileSync(stateFile(5), 'working');
      fs.writeFileSync(stateFile(6), 'working');
      tq.completeTask(dispatched(5).id, 'done');

      expect(fs.existsSync(stateFile(5))).toBe(false);
      expect(fs.readFileSync(stateFile(6), 'utf8')).toBe('working');
    });
  });

  describe('failing a task', () => {
    it('removes the session entry', () => {
      fs.writeFileSync(stateFile(7), 'working');
      tq.failTask(dispatched(7).id, 'boom');

      expect(fs.existsSync(stateFile(7))).toBe(false);
    });
  });

  describe('best effort', () => {
    it('completes the task when there is no cache file', () => {
      const task = dispatched(8);
      expect(() => tq.completeTask(task.id, 'done')).not.toThrow();
      expect(tq.tasks.get(task.id).status).toBe('completed');
    });

    it('completes the task when the state dir does not exist', () => {
      // The common case: a fleet that never ran idle-watcher.sh. The old write
      // threw ENOENT into a catch {} here too, which is the only reason those
      // installs escaped the permanent pin.
      fs.rmSync(stateDir, { recursive: true, force: true });
      const task = dispatched(9);

      expect(() => tq.completeTask(task.id, 'done')).not.toThrow();
      expect(tq.tasks.get(task.id).status).toBe('completed');
    });
  });

  // The point of all of the above: what fleet reports afterwards.
  describe('what fleet sees after a task ends', () => {
    const workingPane = ['tool output', '─'.repeat(40), 'Model: sonnet'].join('\n');

    it('falls back to live detection, so a busy session reads as working', async () => {
      fs.writeFileSync(stateFile(2), 'working');
      tq.completeTask(dispatched(2).id, 'done');

      const node = createMockNode();
      node.capturePane = vi.fn().mockResolvedValue(workingPane);
      node.fileExists = vi.fn().mockResolvedValue(false);
      node.readFile = vi.fn(async (f) => {
        try {
          return fs.readFileSync(f, 'utf8');
        } catch {
          return null;
        }
      });

      const session = await fleet.getSession(config, node, '2-branch', 'local');

      expect(session.state).toBe(tmux.detectState(workingPane, config));
      expect(session.state).toBe('working');
      expect(node.capturePane).toHaveBeenCalled();
    });

    it('would have reported idle forever with a cached idle value', async () => {
      // Pins the mechanism the fix removes: while any value sits in the cache,
      // fleet never looks at the pane. This is what completeTask used to leave
      // behind on every completion.
      fs.writeFileSync(stateFile(2), 'idle');

      const node = createMockNode();
      node.capturePane = vi.fn().mockResolvedValue(workingPane);
      node.fileExists = vi.fn().mockResolvedValue(false);
      node.readFile = vi.fn(async (f) => {
        try {
          return fs.readFileSync(f, 'utf8');
        } catch {
          return null;
        }
      });

      const session = await fleet.getSession(config, node, '2-branch', 'local');

      expect(session.state).toBe('idle'); // despite a working pane
      expect(node.capturePane).not.toHaveBeenCalled();
    });
  });
});
