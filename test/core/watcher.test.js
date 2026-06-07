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
        expect.objectContaining({ num: 6, retryCount: 1 })
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

    it('keeps retrying past the old cap (no max) and does not confirm idle', async () => {
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

      // Already well past the old 3-retry cap, and the backoff window has elapsed
      // (lastRetryAt long ago) so another retry is due.
      watcher.errorRetries.set(6, { count: 9, lastRetryAt: 1 });
      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      // Should STILL retry (attempt 10) and must NOT give up / confirm idle.
      expect(retrySpy).toHaveBeenCalledWith(
        expect.objectContaining({ num: 6, retryCount: 10 })
      );
      expect(mockNode.sendKeys).toHaveBeenCalledWith(
        expect.stringContaining('6'), 'retry', true
      );
      expect(idleSpy).not.toHaveBeenCalled();
    });

    it('honors the backoff window between retries', async () => {
      watcher = new Watcher(config, router);

      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue('  ⎿  API Error: 500 {"type":"error"}\n❯ ');
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      // A retry just happened (count 1 → backoff 30s) so the next attempt is not due yet.
      watcher.errorRetries.set(6, { count: 1, lastRetryAt: Date.now() });
      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      // Inside the backoff window → no new retry sent, but the session stays in
      // recovery (no idle confirmation).
      expect(mockNode.sendKeys).not.toHaveBeenCalled();
    });

    it('clears retry count only after confirmed working (2 polls)', async () => {
      watcher = new Watcher(config, router);
      watcher.errorRetries.set(6, { count: 2, lastRetryAt: Date.now() });
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._poll();
      // One working poll is a possible retry flicker — budget must survive.
      expect(watcher.errorRetries.has(6)).toBe(true);

      await watcher._poll();
      // Second consecutive working poll = genuine recovery → budget cleared.
      expect(watcher.errorRetries.has(6)).toBe(false);
    });

    it('resets the retry budget when the error clears on its own', async () => {
      watcher = new Watcher(config, router);

      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue('All done. \n\n❯ ');
      router.nodeFor.mockReturnValue(mockNode);

      watcher.errorRetries.set(6, { count: 4, lastRetryAt: 1 });
      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      // 5 idle polls → idle confirmation runs the error check, finds no error, clears budget.
      for (let i = 0; i < 5; i++) await watcher._poll();

      expect(watcher.errorRetries.has(6)).toBe(false);
    });

    // Decoupling guarantee: the retry must NOT depend on the idle/working verdict.
    it('retries a stalled session even when state is reported as working', async () => {
      const retrySpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);

      const mockNode = createMockNode();
      // Error present, no active spinner — but detectState reports 'working' (the
      // failure mode we don't trust). The retry must still fire.
      mockNode.capturePane.mockResolvedValue('  ⎿  API Error: 529 Overloaded\n❯ ');
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'working');

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      await watcher._poll();

      expect(retrySpy).toHaveBeenCalledWith(expect.objectContaining({ num: 6, retryCount: 1 }));
      expect(mockNode.sendKeys).toHaveBeenCalledWith(expect.stringContaining('6'), 'retry', true);
    });

    it('does not nudge while an active spinner is present, even with an error', async () => {
      const retrySpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);

      const mockNode = createMockNode();
      // Claude is handling its own retry (spinner with ellipsis) — leave it alone.
      mockNode.capturePane.mockResolvedValue('  ⎿  API Error: 529 Overloaded\n✻ Retrying… (esc to interrupt)\n');
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'working');

      fleetSpy.mockResolvedValue([makeSession(6, 'working')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      expect(retrySpy).not.toHaveBeenCalled();
      expect(mockNode.sendKeys).not.toHaveBeenCalled();
    });

    it('does not retry when watcher.errorRetry.enabled is false', async () => {
      const retrySpy = vi.fn();
      const disabledConfig = createMockConfig({ watcher: { interval: 1000, errorRetry: { enabled: false } } });
      watcher = new Watcher(disabledConfig, router);
      watcher.on('session:error-retry', retrySpy);

      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue('  ⎿  API Error: 529 Overloaded\n❯ ');
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'idle');

      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      expect(retrySpy).not.toHaveBeenCalled();
      expect(mockNode.sendKeys).not.toHaveBeenCalled();
    });

    it('promotes seenWorking and retries when an erroring session was never previously observed working', async () => {
      // Regression: the original "skip if !seenWorking" gate deadlocked sessions
      // whose first observed event was an API error — no working→idle transition
      // could ever fire, so seenWorking never got set, so retry was forever
      // skipped. A retryable error itself is proof claude ran and made an API
      // call, so promote seenWorking on detection and proceed with the retry.
      const retrySpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);
      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue('  ⎿  API Error: 529 Overloaded\n❯ ');
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      // Intentionally do NOT add 6 to seenWorking — exactly the deadlock case.
      watcher.prevStates.set(6, 'idle');
      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      await watcher._poll();

      expect(mockNode.sendKeys).toHaveBeenCalled();
      expect(retrySpy).toHaveBeenCalled();
      expect(watcher.seenWorking.has(6)).toBe(true);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('promoting seenWorking'));
    });

    it('clears a stale detectedWaiting flag and retries when an erroring session was flagged waiting', async () => {
      // Deadlock guard: a detectedWaiting flag (e.g. from an already-answered question)
      // only clears on a working transition the stuck session can't reach. A retryable
      // error proves Claude isn't awaiting input, so the flag is stale → clear + retry.
      const retrySpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);
      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue('  ⎿  API Error: 529 Overloaded\n❯ ');
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      watcher.seenWorking.add(6);
      watcher.detectedWaiting.add(6); // stale — the question was already answered
      watcher.prevStates.set(6, 'idle');
      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      await watcher._poll();

      expect(watcher.detectedWaiting.has(6)).toBe(false);          // flag cleared
      expect(mockNode.sendKeys).toHaveBeenCalledWith(expect.stringContaining('6'), 'retry', true);
      expect(retrySpy).toHaveBeenCalledWith(expect.objectContaining({ num: 6, retryCount: 1 }));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('clearing stale detectedWaiting'));
    });

    it('does not treat Claude prose about a rate-limit as a live error (no retry loop)', async () => {
      // Regression: a recovered session explaining the earlier rate-limit must NOT be
      // read as an error. "rate-limit" only counts on an actual "API Error" line.
      const retrySpy = vi.fn();
      watcher = new Watcher(config, router);
      watcher.on('session:error-retry', retrySpy);
      const mockNode = createMockNode();
      mockNode.capturePane.mockResolvedValue(
        "● Holding. These repeated \"retry\" pings are the stale rate-limit-era queue draining; nothing is pending or over capacity.\n❯ "
      );
      mockNode.sendKeys.mockResolvedValue(null);
      router.nodeFor.mockReturnValue(mockNode);

      watcher.seenWorking.add(6);
      watcher.prevStates.set(6, 'idle');
      fleetSpy.mockResolvedValue([makeSession(6, 'idle')]);
      for (let i = 0; i < 5; i++) await watcher._poll();

      expect(retrySpy).not.toHaveBeenCalled();
      expect(mockNode.sendKeys).not.toHaveBeenCalled();
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
      // Server-side throttle with no numeric code — the message Jeff was seeing a lot of.
      ['temporarily limiting', '  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) ·\n      Rate limited\n\n❯ '],
      // TLS handshake / record errors. Real fixture from session 7:
      // "API Error: [SSL: SSLV3_ALERT_BAD_RECORD_MAC] ssl/tls alert bad record mac (_ssl.c:2548)"
      // The bracketed SSL: <UPPER_SNAKE> shape is the canonical Python ssl
      // module message — unambiguous enough to match anywhere.
      ['SSL alert bracketed', '  ⎿  API Error: [SSL: SSLV3_ALERT_BAD_RECORD_MAC] ssl/tls alert bad record mac (_ssl.c:2548)\n❯ '],
      ['SSL alert plain',     '  ⎿  API Error: ssl/tls alert handshake failure\n❯ '],
      // Real fixture from session 22 (different shape from the bracketed-alert variant):
      // "API Error: TLS/SSL connection has been closed (EOF) (_ssl.c:2396)"
      ['TLS connection closed', '  ⎿  API Error: TLS/SSL connection has been closed (EOF) (_ssl.c:2396)\n❯ '],
      // Generic catch-all via the (_ssl.c:NNNN) suffix — covers any future variant.
      ['ssl.c suffix only',    '  ⎿  API Error: some new ssl error shape (_ssl.c:9999)\n❯ '],
      // Real fixture from S:20: Anthropic's structured JSON error envelope with an
      // empty message. The `"type":"api_error"` substring is unambiguous.
      ['JSON api_error empty', '  ⎿  API Error: {"type":"error","error":{"type":"api_error","message":""}}\n❯ '],
      // Real fixture from S:12: Claude Code's auto-mode safety classifier was
      // unavailable. The bash command was blocked; platform message says to retry.
      ['auto-mode classifier unavailable', '  ⎿  Error: claude-opus-4-7 is temporarily unavailable, so auto mode cannot determine the safety of Bash right now. Wait briefly and then try this action again.\n❯ '],
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
          expect.objectContaining({ num: 6, retryCount: 1 })
        );
        expect(mockNode.sendKeys).toHaveBeenCalledWith(
          expect.stringContaining('6'), 'retry', true
        );
      });
    }

    it('only scans the LAST 15 lines, not the whole captured buffer', async () => {
      // Regression: tmux's `capture-pane -S -15 -p` extends 15 lines into
      // scrollback BEYOND the visible pane — so a default-height (~54-line)
      // pane returns ~69 lines, plenty to include old errors that have long
      // since scrolled out of the user's view. S:26 hit this loud and clear:
      // an SSL error from earlier in the conversation kept matching every
      // poll, firing endless "retry" prompts even though the live tail of
      // the pane only showed clean post-recovery prose. The fix slices to
      // the last 15 lines post-capture so we look at what's actually recent.
      const oldError = '  ⎿  API Error: [SSL: SSLV3_ALERT_BAD_RECORD_MAC] ssl/tls alert bad record mac (_ssl.c:2548)';
      const filler = Array.from({ length: 40 }, (_, i) => `  line ${i} of post-recovery work`).join('\n');
      const recentTail = [
        '⏺ Work resumed and completed.',
        '❯ ',
        '  ⏵⏵ auto mode on (shift+tab to cycle)',
      ].join('\n');
      // Pane shape: old error near the top, lots of clean activity below, then
      // a fresh tail. Total ~45 lines — well within the watcher's 69-line
      // capture window, but the LAST 15 are all clean.
      const paneContent = `${oldError}\n${filler}\n${recentTail}`;

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
      await watcher._poll();

      // No false-positive retry on a clean tail despite the old error in scrollback.
      expect(mockNode.sendKeys).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();
    });

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
