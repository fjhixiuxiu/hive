import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockWatcher, createMockNode } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const fleetModule = require('../../src/core/fleet');
const logModule = require('../../src/core/log');
const sessionManager = require('../../src/core/session-manager');
const TaskQueue = require('../../src/core/taskqueue');
const NodeRouter = require('../../src/core/node-router');

/**
 * createSession returns { created:false, skipped:true } for a slot that is
 * already live, and every caller ignored it — so they typed `claude` into a
 * pane that already had one running, stacking a second REPL on a working
 * session. Seen in the wild: a spawn landed on slot 4 one second after
 * auto-dispatch created it, and Claude was started twice in =4:.1.
 */
describe('never start a second Claude in a live pane', () => {
  let tq, config, router;

  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManager, 'startClaude').mockResolvedValue();

    config = createMockConfig();
    router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(config, createMockWatcher(), router);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('spawnSession', () => {
    it('does not start Claude when the slot was already live', async () => {
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue({ created: false, skipped: true });

      await tq.spawnSession({ num: 4, name: 'webplatform', baseDir: '/tmp/x' });

      expect(sessionManager.startClaude).not.toHaveBeenCalled();
    });

    it('still starts Claude for a genuinely new session', async () => {
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue({ created: true, skipped: false });

      await tq.spawnSession({ num: 5, name: 'webplatform', baseDir: '/tmp/x' });

      expect(sessionManager.startClaude).toHaveBeenCalledTimes(1);
      expect(sessionManager.startClaude.mock.calls[0][0]).toBe('5');
    });

    it('registers the agent either way — the slot is claimed regardless', async () => {
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue({ created: false, skipped: true });

      const result = await tq.spawnSession({ num: 4, name: 'webplatform', baseDir: '/tmp/x' });

      expect(result.num).toBe(4);
      expect(tq.getSpawnedAgent(4)).toMatchObject({ name: 'webplatform' });
    });
  });

  describe('auto-dispatch spawning', () => {
    // Reaching the auto-create block takes a fleet with an idle auto session
    // (main returns early otherwise) plus a task no existing session can host —
    // a strict-designation task with no matching session.
    const strictSetup = () => {
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '1', num: 1, state: 'idle' }]);
      tq.autoSessions.add(1);                    // idle, undesignated
      tq._pmManager = {
        pms: new Map([['1', { name: 'StrictPM', designationMatch: 'strict', autoCreate: true }]]),
        serialize: () => ({ pms: [], knowledgeBase: [] }),
        enrichTaskText: (task) => task.text,
      };
      tq.createTask('needs its own session', 'auto', null, 'Code Review', { source: 'pm:StrictPM' });
    };

    it('does not start Claude when the slot filled up between the fleet read and the create', async () => {
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue({ created: false, skipped: true });
      strictSetup();

      await new Promise(r => setTimeout(r, 50));

      expect(sessionManager.createSession).toHaveBeenCalled();
      expect(sessionManager.startClaude).not.toHaveBeenCalled();
    });

    it('starts Claude for a slot it really did create', async () => {
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue({ created: true, skipped: false });
      strictSetup();

      await new Promise(r => setTimeout(r, 50));

      expect(sessionManager.startClaude).toHaveBeenCalledTimes(1);
    });

    it('claims the slot as an auto session either way', async () => {
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue({ created: false, skipped: true });
      strictSetup();

      await new Promise(r => setTimeout(r, 50));

      // 1 was already auto; the newly claimed slot joins it.
      expect(tq.autoSessions.size).toBeGreaterThan(1);
    });
  });
});
