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
 * A designation cap is a ceiling on auto-spawn, not on the fleet. Sessions
 * started by hand count toward it — the lane really is that full — but no
 * manual path consults the map, so hive stops spawning into a full lane
 * without ever stopping a person from filling one.
 */
describe('per-designation auto-spawn caps', () => {
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
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManager, 'startClaude').mockResolvedValue();
    vi.spyOn(sessionManager, 'createSession').mockResolvedValue({ created: true, skipped: false });

    config = createMockConfig();
    router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(config, createMockWatcher(), router);
  });

  afterEach(() => vi.restoreAllMocks());

  // Reaching the auto-create block takes an idle auto session (the dispatch
  // loop returns early otherwise) plus a task no existing session can host —
  // a strict-designation task with no free session carrying that designation.
  // `existing` sessions are deliberately NOT idle auto sessions, or the task
  // would dispatch to one and never reach the spawn decision.
  const queueStrictTask = (designation, existing = []) => {
    fleetModule.getFleetStatus.mockResolvedValue([
      { name: '1', num: 1, state: 'idle' },
      ...existing,
    ]);
    tq.autoSessions.add(1);
    tq._pmManager = {
      pms: new Map([['1', { name: 'StrictPM', designationMatch: 'strict', autoCreate: true }]]),
      serialize: () => ({ pms: [], knowledgeBase: [] }),
      enrichTaskText: (task) => task.text,
    };
    tq.createTask('needs its own session', 'auto', null, designation, { source: 'pm:StrictPM' });
    return new Promise((r) => setTimeout(r, 50));
  };

  describe('the spawn decision', () => {
    it('spawns while the lane is still under its cap', async () => {
      tq.setDesignationDef('Code Review', { sessionCap: 2 });
      tq.designations.set(7, 'Code Review');

      await queueStrictTask('Code Review', [{ name: '7', num: 7, state: 'idle' }]);

      expect(sessionManager.createSession).toHaveBeenCalled();
    });

    it('spawns freely when the designation has no cap', async () => {
      tq.designations.set(7, 'Code Review');

      await queueStrictTask('Code Review', [{ name: '7', num: 7, state: 'idle' }]);

      expect(sessionManager.createSession).toHaveBeenCalled();
    });

    it('caps each lane separately', async () => {
      tq.setDesignationDef('Code Review', { sessionCap: 0 });
      tq.designations.set(7, 'Code Review');

      await queueStrictTask('Manual QA', [{ name: '7', num: 7, state: 'idle' }]);

      expect(sessionManager.createSession).toHaveBeenCalled();
    });

    it('leaves undesignated work uncapped', async () => {
      tq.setDesignationDef('Code Review', { sessionCap: 0 });

      // No designation on the task, and no idle undesignated auto session to
      // host it: session 1 is busy, so the queue has to spawn.
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '1', num: 1, state: 'working' }]);
      tq.autoSessions.add(1);
      tq.activeTaskBySession.set(1, '999');
      tq.autoCreateForManualTasks = true;
      tq.createTask('anyone can take this', 'auto', null, null, {});
      await new Promise((r) => setTimeout(r, 50));

      expect(sessionManager.createSession).toHaveBeenCalled();
    });
  });

  // The rule is "every session carrying the designation", with no reference to
  // its state or its mode — so the dimension is state × mode, and all four
  // combinations belong here rather than whichever two happened to be easy.
  describe('what counts toward a lane', () => {
    const combinations = [
      { what: 'an idle session started by hand', state: 'idle', auto: false, hasTask: false },
      { what: 'a busy session started by hand', state: 'working', auto: false, hasTask: false },
      { what: 'a busy auto session', state: 'working', auto: true, hasTask: true },
    ];

    for (const { what, state, auto, hasTask } of combinations) {
      it(`counts ${what}`, async () => {
        tq.setDesignationDef('Code Review', { sessionCap: 1 });
        tq.designations.set(7, 'Code Review');
        if (auto) tq.autoSessions.add(7);
        if (hasTask) tq.activeTaskBySession.set(7, '999');

        await queueStrictTask('Code Review', [{ name: '7', num: 7, state }]);

        expect(sessionManager.createSession).not.toHaveBeenCalled();
      });
    }

    // The fourth combination — idle AND auto — cannot reach the cap check at
    // all, and the reason matters more than the coverage: such a session is a
    // host, so the queue dispatches to it and returns before any spawn is
    // considered. A cap bounds how many sessions hive CREATES; it must never
    // bound how much work an existing session is given, or a full lane would
    // stop accepting tasks it is perfectly able to run.
    it('still gives work to an existing session when the lane is full', async () => {
      // Spy rather than let it run: _dispatchTask does real relay and tmux
      // work. Stubbing it keeps the target observable, and the task stays
      // queued, which is the harder case — the auto-create block runs again
      // and still must not spawn.
      const dispatched = vi.spyOn(tq, '_dispatchTask').mockResolvedValue(undefined);
      tq.setDesignationDef('Code Review', { sessionCap: 0 }); // would block any spawn
      tq.designations.set(7, 'Code Review');
      tq.autoSessions.add(7);

      await queueStrictTask('Code Review', [{ name: '7', num: 7, state: 'idle' }]);

      // The work landed on the existing session, cap or no cap.
      expect(dispatched).toHaveBeenCalled();
      expect(dispatched.mock.calls[0][1]).toBe(7);
      // And nothing spawned — but that is equally true when the cap blocks a
      // spawn, so it proves nothing on its own. The cap logs when it turns a
      // spawn away, and it is silent here: the loop returned at the host
      // check, before the cap was ever read.
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      const capLogs = logModule.info.mock.calls.filter(([m]) => /at session cap/.test(m));
      expect(capLogs).toEqual([]);
    });
  });

  // Flexible is the DEFAULT match mode, and every test above uses strict —
  // because in flexible mode an idle undesignated session usually hosts the
  // task and the spawn decision is never reached. The cap check does not read
  // matchMode, so the enforcement is the same; what differs is whether you get
  // to it, and that is worth pinning for the mode most PMs actually run.
  describe('flexible matching', () => {
    const queueFlexibleTask = (designation, fleetSessions) => {
      fleetModule.getFleetStatus.mockResolvedValue(fleetSessions);
      tq._pmManager = {
        pms: new Map([['1', { name: 'FlexPM', designationMatch: 'flexible', autoCreate: true }]]),
        serialize: () => ({ pms: [], knowledgeBase: [] }),
        enrichTaskText: (task) => task.text,
      };
      tq.createTask('needs a session', 'auto', null, designation, { source: 'pm:FlexPM' });
      return new Promise((r) => setTimeout(r, 50));
    };

    it('refuses to spawn once the lane is at its cap', async () => {
      tq.setDesignationDef('Code Review', { sessionCap: 1 });
      tq.designations.set(7, 'Code Review'); // fills the lane; started by hand
      tq.autoSessions.add(1);
      tq.activeTaskBySession.set(1, '999'); // undesignated but busy, so no host

      await queueFlexibleTask('Code Review', [
        { name: '1', num: 1, state: 'working' },
        { name: '7', num: 7, state: 'idle' },
      ]);

      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    // The property that makes a cap safe to set: it bounds what hive CREATES,
    // never what an existing session is given. A capped lane that could not
    // borrow an idle session would stall its own work.
    it('still lends the lane an undesignated session while it is capped out', async () => {
      const dispatched = vi.spyOn(tq, '_dispatchTask').mockResolvedValue(undefined);
      tq.setDesignationDef('Code Review', { sessionCap: 0 }); // nothing may spawn
      tq.autoSessions.add(1); // idle, undesignated

      await queueFlexibleTask('Code Review', [{ name: '1', num: 1, state: 'idle' }]);

      expect(dispatched).toHaveBeenCalled();
      expect(dispatched.mock.calls[0][1]).toBe(1);
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    // A borrowed session keeps its lack of designation — only sessions hive
    // creates are stamped — so it is not counted. The cap bounds the five hive
    // spawns, not the borrowed ones working the same lane. Stated here because
    // it is surprising, and because a future change to counting would break
    // this test and should.
    it('does not count a borrowed session toward the lane', async () => {
      vi.spyOn(tq, '_dispatchTask').mockResolvedValue(undefined);
      tq.setDesignationDef('Code Review', { sessionCap: 5 });
      tq.autoSessions.add(1);

      await queueFlexibleTask('Code Review', [{ name: '1', num: 1, state: 'idle' }]);

      expect(tq._countDesignationSessions([{ num: 1 }], 'Code Review')).toBe(0);
      expect(tq.designations.get(1)).toBeUndefined();
    });
  });

  describe('what the cap never touches', () => {
    it('does not block a session started by hand', async () => {
      tq.setDesignationDef('Code Review', { sessionCap: 0 });
      tq.designations.set(7, 'Code Review');
      fleetModule.getFleetStatus.mockResolvedValue([{ name: '7', num: 7, state: 'idle' }]);

      await tq.spawnSession({ num: 9, name: 'webplatform', baseDir: '/tmp/x' });

      expect(sessionManager.createSession).toHaveBeenCalled();
    });
  });

  // The cap lives ON the designation rather than in a map keyed by its name.
  // These are the cases that drove that choice: a name-keyed store is the one
  // rename and remove would have failed to update, leaving a cap configured
  // for a designation that had moved or gone.
  describe('the cap belongs to the designation', () => {
    it('follows a rename', () => {
      tq.setDesignationDef('Code Review', { sessionCap: 5 });

      expect(tq.renameDesignationDef('Code Review', 'PR Review')).toBe(true);

      expect(tq.designationDefs.get('PR Review').sessionCap).toBe(5);
      expect(tq.designationDefs.has('Code Review')).toBe(false);
    });

    it('goes away with the designation', () => {
      tq.setDesignationDef('Code Review', { sessionCap: 5 });

      tq.removeDesignationDef('Code Review');

      expect(tq.designationDefs.has('Code Review')).toBe(false);
    });

    it('survives an update that does not mention it', () => {
      tq.setDesignationDef('Code Review', { sessionCap: 5 });

      // What an agent sends: the PM export tells sessions to call
      // designationDef:set with these fields and no cap. Rebuilding the def
      // from them must not quietly uncap the lane.
      tq.setDesignationDef('Code Review', {
        description: 'PR review work',
        color: 'purple',
        agentFiles: ['/x.md'],
      });

      expect(tq.designationDefs.get('Code Review').sessionCap).toBe(5);
      expect(tq.designationDefs.get('Code Review').description).toBe('PR review work');
    });

    it('can be cleared on purpose', () => {
      tq.setDesignationDef('Code Review', { sessionCap: 5 });

      tq.setDesignationDef('Code Review', { sessionCap: null });

      expect(tq.designationDefs.get('Code Review').sessionCap).toBeUndefined();
    });

    it('round-trips through saved state', () => {
      tq.setDesignationDef('Code Review', { sessionCap: 5 });

      const written = fs.writeFileSync.mock.calls.at(-1)[1];
      fs.readFileSync.mockReturnValue(written);
      const reloaded = new TaskQueue(config, createMockWatcher(), router);

      expect(reloaded.designationDefs.get('Code Review').sessionCap).toBe(5);
    });

    // State is hand-edited often enough that this is not theoretical. A cap
    // written as a string passes Number.isInteger nowhere, so it would enforce
    // nothing and render no badge — configured, and completely inert.
    it('normalises a cap that was hand-written into state', () => {
      fs.readFileSync.mockReturnValue(
        JSON.stringify({
          designationDefs: [
            { name: 'Code Review', sessionCap: '5' },
            { name: 'Manual QA', sessionCap: 'lots' },
          ],
        }),
      );

      const loaded = new TaskQueue(config, createMockWatcher(), router);

      expect(loaded.designationDefs.get('Code Review').sessionCap).toBe(5);
      expect(loaded.designationDefs.get('Manual QA')).not.toHaveProperty('sessionCap');
    });

    it('refuses a value that could never cap anything', () => {
      // A NaN cap compares false against every count, so it would sit on the
      // def looking configured while enforcing nothing.
      tq.setDesignationDef('Code Review', { sessionCap: 'five' });
      expect(tq.designationDefs.get('Code Review').sessionCap).toBeUndefined();

      tq.setDesignationDef('Manual QA', { sessionCap: -1 });
      expect(tq.designationDefs.get('Manual QA').sessionCap).toBeUndefined();
    });

    it('keeps zero, which is a real cap', () => {
      tq.setDesignationDef('Code Review', { sessionCap: 0 });

      expect(tq.designationDefs.get('Code Review').sessionCap).toBe(0);
    });

    it('leaves the cap alone when a rename is refused', () => {
      tq.setDesignationDef('Code Review', { sessionCap: 5 });
      tq.setDesignationDef('Manual QA', { sessionCap: 2 });

      // Refused: the target name is taken.
      expect(tq.renameDesignationDef('Code Review', 'Manual QA')).toBe(false);

      expect(tq.designationDefs.get('Code Review').sessionCap).toBe(5);
      expect(tq.designationDefs.get('Manual QA').sessionCap).toBe(2);
    });

    // The tests above prove the field survives a rename. This proves the
    // feature does — the cap and the session assignments it counts have to
    // move together, and they are rewritten by different lines of
    // renameDesignationDef. A cap that travelled while the assignments did not
    // would still enforce, against a count of zero.
    it('still enforces after the designation is renamed', async () => {
      tq.setDesignationDef('Code Review', { sessionCap: 1 });
      tq.designations.set(7, 'Code Review');

      expect(tq.renameDesignationDef('Code Review', 'PR Review')).toBe(true);

      await queueStrictTask('PR Review', [{ name: '7', num: 7, state: 'idle' }]);

      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });
  });
});
