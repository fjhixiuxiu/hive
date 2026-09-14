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

/**
 * Queue order is Map insertion order — _tryAutoDispatch walks
 * this.tasks.values() with no sort of its own. Everything here is about making
 * that one order both controllable and honestly reported.
 */
describe('queue position', () => {
  let tq;

  const queuedIds = () =>
    Array.from(tq.tasks.values())
      .filter((t) => t.status === 'queued')
      .map((t) => t.id);
  // What the dispatcher will actually walk, so the tests assert on dispatch
  // order rather than on the display's opinion of it.
  const dispatchOrder = () =>
    Array.from(tq.tasks.values())
      .filter((t) => t.status === 'queued')
      .map((t) => t.text);

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(sessionManagerModule, 'createSession').mockRejectedValue(new Error('no tmux in test'));
    vi.spyOn(sessionManagerModule, 'startClaude').mockResolvedValue();

    const router = new NodeRouter();
    router.addNode(createMockNode());
    tq = new TaskQueue(createMockConfig(), createMockWatcher(), router);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('default behaviour is unchanged', () => {
    it('puts a new task at the back when no position is given', () => {
      tq.createTask('first', 'auto', null, null);
      tq.createTask('second', 'auto', null, null);
      tq.createTask('third', 'auto', null, null);

      expect(dispatchOrder()).toEqual(['first', 'second', 'third']);
    });

    it('treats an explicit null the same as absent', () => {
      tq.createTask('first', 'auto', null, null);
      tq.createTask('second', 'auto', null, null, { queuePosition: null });

      expect(dispatchOrder()).toEqual(['first', 'second']);
    });
  });

  describe('creating at a position', () => {
    beforeEach(() => {
      tq.createTask('a', 'auto', null, null);
      tq.createTask('b', 'auto', null, null);
      tq.createTask('c', 'auto', null, null);
    });

    it('position 1 goes to the front', () => {
      tq.createTask('urgent', 'auto', null, null, { queuePosition: 1 });

      expect(dispatchOrder()).toEqual(['urgent', 'a', 'b', 'c']);
    });

    it('a middle position lands exactly there', () => {
      tq.createTask('middle', 'auto', null, null, { queuePosition: 2 });

      expect(dispatchOrder()).toEqual(['a', 'middle', 'b', 'c']);
    });

    it('clamps a position past the end to the back', () => {
      tq.createTask('last', 'auto', null, null, { queuePosition: 99 });

      expect(dispatchOrder()).toEqual(['a', 'b', 'c', 'last']);
    });

    it('clamps zero and negatives to the front', () => {
      tq.createTask('zero', 'auto', null, null, { queuePosition: 0 });
      tq.createTask('negative', 'auto', null, null, { queuePosition: -5 });

      expect(dispatchOrder()).toEqual(['negative', 'zero', 'a', 'b', 'c']);
    });

    it('reports the position it was actually given', () => {
      const task = tq.createTask('urgent', 'auto', null, null, { queuePosition: 1 });

      expect(tq.getQueuePosition(task.id)).toBe(1);
    });
  });

  describe('counting only queued tasks', () => {
    it('skips over dispatched tasks when finding the slot', () => {
      const a = tq.createTask('a', 'auto', null, null);
      tq.createTask('b', 'auto', null, null);
      tq.createTask('c', 'auto', null, null);
      // 'a' leaves the queue but stays in the Map, interleaved with the rest.
      a.status = 'dispatched';

      tq.createTask('second-in-queue', 'auto', null, null, { queuePosition: 2 });

      // Position 2 means 2nd among QUEUED, which is after 'b', not after 'a'.
      expect(dispatchOrder()).toEqual(['b', 'second-in-queue', 'c']);
    });

    it('does not disturb the order of non-queued tasks', () => {
      const a = tq.createTask('a', 'auto', null, null);
      const b = tq.createTask('b', 'auto', null, null);
      a.status = 'completed';
      b.status = 'dispatched';
      tq.createTask('c', 'auto', null, null);
      const before = Array.from(tq.tasks.values())
        .filter((t) => t.status !== 'queued')
        .map((t) => t.text);

      tq.createTask('new', 'auto', null, null, { queuePosition: 1 });

      expect(
        Array.from(tq.tasks.values())
          .filter((t) => t.status !== 'queued')
          .map((t) => t.text),
      ).toEqual(before);
    });
  });

  describe('moveTaskToQueuePosition', () => {
    let a, b, c;
    beforeEach(() => {
      a = tq.createTask('a', 'auto', null, null);
      b = tq.createTask('b', 'auto', null, null);
      c = tq.createTask('c', 'auto', null, null);
    });

    it('moves a task forward', () => {
      tq.moveTaskToQueuePosition(c.id, 1);

      expect(dispatchOrder()).toEqual(['c', 'a', 'b']);
    });

    it('moves a task backward', () => {
      tq.moveTaskToQueuePosition(a.id, 3);

      expect(dispatchOrder()).toEqual(['b', 'c', 'a']);
    });

    it('refuses to move a task that is not queued', () => {
      b.status = 'dispatched';

      expect(tq.moveTaskToQueuePosition(b.id, 1)).toBeNull();
      expect(queuedIds()).toEqual([a.id, c.id]);
    });

    it('returns null for an unknown task', () => {
      expect(tq.moveTaskToQueuePosition('nope', 1)).toBeNull();
    });

    it('keeps the same Map object so held references stay valid', () => {
      const ref = tq.tasks;

      tq.moveTaskToQueuePosition(c.id, 1);

      expect(tq.tasks).toBe(ref);
      expect(tq.tasks.size).toBe(3);
    });
  });

  describe('getQueuePosition reports the dispatch order', () => {
    it('does not fall back to createdAt', () => {
      const older = tq.createTask('older', 'auto', null, null);
      const newer = tq.createTask('newer', 'auto', null, null);
      // Make the newer task look much older than it is. Sorting by createdAt
      // would put it first; the queue it is actually in says otherwise.
      newer.createdAt = older.createdAt - 60_000;

      expect(tq.getQueuePosition(older.id)).toBe(1);
      expect(tq.getQueuePosition(newer.id)).toBe(2);
    });

    it('follows a task that has been moved', () => {
      tq.createTask('a', 'auto', null, null);
      const target = tq.createTask('b', 'auto', null, null);
      tq.createTask('c', 'auto', null, null);
      expect(tq.getQueuePosition(target.id)).toBe(2);

      tq.moveTaskToQueuePosition(target.id, 1);

      expect(tq.getQueuePosition(target.id)).toBe(1);
    });

    it('returns null for a task that is not queued', () => {
      const t = tq.createTask('a', 'auto', null, null);
      t.status = 'dispatched';

      expect(tq.getQueuePosition(t.id)).toBeNull();
    });
  });
});
