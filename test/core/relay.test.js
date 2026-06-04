import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockNode, createMockConfig } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const tmux = require('../../src/core/tmux');
const relay = require('../../src/core/relay');

describe('relay', () => {
  let node, config;

  beforeEach(() => {
    vi.useFakeTimers();

    // Spy on tmux functions that relay uses
    vi.spyOn(tmux, 'detectState');
    vi.spyOn(tmux, 'stripTUIChrome').mockImplementation((content) => content || '');

    node = createMockNode();
    config = createMockConfig({
      relay: { pollInterval: 100, cooldown: 200, timeout: 5000, streamInterval: 1000 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('ask', () => {
    it('returns error if session is busy', async () => {
      tmux.detectState.mockReturnValue('working');
      node.capturePane.mockResolvedValue('working...');

      const result = await relay.ask(config, node, '6-DEV', 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('busy');
    });

    it('returns error if Claude is off', async () => {
      tmux.detectState.mockReturnValue('off');
      node.capturePane.mockResolvedValue('[exited]');

      const result = await relay.ask(config, node, '6-DEV', 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });

    it('sends message and polls for response', async () => {
      let callCount = 0;
      tmux.detectState.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return 'idle';
        if (callCount <= 3) return 'working';
        return 'idle';
      });
      // Capture must include the message so verifyPasteLanded passes.
      node.capturePane.mockResolvedValue('Response from Claude: hello');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello');

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      const result = await resultPromise;
      // Paste sent without Enter; Enter is a separate exec call now.
      expect(node.sendKeys).toHaveBeenCalledWith('6-DEV:.1', 'hello', false);
      expect(result.success).toBe(true);
    });

    it('respects timeout', async () => {
      let first = true;
      tmux.detectState.mockImplementation(() => {
        if (first) { first = false; return 'idle'; }
        return 'working';
      });
      node.capturePane.mockResolvedValue('still working hello');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello');
      await vi.advanceTimersByTimeAsync(6000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Timed out');
    });

    it('with force=true bypasses busy check', async () => {
      let first = true;
      tmux.detectState.mockImplementation(() => {
        if (first) { first = false; return 'working'; } // initial check: busy
        return 'working'; // stays working
      });
      node.capturePane.mockResolvedValue('busy: hello');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello', { force: true });

      // With force=true, it should send despite busy state
      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;

      expect(node.sendKeys).toHaveBeenCalled();
      expect(result.success).toBe(false); // times out because never idle
    });

    it('with force=true still rejects when Claude is off (no key leak into bash)', async () => {
      // Regression: force=true must not bypass the 'off' guard. If it did,
      // vim-mode's Escape → gg dG → i clear sequence would land in the bash
      // prompt as literal "gdGi" before whatever the user typed next.
      tmux.detectState.mockReturnValue('off');
      node.capturePane.mockResolvedValue('Nukuls-MacBook-Pro:hive dev$ ');

      const result = await relay.ask(config, node, '6-DEV', 'hello', { force: true, vimMode: true });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
      // Critically, no keys were sent — clearInputVim never ran.
      expect(node.sendKeys).not.toHaveBeenCalled();
      const execCalls = node.exec.mock.calls.map(([cmd]) => cmd);
      expect(execCalls.some(c => c.includes(' g g d G'))).toBe(false);
    });

    it('with vimMode does gg-dG clear and Escape→i (no readline C-a/C-k)', async () => {
      tmux.detectState.mockReturnValue('idle');
      node.capturePane.mockResolvedValue('hello in input box');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello', { vimMode: true });
      await vi.advanceTimersByTimeAsync(3000);
      await resultPromise;

      const execCalls = node.exec.mock.calls.map(([cmd]) => cmd);
      // Vim-safe clear: Escape, gg dG, i
      expect(execCalls.some(c => c.includes(' Escape'))).toBe(true);
      expect(execCalls.some(c => c.includes(' g g d G'))).toBe(true);
      expect(execCalls.some(c => c.endsWith(' i'))).toBe(true);
      // Readline keys are unsafe in vim insert mode and must NOT be sent.
      expect(execCalls.some(c => c.includes(' C-a'))).toBe(false);
      expect(execCalls.some(c => c.includes(' C-k'))).toBe(false);
      // Paste happens with enter=false; Enter is a separate dwelled call.
      expect(node.sendKeys).toHaveBeenCalledWith('6-DEV:.1', 'hello', false);
      expect(execCalls.some(c => c.endsWith(' Enter'))).toBe(true);
    });

    it('calls onProgress callback', async () => {
      tmux.detectState.mockReturnValue('idle');
      node.capturePane.mockResolvedValue('hello here');

      const onProgress = vi.fn();
      const resultPromise = relay.ask(config, node, '6-DEV', 'hello', { onProgress });

      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise;

      expect(onProgress).toHaveBeenCalledWith('Message sent, waiting for response...');
    });

    it('still sends Enter when paste verification keeps missing (advisory, no retry)', async () => {
      tmux.detectState.mockReturnValue('idle');
      // Capture never contains the message — verification will keep "missing,"
      // but capture-after-paste racing TUI repaint is exactly what verification
      // can't distinguish from a real miss. Withholding Enter on a false miss
      // would silently drop messages, so we log + Enter anyway.
      node.capturePane.mockResolvedValue('totally unrelated content');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello-distinctive');
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      // Exactly one paste attempt — retry path was removed because it
      // deterministically doubled multi-line content (clearInputReadline
      // can't wipe a multi-line buffer between attempts).
      expect(node.sendKeys).toHaveBeenCalledTimes(1);
      // Enter is sent regardless of verification result.
      const execCalls = node.exec.mock.calls.map(([cmd]) => cmd);
      expect(execCalls.some(c => c.endsWith(' Enter'))).toBe(true);
      // ask() still completes successfully — verification is advisory.
      expect(result.success).toBe(true);
    });

    it('verifies multi-line paste via "[Pasted text #N" placeholder', async () => {
      tmux.detectState.mockReturnValue('idle');
      // TUI condenses big pastes — capture only shows the placeholder, never the
      // raw text. Verification should accept the placeholder.
      node.capturePane.mockResolvedValue('❯ [Pasted text #7 +180 lines]');

      const big = 'line1\n' + 'x'.repeat(2000) + '\nlast';
      const resultPromise = relay.ask(config, node, '6-DEV', big);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(node.sendKeys).toHaveBeenCalledTimes(1); // no retry needed
    });
  });

  describe('tell', () => {
    it('sends without waiting', async () => {
      tmux.detectState.mockReturnValue('idle');
      node.capturePane.mockResolvedValue('input box: do something');
      node.exec.mockResolvedValue('');

      const resultPromise = relay.tell(config, node, '6-DEV', 'do something');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(node.sendKeys).toHaveBeenCalledWith('6-DEV:.1', 'do something', false);
    });

    it('returns error if Claude is off', async () => {
      tmux.detectState.mockReturnValue('off');
      node.capturePane.mockResolvedValue('[exited]');

      const result = await relay.tell(config, node, '6-DEV', 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });

    it('returns error if sendKeys fails', async () => {
      tmux.detectState.mockReturnValue('idle');
      node.capturePane.mockResolvedValue('ready');
      node.sendKeys.mockRejectedValue(new Error('tmux error'));

      const resultPromise = relay.tell(config, node, '6-DEV', 'hello');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to send');
    });

    it('poll-verifies after initial dwell instead of retrying the paste', async () => {
      tmux.detectState.mockReturnValue('idle');
      // First few captures miss; later captures show the message. The
      // previous behavior retried the paste (deterministic double-body on
      // multi-line content); the new behavior keeps polling the same paste.
      let captureCalls = 0;
      node.capturePane.mockImplementation(() => {
        captureCalls++;
        // Capture sequence: #1 settle-loop state check; #2 initial-dwell
        // verify (miss); subsequent calls are poll-verify retries until hit.
        if (captureCalls < 4) return Promise.resolve('idle, no message yet');
        return Promise.resolve('finally: hello here');
      });

      const resultPromise = relay.tell(config, node, '6-DEV', 'hello');
      await vi.advanceTimersByTimeAsync(3000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      // Exactly one paste — no retry path.
      expect(node.sendKeys).toHaveBeenCalledTimes(1);
    });
  });
});
