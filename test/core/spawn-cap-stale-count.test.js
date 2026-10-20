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
 * The repo session cap counts live sessions out of `sessions` — a snapshot
 * taken once at the top of _tryAutoDispatch and never refreshed. Auto-create
 * then loops over designation lanes, and each lane re-tested that same starting
 * count, so the cap was enforced once per round instead of once per spawn.
 *
 * Seen in the wild: a fleet capped at 21 webplatform sessions, one session
 * closed to make room, and a single round spawned two — an undesignated session
 * for the top Release Work task and a Code Review session for a queued
 * /review-pr — leaving 22 live against a cap of 21.
 *
 * The mock config maps every session to /home/user/dev/session-<n>, and
 * repoBaseName strips the trailing digits, so all of them share the repo name
 * 'session-'.
 */
describe('repo session cap counts what the round already spawned', () => {
  let tq, config, router;
  const REPO = 'session-';

  // Two live sessions, neither of them an auto session — so no lane can find an
  // idle host and every lane wants to spawn.
  const liveFleet = [
    { num: 1, state: 'working' },
    { num: 2, state: 'working' },
  ];

  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue(liveFleet);
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
    tq.autoCreateForManualTasks = true;
  });

  afterEach(() => vi.restoreAllMocks());

  // createTask kicks off _tryAutoDispatch without awaiting it; wait that run out
  // rather than racing it.
  const settle = () => vi.waitFor(() => expect(tq._autoDispatching).toBe(false));

  // Two lanes in one round: an undesignated task and a designated one.
  const queueTwoLanes = () => {
    tq.createTask('undesignated work', 'auto', null, null);
    tq.createTask('/review-pr https://example.test/pull/1', 'auto', null, 'Code Review');
  };

  it('spawns only up to the cap when two lanes want a session in one round', async () => {
    tq.repoSessionCaps.set(REPO, 3); // 2 live + room for exactly 1 more

    queueTwoLanes();
    await settle();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
  });

  it('refuses both when the repo is already at the cap', async () => {
    tq.repoSessionCaps.set(REPO, 2); // 2 live, no room

    queueTwoLanes();
    await settle();

    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('still lets every lane spawn when the cap leaves room for all of them', async () => {
    tq.repoSessionCaps.set(REPO, 9);

    queueTwoLanes();
    await settle();

    // The control: the fix must not suppress spawning generally, only spawning
    // past the cap.
    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
  });

  it('leaves an uncapped repo alone', async () => {
    // No entry in repoSessionCaps at all.
    queueTwoLanes();
    await settle();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
  });

  // createSession reports `skipped` when the slot turned out to be live already
  // — taken between getAvailableSlots' read and the spawn. The snapshot did not
  // hold it either, so the repo still has one more session than the next lane's
  // count would say.
  it('counts a slot that turned out to be live already', async () => {
    sessionManager.createSession.mockResolvedValue({ created: false, skipped: true });
    tq.repoSessionCaps.set(REPO, 3);

    queueTwoLanes();
    await settle();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
  });

  // The other side of that: a slot the snapshot DOES hold, whose session went
  // away before getAvailableSlots read the fleet again, is one session, not two.
  // Charging it twice would make the round spawn one short of the cap.
  it('does not count a slot the snapshot already holds twice', async () => {
    // Round start sees 1, 2 and 3; by the time slots are read, 3 is gone.
    fleetModule.getFleetStatus
      .mockResolvedValueOnce([...liveFleet, { num: 3, state: 'working' }])
      .mockResolvedValue(liveFleet);
    tq.repoSessionCaps.set(REPO, 4); // 3 counted at the start: room for 1 more
    // The review lane is strict here. A flexible one would take the undesignated
    // session just created in slot 3 — which the snapshot shows as live — as a
    // booting host and never reach the cap.
    tq._pmManager = {
      pms: new Map([['1', { name: 'StrictPM', designationMatch: 'strict', autoCreate: true }]]),
      serialize: () => ({ pms: [], knowledgeBase: [] }),
      enrichTaskText: (task) => task.text,
    };

    tq.createTask('undesignated work', 'auto', null, null);
    tq.createTask('review', 'auto', null, 'Code Review', { source: 'pm:StrictPM' });
    await settle();

    // Slot 3 is re-created (the fleet is back to 3) and slot 4 fills the cap.
    expect(sessionManager.createSession.mock.calls.map((c) => c[0])).toEqual(['3', '4']);
  });

  // The count is per repo because a lane's repo comes from the slot it picks.
  // A single round-wide counter would pass every test above and still wrongly
  // refuse this: the first lane lands in alpha, and beta — empty, cap 1 — must
  // not be charged for it.
  it("does not charge one repo for another repo's spawn", async () => {
    // Live sessions 1 and 2 are alpha; the free slots 3 and 4 are alpha and beta.
    config.sessions.repoDir = (num) => (num <= 3 ? `/dev/alpha${num}` : `/dev/beta${num}`);
    tq.repoSessionCaps.set('alpha', 3);
    tq.repoSessionCaps.set('beta', 1);

    queueTwoLanes();
    await settle();

    expect(sessionManager.createSession.mock.calls.map((c) => c[1])).toEqual([
      '/dev/alpha3',
      '/dev/beta4',
    ]);
  });
});

/**
 * The designation cap (#349) counts out of the same stale snapshot, through
 * _countDesignationSessions, so it had the same defect. It is only reachable
 * when one designation forms more than one lane in a round — lanes are keyed
 * by designation AND match mode, so a strict PM and a flexible PM (or a
 * dashboard task, which is flexible) queueing the same designation.
 */
describe('designation session cap counts what the round already spawned', () => {
  let tq, config, router;
  const DESIG = 'Code Review';

  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    // Neither live session is an auto session, so no lane finds a host.
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([
      { num: 1, state: 'working' },
      { num: 2, state: 'working' },
    ]);
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
    tq._pmManager = {
      pms: new Map([
        ['1', { name: 'StrictPM', designationMatch: 'strict', autoCreate: true }],
        ['2', { name: 'FlexPM', designationMatch: 'flexible', autoCreate: true }],
      ]),
      serialize: () => ({ pms: [], knowledgeBase: [] }),
      enrichTaskText: (task) => task.text,
    };
    tq.designations.set(2, DESIG); // the lane already holds one session
  });

  afterEach(() => vi.restoreAllMocks());

  const settle = () => vi.waitFor(() => expect(tq._autoDispatching).toBe(false));

  it('spawns only up to the cap when one designation has two lanes', async () => {
    tq.setDesignationDef(DESIG, { sessionCap: 2 }); // 1 live + room for exactly 1

    tq.createTask('strict review', 'auto', null, DESIG, { source: 'pm:StrictPM' });
    tq.createTask('flexible review', 'auto', null, DESIG, { source: 'pm:FlexPM' });
    await settle();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
  });

  it('still lets both lanes spawn when the cap leaves room', async () => {
    tq.setDesignationDef(DESIG, { sessionCap: 3 });

    tq.createTask('strict review', 'auto', null, DESIG, { source: 'pm:StrictPM' });
    tq.createTask('flexible review', 'auto', null, DESIG, { source: 'pm:FlexPM' });
    await settle();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
  });

  // The spawned session is charged to the designation it was stamped with, not
  // to every lane: a Manual QA spawn must not fill the Code Review lane.
  it("does not charge one designation for another's spawn", async () => {
    tq.setDesignationDef('Manual QA', { sessionCap: 1 }); // empty, room for 1
    tq.setDesignationDef(DESIG, { sessionCap: 2 }); // room for 1

    tq.createTask('qa', 'auto', null, 'Manual QA', { source: 'pm:StrictPM' });
    tq.createTask('review', 'auto', null, DESIG, { source: 'pm:StrictPM' });
    await settle();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
  });
});
