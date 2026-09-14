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
 * Auto vs Manual is presence in autoSessions, keyed by SLOT NUMBER — so Manual
 * is an absence, and an absence cannot be told apart from "never configured".
 *
 * Seen in the wild: session 4 was set to Manual, its tmux session died, the
 * freed slot dropped the fleet under its cap, and the very next auto-dispatch
 * cycle spawned into slot 4 and ran autoSessions.add(4). The session came back
 * as Auto and immediately took two tasks.
 */
describe('Manual survives the session dying', () => {
  let tq, config, router;

  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManager, 'createSession').mockResolvedValue({ created: true, skipped: false });
    vi.spyOn(sessionManager, 'startClaude').mockResolvedValue();

    config = createMockConfig();
    router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(config, createMockWatcher(), router);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('the toggle', () => {
    it('records the opt-out when auto is switched off', () => {
      tq.autoSessions.add(4);

      tq.toggleAutoSession(4);

      expect(tq.autoSessions.has(4)).toBe(false);
      expect(tq.manualSessions.has(4)).toBe(true);
    });

    it('clears the opt-out when auto is switched back on', () => {
      tq.autoSessions.add(4);
      tq.toggleAutoSession(4); // → manual
      tq.toggleAutoSession(4); // → auto again

      expect(tq.autoSessions.has(4)).toBe(true);
      expect(tq.manualSessions.has(4)).toBe(false);
    });

    it('setAutoSessions clears the mark for listed slots and leaves others alone', () => {
      tq.autoSessions.add(4);
      tq.toggleAutoSession(4);
      tq.manualSessions.add(9);

      tq.setAutoSessions([4]);

      expect(tq.manualSessions.has(4)).toBe(false);
      // Bulk-setting the auto list says nothing about slot 9.
      expect(tq.manualSessions.has(9)).toBe(true);
    });

    it('persists so a restart cannot forget it', () => {
      tq.autoSessions.add(4);
      tq.toggleAutoSession(4);

      const saved = fs.writeFileSync.mock.calls
        .map(([, contents]) => {
          try {
            return JSON.parse(contents);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .pop();
      expect(saved.manualSessions).toContain(4);
    });
  });

  describe('auto-create', () => {
    // Reaching the spawn block needs an idle auto session (main returns early
    // otherwise) plus a task no existing session can host.
    const queueUnhostableTask = () => {
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '1', num: 1, state: 'idle' }]);
      tq.autoSessions.add(1);
      tq._pmManager = {
        pms: new Map([['1', { name: 'StrictPM', designationMatch: 'strict', autoCreate: true }]]),
        serialize: () => ({ pms: [], knowledgeBase: [] }),
        enrichTaskText: (task) => task.text,
      };
      tq.createTask('needs its own session', 'auto', null, 'Code Review', {
        source: 'pm:StrictPM',
      });
    };

    it('skips a slot the user set to Manual and takes the next one', async () => {
      tq.spawnSlotMin = 4; // slot 4 is the first candidate...
      tq.manualSessions.add(4); // ...and it is Manual
      queueUnhostableTask();

      await new Promise((r) => setTimeout(r, 50));

      expect(sessionManager.createSession).toHaveBeenCalled();
      expect(sessionManager.createSession.mock.calls[0][0]).toBe('5');
      expect(tq.autoSessions.has(4)).toBe(false);
    });

    it('does not spawn at all when every free slot is Manual', async () => {
      tq.spawnSlotMin = 4;
      tq.spawnSlotMax = 5;
      tq.manualSessions.add(4);
      tq.manualSessions.add(5);
      queueUnhostableTask();

      await new Promise((r) => setTimeout(r, 50));

      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(tq.autoSessions.has(4)).toBe(false);
      expect(tq.autoSessions.has(5)).toBe(false);
    });

    it('still spawns freely into slots that were never set to Manual', async () => {
      tq.spawnSlotMin = 4;
      queueUnhostableTask();

      await new Promise((r) => setTimeout(r, 50));

      expect(sessionManager.createSession.mock.calls[0][0]).toBe('4');
      expect(tq.autoSessions.has(4)).toBe(true);
    });
  });

  // The toggle is the only writer of manualSessions, so the mark only exists
  // for a slot that was Auto first. A slot that was never auto is Manual by
  // absence — the flavour nothing remembers — and spawning an agent by hand is
  // the way that happens most.
  //
  // Seen in the wild: slot 11 was hand-spawned, so it carried no mark and never
  // took a dispatch. Its tmux session died at 17:03:52, auto-create read the
  // freed slot 30s later, built a session there and ran autoSessions.add(11),
  // and 33s after that the slot took a task. The user's own respawn lost the
  // race by three seconds and threw "Slot 11 is already occupied".
  describe('spawning an agent by hand', () => {
    // Same setup as the auto-create block above: an idle auto session so the
    // dispatcher does not return early, plus a task no existing session can host.
    const queueUnhostableTask = () => {
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '1', num: 1, state: 'idle' }]);
      tq.autoSessions.add(1);
      tq._pmManager = {
        pms: new Map([['1', { name: 'StrictPM', designationMatch: 'strict', autoCreate: true }]]),
        serialize: () => ({ pms: [], knowledgeBase: [] }),
        enrichTaskText: (task) => task.text,
      };
      tq.createTask('needs its own session', 'auto', null, 'Code Review', {
        source: 'pm:StrictPM',
      });
    };

    it('marks the slot Manual', async () => {
      await tq.spawnSession({ num: 4, name: 'webplatform' });

      expect(tq.manualSessions.has(4)).toBe(true);
      expect(tq.autoSessions.has(4)).toBe(false);
    });

    it('holds the slot after the hand-spawned session dies', async () => {
      tq.spawnSlotMin = 4;
      await tq.spawnSession({ num: 4, name: 'webplatform' });
      // The hand-spawn is itself a createSession('4') — drop it so the calls
      // left are only the ones auto-create made.
      sessionManager.createSession.mockClear();

      // The session dies on its own — queueUnhostableTask resets the fleet to
      // slot 1 only, so 4 looks free to getAvailableSlots and nothing calls
      // cleanupSession.
      queueUnhostableTask();
      await new Promise((r) => setTimeout(r, 50));

      const spawnedInto = sessionManager.createSession.mock.calls.map((c) => c[0]);
      expect(spawnedInto).toContain('5');
      expect(spawnedInto).not.toContain('4');
      // The half that actually bit: auto-create ends with autoSessions.add(num),
      // so seizing the slot does not borrow it — it converts it.
      expect(tq.autoSessions.has(4)).toBe(false);
      expect(tq.manualSessions.has(4)).toBe(true);
    });

    it('can still be opted into auto afterwards', async () => {
      await tq.spawnSession({ num: 4, name: 'webplatform' });

      tq.toggleAutoSession(4);

      expect(tq.autoSessions.has(4)).toBe(true);
      expect(tq.manualSessions.has(4)).toBe(false);
    });

    it('takes the slot back from a stale auto entry', async () => {
      // The slot's previous session was Auto and died without cleanupSession,
      // leaving autoSessions holding a number with nothing behind it.
      tq.autoSessions.add(4);

      await tq.spawnSession({ num: 4, name: 'webplatform' });

      expect(tq.autoSessions.has(4)).toBe(false);
      expect(tq.manualSessions.has(4)).toBe(true);
    });
  });

  // The mark has to be released somewhere, or it is a one-way ratchet: every
  // Manual session ever closed costs a slot for good, and silently, because the
  // auto grid renders a chip per LIVE session — a slot with no session has
  // nothing left to click. Ten slots went missing that way before this landed.
  describe('closing a session releases the slot', () => {
    // Same setup as the auto-create block above: an idle auto session so the
    // dispatcher does not return early, plus a task no existing session can host.
    const queueUnhostableTask = () => {
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '1', num: 1, state: 'idle' }]);
      tq.autoSessions.add(1);
      tq._pmManager = {
        pms: new Map([['1', { name: 'StrictPM', designationMatch: 'strict', autoCreate: true }]]),
        serialize: () => ({ pms: [], knowledgeBase: [] }),
        enrichTaskText: (task) => task.text,
      };
      tq.createTask('needs its own session', 'auto', null, 'Code Review', {
        source: 'pm:StrictPM',
      });
    };

    it('clears the Manual mark when the user kills the session', () => {
      tq.autoSessions.add(4);
      tq.toggleAutoSession(4);
      expect(tq.manualSessions.has(4)).toBe(true);

      tq.cleanupSession(4);

      expect(tq.manualSessions.has(4)).toBe(false);
      expect(tq.autoSessions.has(4)).toBe(false);
    });

    it('frees the slot for auto-create again', async () => {
      tq.spawnSlotMin = 4;
      tq.autoSessions.add(4);
      tq.toggleAutoSession(4); // Manual — auto-create would skip slot 4
      tq.cleanupSession(4); // ...until the user closes it
      queueUnhostableTask();

      await new Promise((r) => setTimeout(r, 50));

      expect(sessionManager.createSession.mock.calls[0][0]).toBe('4');
    });

    it('persists the release, so a restart does not resurrect the mark', () => {
      tq.autoSessions.add(4);
      tq.toggleAutoSession(4);

      tq.cleanupSession(4);

      const saved = fs.writeFileSync.mock.calls
        .map(([, contents]) => {
          try {
            return JSON.parse(contents);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .pop();
      expect(saved.manualSessions).not.toContain(4);
    });

    it("leaves other slots' marks alone", () => {
      tq.manualSessions.add(4);
      tq.manualSessions.add(9);

      tq.cleanupSession(4);

      expect(tq.manualSessions.has(9)).toBe(true);
    });

    // The distinction the whole fix rests on: the watcher never calls
    // cleanupSession, so a session that dies on its own keeps its mark. That is
    // this feature's original point and it has to survive.
    // Slots get reused, so anything left keyed by session number is inherited
    // by whoever lands there next.
    it('wipes the designation', () => {
      tq.designations.set(4, 'Code Review');

      tq.cleanupSession(4);

      expect(tq.designations.has(4)).toBe(false);
    });

    it('wipes the session context so the next session does not inherit a PR', () => {
      tq.setSessionContext(4, { pr: '33224', jira: 'DEV-50589', branch: 'some/branch' });
      expect(tq.getSessionContext(4).pr).toBeTruthy();

      tq.cleanupSession(4);

      expect(tq.getSessionContext(4)).toEqual({});
    });

    it('drops the dispatch cooldown so a fresh session is not made to wait', () => {
      tq.lastCompletedAt.set(4, Date.now());

      tq.cleanupSession(4);

      expect(tq.lastCompletedAt.has(4)).toBe(false);
    });

    it('resolves a pending approval instead of leaving it to block the next one', () => {
      const stale = tq.createApproval(4, 'dead session was asking this');
      expect(stale.status).toBe('pending');

      tq.cleanupSession(4);

      expect(stale.status).toBe('denied');
      expect(stale.resolvedAt).toBeTruthy();
      // createApproval dedupes on session + pending, so without the line above
      // this would hand back the dead session's prompt.
      const fresh = tq.createApproval(4, 'live session asking something else');
      expect(fresh.id).not.toBe(stale.id);
      expect(fresh.prompt).toBe('live session asking something else');
    });

    it("leaves another session's approval pending", () => {
      const mine = tq.createApproval(4, 'mine');
      const theirs = tq.createApproval(9, 'theirs');

      tq.cleanupSession(4);

      expect(mine.status).toBe('denied');
      expect(theirs.status).toBe('pending');
    });

    // A released slot that the grid still draws as reserved is the same bug
    // wearing the other face, so both halves have to be reported.
    it('reports the marks so the dashboard can draw slots with no session', () => {
      tq.autoSessions.add(4);
      tq.toggleAutoSession(4);
      tq.manualSessions.add(9);

      expect(tq.getManualSessions()).toEqual([4, 9]);

      tq.cleanupSession(4);

      expect(tq.getManualSessions()).toEqual([9]);
    });

    it('does NOT clear the mark when the session merely dies', async () => {
      tq.spawnSlotMin = 4;
      tq.autoSessions.add(4);
      tq.toggleAutoSession(4);

      // A death the watcher noticed: the tmux session is simply gone from the
      // fleet, and nothing calls cleanupSession.
      expect(tq.manualSessions.has(4)).toBe(true);
      queueUnhostableTask();
      await new Promise((r) => setTimeout(r, 50));

      // Slot 4 looks free, but it is still the user's — spawn goes elsewhere.
      const spawnedInto = sessionManager.createSession.mock.calls.map((c) => c[0]);
      expect(spawnedInto).not.toContain('4');
      expect(tq.manualSessions.has(4)).toBe(true);
    });
  });
});
