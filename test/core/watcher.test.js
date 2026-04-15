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

  describe('API error retry', () => {
    it('retries session that went idle with API error', async () => {
      const retrySpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);

      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue(
        'Reading file.js\n  ⎿  API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}\n\n❯ '
      );
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      await watcher._seed();

      // Transition to working then back to idle (triggers seenWorking)
      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._poll();
      await watcher._poll(); // 2nd poll → seenWorking

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      // 5 idle polls to trigger confirmation
      for (let i = 0; i < 5; i++) await watcher._poll();

      expect(retrySpy).toHaveBeenCalledWith(
        expect.objectContaining({ num: 6, retryCount: 1, maxRetries: 3 })
      );
      expect(mockNode.sendKeys).toHaveBeenCalledWith(
        expect.stringContaining('6'), 'retry', true
      );
    });

    it('does not retry when no API error present', async () => {
      const retrySpy = vi.fn();
      const idleSpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);
      watcher.on('session:idle', idleSpy);

      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue('Task completed successfully\n\n❯ ');
      router.nodeFor.mockReturnValue(mockNode);

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      await watcher._seed();

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._poll();
      await watcher._poll();

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      expect(retrySpy).not.toHaveBeenCalled();
      expect(idleSpy).toHaveBeenCalledTimes(1);
    });

    it('stops retrying after max retries and emits idle', async () => {
      const retrySpy = vi.fn();
      const idleSpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);
      watcher.on('session:idle', idleSpy);

      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue(
        '  ⎿  API Error: 500 {"type":"error"}\n❯ '
      );
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      // Exhaust retries (3)
      watcher.errorRetries.set(6, { count: 3, lastRetryAt: 0 });
      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      // Should NOT retry, SHOULD emit idle
      expect(retrySpy).not.toHaveBeenCalled();
      expect(idleSpy).toHaveBeenCalledTimes(1);
    });

    it('clears retry count when session starts working', async () => {
      watcher = new Watcher(config, router);
      watcher.errorRetries.set(6, { count: 2, lastRetryAt: Date.now() });
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._poll();

      expect(watcher.errorRetries.has(6)).toBe(false);
    });

    it('waits for reset time before retrying rate-limited session', async () => {
      const retrySpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);

      const mockNode = createMockNode();
      // Rate limit with reset time 30 minutes from now
      const futureTime = new Date(Date.now() + 30 * 60 * 1000);
      const h = futureTime.getHours() % 12 || 12;
      const ampm = futureTime.getHours() >= 12 ? 'PM' : 'AM';
      const timeStr = `${h}:${String(futureTime.getMinutes()).padStart(2, '0')} ${ampm}`;
      mockNode.capturePane.mockResolvedValue(
        `⚠ Usage limit reached. Resets at ${timeStr} EDT.\n❯ `
      );
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      // Should emit event with retryAfter but NOT send keys (waiting for reset)
      expect(retrySpy).toHaveBeenCalledWith(
        expect.objectContaining({ num: 6, retryAfter: expect.any(Number), waitMins: expect.any(Number) })
      );
      expect(mockNode.sendKeys).not.toHaveBeenCalled();
    });

    // Regression: expanded pattern coverage (timeouts, network, HTTP 502/503/504)
    const RETRYABLE_FIXTURES = [
      ['Request timed out', 'API Error (Request timed out.) · Retrying in 1s... (attempt 1/10)\n❯ '],
      ['Stream idle timeout', '  ⎿  API Error: Stream idle timeout - partial response received\n❯ '],
      ['Connection error',    '  ⎿  API Error (Connection error.) · Retrying in 1s... (attempt 1/3)\n❯ '],
      ['ECONNRESET',          '  ⎿  API Error: fetch failed (ECONNRESET)\n❯ '],
      ['ETIMEDOUT',           '  ⎿  Error: connect ETIMEDOUT 104.18.32.115:443\n❯ '],
      ['socket hang up',      '  ⎿  API Error: socket hang up\n❯ '],
      ['fetch failed',        '  ⎿  TypeError: fetch failed\n❯ '],
      ['HTTP 502',            '  ⎿  API Error: 502 Bad Gateway\n❯ '],
      ['HTTP 503',            '  ⎿  API Error: 503 Service Unavailable\n❯ '],
      ['HTTP 504',            '  ⎿  API Error: 504 {"type":"error","error":{"type":"timeout_error"}}\n❯ '],
      ['HTTP 408',            '  ⎿  API Error: 408 Request Timeout\n❯ '],
      ['Unable to connect',   '  ⎿  Unable to connect to the API. Check your internet connection.\n❯ '],
    ];

    for (const [label, paneContent] of RETRYABLE_FIXTURES) {
      it(`retries on: ${label}`, async () => {
        const retrySpy = vi.fn();
        watcher = new Watcher(config, router);
        watcher.on('session:error-retry', retrySpy);

        const mockNode = createMockNode();
        mockNode.capturePane.mockResolvedValue(paneContent);
        mockNode.sendKeys.mockResolvedValue(null);
        router.nodeFor.mockReturnValue(mockNode);

        watcher.seenWorking.add(6);
        watcher.prevStates.set(6, 'idle');

        fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
        for (let i = 0; i < 5; i++) await watcher._poll();

        expect(retrySpy).toHaveBeenCalledWith(
          expect.objectContaining({ num: 6, retryCount: 1, maxRetries: 3 })
        );
        expect(mockNode.sendKeys).toHaveBeenCalledWith(
          expect.stringContaining('6'), 'retry', true
        );
      });
    }

    it('retries after reset time has passed', async () => {
      const retrySpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);

      const mockNode = createMockNode();
      // Error without reset time (plain 500)
      mockNode.capturePane.mockResolvedValue(
        '  ⎿  API Error: 500 {"type":"error"}\n❯ '
      );
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      // Set retryAfter to the past — should retry now
      watcher.errorRetries.set(6, { count: 0, lastRetryAt: 0, retryAfter: Date.now() - 1000 });
      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      expect(mockNode.sendKeys).toHaveBeenCalledWith(
        expect.stringContaining('6'), 'retry', true
      );
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
