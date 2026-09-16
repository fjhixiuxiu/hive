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
 * A designation only reaches a client through a 'designations:changed' emit —
 * the server broadcasts it as 'designations:status', and the dashboard's
 * designation map is written from nothing else. Two paths wrote
 * this.designations directly and emitted nothing, so the stored value was
 * right and every open dashboard was wrong until it reconnected.
 *
 * Seen in the wild: auto-create spawned session 11 into the Code Review lane
 * for a queued /review-pr task, the feed logged "Auto-created session 11 for
 * Code Review task", and the session view showed no designation at all. The
 * operator fixed it by assigning Code Review by hand — setting it to the value
 * it already held — which worked only because setDesignation is what emits.
 */
describe('designation changes reach clients', () => {
  let tq, config, router;

  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManager, 'startClaude').mockResolvedValue();
    vi.spyOn(sessionManager, 'createSession').mockResolvedValue({
      created: true,
      skipped: false,
    });

    config = createMockConfig();
    router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(config, createMockWatcher(), router);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('auto-create', () => {
    // An empty fleet: no session can host the task, so the lane must spawn one.
    beforeEach(() => {
      vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
      tq.autoCreateForManualTasks = true;
    });

    // createTask kicks off _tryAutoDispatch without awaiting it, and that
    // in-flight run holds the _autoDispatching guard — so calling it again here
    // returns immediately and the assertions race the spawn. Wait the
    // background run out instead.
    const settle = () => vi.waitFor(() => expect(tq._autoDispatching).toBe(false));

    it('announces the designation it stamps on a session it spawns', async () => {
      const emitted = [];
      tq.on('designations:changed', (d) => emitted.push(d));

      tq.createTask('/review-pr https://example.test/pull/1', 'auto', null, 'Code Review');
      await settle();

      // The session really was created and stamped...
      const spawned = [...tq.designations.entries()].find(([, d]) => d === 'Code Review');
      expect(spawned, 'auto-create should have stamped a session Code Review').toBeTruthy();

      // ...and, the part that was missing, somebody was told.
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted.at(-1)[spawned[0]]).toBe('Code Review');
    });

    // What the most recent _saveState actually wrote to disk.
    const lastSaved = () => {
      const writes = fs.writeFileSync.mock.calls
        .map((c) => c[1])
        .filter((body) => typeof body === 'string' && body.includes('"autoSessions"'));
      return writes.length ? JSON.parse(writes.at(-1)) : null;
    };

    // Review suggested collapsing the second _saveState after setDesignation as a
    // redundant write. It is redundant only when there IS a designation:
    // setDesignation is called `if (desig)`, so an undesignated spawn never
    // reaches it, and the trailing save is the only thing that persists its
    // autoSessions entry. These pin both halves so neither the redundant write
    // nor the required one can come back wrong.
    it('persists an undesignated spawn — the save a naive collapse would drop', async () => {
      tq.createTask('some undesignated work', 'auto', null, null);
      await settle();

      const spawnedNum = sessionManager.createSession.mock.calls
        .map((c) => Number(c[0]))
        .find((n) => tq.autoSessions.has(n));
      expect(spawnedNum, 'an undesignated session should have been auto-created').toBeDefined();

      // Without the else-branch save this entry exists in memory only, and a
      // restart forgets hive auto-created the session.
      expect(lastSaved().autoSessions).toContain(spawnedNum);
    });

    it("persists a designated spawn's session and designation through setDesignation's save", async () => {
      tq.createTask('/review-pr https://example.test/pull/2', 'auto', null, 'Code Review');
      await settle();

      const [spawnedNum] = [...tq.designations.entries()].find(([, d]) => d === 'Code Review');
      const saved = lastSaved();
      // One save covers both, because autoSessions.add runs before setDesignation.
      expect(saved.autoSessions).toContain(spawnedNum);
      expect(saved.designations[spawnedNum]).toBe('Code Review');
    });

    it('does not announce anything for an undesignated spawn', async () => {
      const emitted = [];
      tq.on('designations:changed', (d) => emitted.push(d));

      tq.createTask('some undesignated work', 'auto', null, null);
      await settle();

      // A session was spawned — this is the same path, minus a designation.
      expect(sessionManager.createSession).toHaveBeenCalled();
      expect(emitted).toEqual([]);
    });
  });

  describe('cleanupSession', () => {
    it('announces that a killed session gave up its designation', () => {
      tq.setDesignation(7, 'Code Review');

      const emitted = [];
      tq.on('designations:changed', (d) => emitted.push(d));

      tq.cleanupSession(7);

      expect(tq.designations.has(7)).toBe(false);
      expect(emitted.length).toBe(1);
      expect(emitted[0][7]).toBeUndefined();
    });

    it('stays quiet for a session that had no designation', () => {
      const emitted = [];
      tq.on('designations:changed', (d) => emitted.push(d));

      tq.cleanupSession(9);

      expect(emitted).toEqual([]);
    });
  });
});
