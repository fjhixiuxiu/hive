import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockWatcher, createMockNode } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const fleetModule = require('../../src/core/fleet');
const relayModule = require('../../src/core/relay');
const logModule = require('../../src/core/log');
const sessionManagerModule = require('../../src/core/session-manager');
const TaskQueue = require('../../src/core/taskqueue');
const NodeRouter = require('../../src/core/node-router');

// ---------------------------------------------------------------------------
// Auto-create tuning: who may spawn a session, which slot they get, and what
// the spawned agent is told.
//
// All three behaviours here came out of one incident — a toggle meant for an
// EVV intake queue spun up five sessions, all tagged "Code Review", for a
// backlog that was supposed to be human-reviewed.
// ---------------------------------------------------------------------------

describe('auto-create tuning', () => {
  let tq, config, watcher, router;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(relayModule, 'ask').mockResolvedValue({ success: true, response: 'done' });
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManagerModule, 'createSession').mockResolvedValue();
    vi.spyOn(sessionManagerModule, 'startClaude').mockResolvedValue();

    config = createMockConfig();
    watcher = createMockWatcher();
    router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(config, watcher, router);
    tq.config.sessions.repoDir = (n) => `/tmp/wp${n}`;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function queueTask(id, overrides = {}) {
    const task = {
      id,
      text: `task ${id}`,
      mode: 'auto',
      status: 'queued',
      designation: null,
      targetSession: null,
      source: null,
      ...overrides,
    };
    tq.tasks.set(id, task);
    return task;
  }

  const spawnedSlots = () => sessionManagerModule.createSession.mock.calls.map((c) => Number(c[0]));

  // ── Who may spawn ────────────────────────────────────────

  describe('source-PM intent outranks the global toggle', () => {
    it('spawns for a PM that opted in', async () => {
      tq._pmManager = { pms: new Map([['1', { name: 'Intake', autoCreate: true }]]) };
      queueTask('1', { source: 'pm:Intake' });

      await tq._tryAutoDispatch();

      expect(sessionManagerModule.createSession).toHaveBeenCalled();
    });

    it('never spawns for a PM that opted out, even with the global toggle on', async () => {
      // The incident. "Human Reviews" is a manual-review queue by design; a
      // toggle enabled for a different PM's backlog must not conscript it.
      tq.autoCreateForManualTasks = true;
      tq._pmManager = { pms: new Map([['1', { name: 'Human Reviews', autoCreate: false }]]) };
      queueTask('1', { source: 'pm:Human Reviews' });

      await tq._tryAutoDispatch();

      expect(sessionManagerModule.createSession).not.toHaveBeenCalled();
    });

    it('spawns for a task with no source PM when the toggle is on', async () => {
      // The catch-all the toggle actually exists for: dashboard-typed tasks.
      tq.autoCreateForManualTasks = true;
      queueTask('1');

      await tq._tryAutoDispatch();

      expect(sessionManagerModule.createSession).toHaveBeenCalled();
    });

    it('does not spawn for a PM-less task when the toggle is off', async () => {
      tq.autoCreateForManualTasks = false;
      queueTask('1');

      await tq._tryAutoDispatch();

      expect(sessionManagerModule.createSession).not.toHaveBeenCalled();
    });

    it('does not spawn for a PM-less task that names its own session', async () => {
      tq.autoCreateForManualTasks = true;
      queueTask('1', { targetSession: 6 });

      await tq._tryAutoDispatch();

      expect(sessionManagerModule.createSession).not.toHaveBeenCalled();
    });
  });

  // ── Which slot ───────────────────────────────────────────

  describe('slot claiming within one dispatch round', () => {
    it('gives two designation groups two different slots', async () => {
      // getAvailableSlots() reads the fleet, which cannot yet see a session we
      // decided to create milliseconds ago. Without a per-round claim ledger
      // both groups pick the same slot: the second createSession no-ops (tmux
      // tolerates a duplicate `-d -s`) and designations.set(num, ...) runs
      // twice, last writer winning. That is how EVV spawns got tagged
      // "Code Review".
      tq._pmManager = {
        pms: new Map([['1', { name: 'Intake', autoCreate: true }]]),
      };
      queueTask('1', { source: 'pm:Intake', designation: 'evv' });
      queueTask('2', { source: 'pm:Intake', designation: 'code-review' });

      await tq._tryAutoDispatch();

      const slots = spawnedSlots();
      expect(slots).toHaveLength(2);
      expect(new Set(slots).size).toBe(2);
    });

    it("gives each group its own designation rather than the last writer's", async () => {
      tq._pmManager = { pms: new Map([['1', { name: 'Intake', autoCreate: true }]]) };
      queueTask('1', { source: 'pm:Intake', designation: 'evv' });
      queueTask('2', { source: 'pm:Intake', designation: 'code-review' });

      await tq._tryAutoDispatch();

      const assigned = spawnedSlots().map((n) => tq.designations.get(n));
      expect(new Set(assigned)).toEqual(new Set(['evv', 'code-review']));
    });

    it('stops spawning when the round has claimed every usable slot', async () => {
      tq.spawnSlotMin = 6;
      tq.spawnSlotMax = 7; // exactly two slots
      tq._pmManager = { pms: new Map([['1', { name: 'Intake', autoCreate: true }]]) };
      queueTask('1', { source: 'pm:Intake', designation: 'a' });
      queueTask('2', { source: 'pm:Intake', designation: 'b' });
      queueTask('3', { source: 'pm:Intake', designation: 'c' });

      await tq._tryAutoDispatch();

      expect(spawnedSlots()).toHaveLength(2);
    });

    it('never claims a slot the user set to Manual', async () => {
      // From main: a Manual session dying is exactly when its slot looks free,
      // so without this the setting is undone at the worst possible moment.
      tq.spawnSlotMin = 6;
      tq.spawnSlotMax = 7;
      tq.manualSessions.add(6);
      tq._pmManager = { pms: new Map([['1', { name: 'Intake', autoCreate: true }]]) };
      queueTask('1', { source: 'pm:Intake', designation: 'a' });

      await tq._tryAutoDispatch();

      expect(spawnedSlots()).toEqual([7]);
    });

    it('spawns nothing when every free slot is Manual', async () => {
      tq.spawnSlotMin = 6;
      tq.spawnSlotMax = 7;
      tq.manualSessions.add(6);
      tq.manualSessions.add(7);
      tq._pmManager = { pms: new Map([['1', { name: 'Intake', autoCreate: true }]]) };
      queueTask('1', { source: 'pm:Intake', designation: 'a' });

      await tq._tryAutoDispatch();

      expect(sessionManagerModule.createSession).not.toHaveBeenCalled();
    });

    it('applies the Manual filter before the per-round claim, not after', async () => {
      // Both guards must compose. With one free non-Manual slot and two groups,
      // the first takes it and the second finds nothing — rather than the
      // second falling back onto the Manual slot.
      tq.spawnSlotMin = 6;
      tq.spawnSlotMax = 8;
      tq.manualSessions.add(7);
      tq.manualSessions.add(8);
      tq._pmManager = { pms: new Map([['1', { name: 'Intake', autoCreate: true }]]) };
      queueTask('1', { source: 'pm:Intake', designation: 'a' });
      queueTask('2', { source: 'pm:Intake', designation: 'b' });

      await tq._tryAutoDispatch();

      expect(spawnedSlots()).toEqual([6]);
    });
  });

  // ── What the spawned agent is told ───────────────────────
});
