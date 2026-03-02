import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockNode } from '../helpers/mocks.js';

// Use createRequire to get the same CJS module objects that watcher.js uses
const require = createRequire(import.meta.url);
const fleet = require('../../src/core/fleet');
const log = require('../../src/core/log');
const Watcher = require('../../src/core/watcher');

describe('Watcher', () => {
  let watcher, config, router, fleetSpy;

  beforeEach(() => {
    vi.useFakeTimers();

    // Spy on the exact same fleet object that watcher.js imported via require()
    fleetSpy = vi.spyOn(fleet, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleet, 'peekSession').mockResolvedValue('');
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});

    config = createMockConfig({ watcher: { interval: 1000 } });
    router = {
      nodeFor: vi.fn().mockReturnValue(createMockNode()),
      listAllSessions: vi.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    if (watcher) watcher.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeSession(num, state, pr = null) {
    return {
      name: `${num}-session`, num, state,
      branch: `feature-${num}`, ticket: `DEV-${num}`,
      git: { branch: `feature-${num}`, staged: 0, modified: 0, untracked: 0 },
      pr,
    };
  }

  describe('session state transitions', () => {
    it('emits session:working when session transitions to working', async () => {
      const spy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:working', spy);

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      await watcher._seed();

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._poll();

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ num: 6 }));
    });

    it('emits session:idle after 5 consecutive idle polls', async () => {
      const spy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:idle', spy);

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      await watcher._seed();

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._poll(); // 1st working poll
      await watcher._poll(); // 2nd working poll — seenWorking requires 2 consecutive

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 4; i++) {
        await watcher._poll();
        expect(spy).not.toHaveBeenCalled();
      }
      await watcher._poll();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT emit idle on startup', async () => {
      const spy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:idle', spy);

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      await watcher._seed();

      for (let i = 0; i < 10; i++) await watcher._poll();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('CI/review change events', () => {
    it('emits ci:changed when CI status changes', async () => {
      const spy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('ci:changed', spy);

      fleetSpy.mockResolvedValue([
        makeSession(6, 'idle', { ciResult: 'SUCCESS', prNum: '42', review: '' }),
      ]);
      await watcher._seed();

      fleetSpy.mockResolvedValue([
        makeSession(6, 'idle', { ciResult: 'FAILURE', prNum: '42', review: '' }),
      ]);
      await watcher._poll();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'SUCCESS', to: 'FAILURE', pr: '42' })
      );
    });

    it('emits review:changed when review status changes', async () => {
      const spy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('review:changed', spy);

      // _seed only stores prevCI, not prevReview. Need a poll to establish baseline.
      fleetSpy.mockResolvedValue([
        makeSession(6, 'idle', { ciResult: '', prNum: '42', review: 'APPROVED' }),
      ]);
      await watcher._seed();
      await watcher._poll(); // establishes prevReview

      // Now change review status
      fleetSpy.mockResolvedValue([
        makeSession(6, 'idle', { ciResult: '', prNum: '42', review: 'CHANGES_REQUESTED' }),
      ]);
      await watcher._poll();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'APPROVED', to: 'CHANGES_REQUESTED' })
      );
    });
  });

  describe('approval detection', () => {
    it('emits approval:requested when pattern detected', async () => {
      const spy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('approval:requested', spy);

      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue('Do you want to proceed? (y/n)');
      router.nodeFor.mockReturnValue(mockNode);

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._checkApprovals();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ num: 6, prompt: expect.stringContaining('(y/n)') })
      );
    });

    it('does not re-emit for already detected', async () => {
      const spy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('approval:requested', spy);

      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue('(y/n)');
      router.nodeFor.mockReturnValue(mockNode);

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._checkApprovals();
      await watcher._checkApprovals();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('start / stop', () => {
    it('start begins polling and stop clears intervals', async () => {
      watcher = new Watcher(config, router);
      fleetSpy.mockResolvedValue([]);
      await watcher.start();
      expect(watcher.interval).toBeTruthy();
      watcher.stop();
      expect(watcher.interval).toBeNull();
    });
  });
});
