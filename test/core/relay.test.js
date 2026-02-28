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
      node.capturePane.mockResolvedValue('Response from Claude');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello');

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;
      expect(node.sendKeys).toHaveBeenCalledWith('6-DEV:.1', 'hello', true);
      expect(result.success).toBe(true);
    });

    it('respects timeout', async () => {
      let first = true;
      tmux.detectState.mockImplementation(() => {
        if (first) { first = false; return 'idle'; }
        return 'working';
      });
      node.capturePane.mockResolvedValue('still working...');

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
      node.capturePane.mockResolvedValue('busy');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello', { force: true });

      // With force=true, it should send despite busy state
      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;

      expect(node.sendKeys).toHaveBeenCalled();
      expect(result.success).toBe(false); // times out because never idle
    });

    it('with vimMode sends Escape+i before message', async () => {
      tmux.detectState.mockReturnValue('idle');
      node.capturePane.mockResolvedValue('done');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello', { vimMode: true });
      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise;

      expect(node.exec).toHaveBeenCalledWith(expect.stringContaining('Escape'));
      expect(node.exec).toHaveBeenCalledWith(expect.stringContaining(' i'));
    });

    it('calls onProgress callback', async () => {
      let first = true;
      tmux.detectState.mockImplementation(() => {
        if (first) { first = false; return 'idle'; }
        return 'idle';
      });
      node.capturePane.mockResolvedValue('done');

      const onProgress = vi.fn();
      const resultPromise = relay.ask(config, node, '6-DEV', 'hello', { onProgress });

      await vi.advanceTimersByTimeAsync(500);
      await resultPromise;

      expect(onProgress).toHaveBeenCalledWith('Message sent, waiting for response...');
    });
  });

  describe('tell', () => {
    it('sends without waiting', async () => {
      tmux.detectState.mockReturnValue('idle');
      node.capturePane.mockResolvedValue('ready');
      node.exec.mockResolvedValue('');

      // tell() uses setTimeout(100) internally, must advance timers
      const resultPromise = relay.tell(config, node, '6-DEV', 'do something');
      await vi.advanceTimersByTimeAsync(200);
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

      const result = await relay.tell(config, node, '6-DEV', 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to send');
    });
  });
});
