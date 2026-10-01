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
      expect(node.sendKeys).toHaveBeenCalledWith('=6-DEV:.1', 'hello', false);
      expect(result.success).toBe(true);
    });

    it('respects timeout', async () => {
      let first = true;
      tmux.detectState.mockImplementation(() => {
        if (first) {
          first = false;
          return 'idle';
        }
        return 'working';
      });
      node.capturePane.mockResolvedValue('still working hello');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello');
      await vi.advanceTimersByTimeAsync(6000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Timed out');
      // The paste and Enter already happened — only the reply is missing.
      expect(result.delivered).toBe(true);
    });

    it('with force=true bypasses busy check', async () => {
      let first = true;
      tmux.detectState.mockImplementation(() => {
        if (first) {
          first = false;
          return 'working';
        } // initial check: busy
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

      const result = await relay.ask(config, node, '6-DEV', 'hello', {
        force: true,
        vimMode: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
      // Critically, no keys were sent — clearInputVim never ran.
      expect(node.sendKeys).not.toHaveBeenCalled();
      const execCalls = node.exec.mock.calls.map(([cmd]) => cmd);
      expect(execCalls.some((c) => c.includes(' g g d G'))).toBe(false);
    });

    it('with vimMode does gg-dG clear and Escape→i (no readline C-a/C-k)', async () => {
      tmux.detectState.mockReturnValue('idle');
      node.capturePane.mockResolvedValue('hello in input box');

      const resultPromise = relay.ask(config, node, '6-DEV', 'hello', { vimMode: true });
      await vi.advanceTimersByTimeAsync(3000);
      await resultPromise;

      const execCalls = node.exec.mock.calls.map(([cmd]) => cmd);
      // Vim-safe clear: Escape, gg dG, i
      expect(execCalls.some((c) => c.includes(' Escape'))).toBe(true);
      expect(execCalls.some((c) => c.includes(' g g d G'))).toBe(true);
      expect(execCalls.some((c) => c.endsWith(' i'))).toBe(true);
      // Readline keys are unsafe in vim insert mode and must NOT be sent.
      expect(execCalls.some((c) => c.includes(' C-a'))).toBe(false);
      expect(execCalls.some((c) => c.includes(' C-k'))).toBe(false);
      // Paste happens with enter=false; Enter is a separate dwelled call.
      expect(node.sendKeys).toHaveBeenCalledWith('=6-DEV:.1', 'hello', false);
      expect(execCalls.some((c) => c.endsWith(' Enter'))).toBe(true);
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
      expect(execCalls.some((c) => c.endsWith(' Enter'))).toBe(true);
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
      expect(node.sendKeys).toHaveBeenCalledWith('=6-DEV:.1', 'do something', false);
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

  // What an idle Claude pane receives must not change because of the guards
  // below: they only ever ADD a read-only `tmux display-message` before the
  // first key. Pinned here as the exact keystroke sequence, in order.
  describe('keystrokes to an idle Claude pane', () => {
    // A real Claude pane, as measured on the live fleet 2026-09-22: tmux reports
    // the version string as the command, and `ps` shows `claude` leading a
    // foreground group it shares with the MCP servers it spawned. The `ps` reply
    // is what identifies it — an earlier fixture returned '' here and passed
    // only because the version string was absent from a list of shell names.
    function claudeNode(visible) {
      node.exec.mockImplementation(async (cmd) => {
        if (cmd.includes('#{pane_current_command}')) return '2.1.278|/dev/ttys042';
        if (cmd.startsWith('ps ')) {
          return [
            'Ss   zsh --login',
            'S+   claude',
            'S+   node /Users/j/Coding/hive/src/mcp-server/index.mjs --hive-url ws://127.0.0.1:3000 --session 13',
          ].join('\n');
        }
        return '';
      });
      node.capturePane.mockResolvedValue(visible);
    }
    const keystrokes = () =>
      [
        ...node.sendKeys.mock.invocationCallOrder.map((order, i) => [
          order,
          `paste:${JSON.stringify(node.sendKeys.mock.calls[i].slice(1))}`,
        ]),
        ...node.exec.mock.calls
          .map(([cmd], i) => [node.exec.mock.invocationCallOrder[i], cmd])
          .filter(([, cmd]) => cmd.includes('send-keys'))
          .map(([order, cmd]) => [order, cmd.replace(/^tmux send-keys -t "=6-DEV:\.1" /, 'key:')]),
      ]
        .sort((a, b) => a[0] - b[0])
        .map(([, k]) => k);

    it('ask sends clear, the paste, then one Enter', async () => {
      tmux.detectState.mockReturnValue('idle');
      claudeNode('❯ /clear');

      const resultPromise = relay.ask(config, node, '6-DEV', '/clear');
      await vi.advanceTimersByTimeAsync(3000);
      await resultPromise;

      expect(keystrokes()).toEqual(['key:C-a', 'key:C-k', 'paste:["/clear",false]', 'key:Enter']);
    });

    it('tell sends clear, the paste, then Enter twice for a multi-line message', async () => {
      tmux.detectState.mockReturnValue('idle');
      claudeNode('❯ [Pasted text #1 +2 lines]');

      const resultPromise = relay.tell(config, node, '6-DEV', 'LT-CAP-1\nsecond line');
      await vi.advanceTimersByTimeAsync(3000);
      await resultPromise;

      expect(keystrokes()).toEqual([
        'key:C-a',
        'key:C-k',
        'paste:["LT-CAP-1\\nsecond line",false]',
        'key:Enter',
        'key:Enter',
      ]);
    });
  });

  // The live-test incident: detection read a pane as idle, but the pane was bash.
  // Pasting task text into a shell runs it line by line, and backticks or $(...)
  // in the text execute. The guard asks tmux what the pane is running before any
  // key is sent, so it holds whatever detectState says.
  describe('never types into anything but Claude', () => {
    // The gate is an allowlist: "is Claude in the pane's foreground group?".
    // `fg` fixtures are `ps -o stat=,args=` output — argv, not comm — and the
    // "+" in the stat column marks the foreground group.
    function paneRunning({ command = 'bash', fg = 'Ss+  -bash' } = {}) {
      node.exec.mockImplementation(async (cmd) => {
        if (cmd.includes('#{pane_current_command}')) return `${command}|/dev/ttys042`;
        if (cmd.startsWith('ps ')) return fg;
        return '';
      });
      node.capturePane.mockResolvedValue('jeff$ ');
    }
    const shellNode = paneRunning;

    const keysSent = () => [
      ...node.sendKeys.mock.calls,
      ...node.exec.mock.calls.filter(([cmd]) => cmd.includes('send-keys')),
    ];

    it('ask refuses to paste when the pane runs bash, even when detection says idle', async () => {
      tmux.detectState.mockReturnValue('idle');
      shellNode();

      const result = await relay.ask(config, node, '6-DEV', 'echo SHOULD-NOT-RUN');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/running bash, not Claude Code/);
      expect(keysSent()).toEqual([]);
    });

    it('ask refuses with force=true too (manual dashboard input)', async () => {
      tmux.detectState.mockReturnValue('working');
      shellNode({ command: 'zsh', fg: 'Ss+  -zsh' });

      const result = await relay.ask(config, node, '6-DEV', 'hello', {
        force: true,
        vimMode: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/running zsh, not Claude Code/);
      expect(keysSent()).toEqual([]);
    });

    it('tell refuses to paste when the pane runs bash, even when detection says idle', async () => {
      tmux.detectState.mockReturnValue('idle');
      shellNode();

      const result = await relay.tell(
        config,
        node,
        '6-DEV',
        'LT-CAP-1: `hive_get_knowledge`\n$(id)',
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/running bash, not Claude Code/);
      expect(keysSent()).toEqual([]);
    });

    // Hole 1 in the first version of this guard, measured on a real tmux:
    // `pane_current_command` is the foreground process-GROUP leader, so a shell
    // running a job reports the job's name, not the shell's. A denylist of
    // shell names never sees it, and the paste lands in the shell's stdin to
    // run when the job exits.
    it('refuses a shell that is busy running a job, which does not report as a shell', async () => {
      tmux.detectState.mockReturnValue('idle');
      paneRunning({ command: 'sleep', fg: 'Ss   -zsh\nS+   sleep 30\nS+   cat' });

      // Timers are advanced so that a guard which WAVES THIS THROUGH runs to
      // completion and fails on the assertions below, rather than hanging and
      // failing with a timeout that says nothing about what went wrong.
      const resultPromise = relay.tell(config, node, '6-DEV', 'LT-CAP-1: `id`');
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.refused).toBe('not-claude');
      expect(result.error).toMatch(/running sleep, not Claude Code/);
      expect(keysSent()).toEqual([]);
    });

    // Hole 2: a bare `node` REPL reports exactly what Claude-launched-via-node
    // reports. comm cannot separate them; argv can. A REPL evaluates pasted
    // text as JavaScript — the same defect in a different interpreter.
    it('refuses a bare node REPL, which reports the same comm as Claude', async () => {
      tmux.detectState.mockReturnValue('idle');
      paneRunning({ command: 'node', fg: 'Ss   -zsh\nS+   node' });

      const resultPromise = relay.tell(config, node, '6-DEV', 'process.exit(1)');
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.refused).toBe('not-claude');
      expect(result.error).toMatch(/running node, not Claude Code/);
      expect(keysSent()).toEqual([]);
    });

    // Not a shell, not on any denylist, and pasting into it types into a shell
    // on another machine.
    it('refuses an ssh session', async () => {
      tmux.detectState.mockReturnValue('idle');
      paneRunning({ command: 'ssh', fg: 'Ss   -zsh\nS+   ssh prod-box' });

      const resultPromise = relay.tell(config, node, '6-DEV', 'rm -rf /tmp/x');
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(keysSent()).toEqual([]);
    });

    // The shape measured on a live fleet session: tmux reports Claude's version
    // string as the command, `claude` leads the foreground group, and the MCP
    // servers Claude spawned share that group. Claude must be PRESENT in the
    // group, not alone in it — requiring it alone would refuse every real
    // session that has an MCP server attached.
    it('pastes when Claude leads a foreground group it shares with MCP servers', async () => {
      tmux.detectState.mockReturnValue('idle');
      paneRunning({
        command: '2.1.274',
        fg: [
          'Ss   zsh --login',
          'S+   claude',
          'S+   node /Users/j/Coding/hive/src/mcp-server/index.mjs --hive-url ws://127.0.0.1:3000 --session 13',
          'S+   npm exec @playwright/mcp@0.0.55 --timeout-action 30000',
        ].join('\n'),
      });
      node.capturePane.mockResolvedValue('input box: do something');

      const resultPromise = relay.tell(config, node, '6-DEV', 'do something');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(node.sendKeys).toHaveBeenCalledWith('=6-DEV:.1', 'do something', false);
    });

    // Silence is not consent. An earlier revision refused only names it
    // recognized as shells here, which put the denylist back in the one place
    // the evidence is weakest — `ash`, `ssh` and a program with no name at all
    // were all pasted into. Confirming Claude is the only thing that unlocks
    // the keyboard, so an unreadable `ps` refuses whatever the pane is.
    it('refuses a known shell when ps cannot answer, rather than trusting silence', async () => {
      tmux.detectState.mockReturnValue('idle');
      paneRunning({ command: 'bash', fg: '' });

      const result = await relay.tell(config, node, '6-DEV', 'echo SHOULD-NOT-RUN');

      expect(result.success).toBe(false);
      expect(result.refused).toBe('not-claude');
      expect(result.error).toMatch(/running bash, not Claude Code/);
      expect(keysSent()).toEqual([]);
    });

    it('refuses a shell no list would name when ps cannot answer', async () => {
      tmux.detectState.mockReturnValue('idle');
      paneRunning({ command: 'oksh', fg: '' });

      const result = await relay.tell(config, node, '6-DEV', 'echo SHOULD-NOT-RUN');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/running oksh, not Claude Code/);
      expect(keysSent()).toEqual([]);
    });

    it('refuses an unnamed program when neither tmux nor ps can identify it', async () => {
      tmux.detectState.mockReturnValue('idle');
      node.exec.mockImplementation(async (cmd) => {
        if (cmd.includes('#{pane_current_command}')) return '|/dev/ttys042';
        return '';
      });
      node.capturePane.mockResolvedValue('$ ');

      const result = await relay.tell(config, node, '6-DEV', 'echo SHOULD-NOT-RUN');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/an unidentified program/);
      expect(keysSent()).toEqual([]);
    });

    it('tell still pastes when a wrapper script leads the foreground group but Claude runs in it', async () => {
      // `claude` launched through a `#!/bin/sh` wrapper that does not exec:
      // tmux reports the group leader (sh), but Claude's own entry point is in
      // the foreground group, so Claude is what is reading the keyboard.
      // The argv here is what makes it distinguishable from a `node` REPL —
      // the first version of this test asserted success on a bare
      // `/usr/local/bin/node`, which encoded hole 2 as desired behaviour.
      tmux.detectState.mockReturnValue('idle');
      paneRunning({
        command: 'sh',
        fg:
          'S+   /bin/sh /usr/local/bin/claude-wrapper\n' +
          'S+   node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      });
      node.capturePane.mockResolvedValue('input box: do something');

      const resultPromise = relay.tell(config, node, '6-DEV', 'do something');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(node.sendKeys).toHaveBeenCalledWith('=6-DEV:.1', 'do something', false);
    });

    it('pastes as before when tmux cannot say what the pane runs', async () => {
      // An unanswered display-message is not evidence of a shell. Refusing on
      // it would stop every message on a node whose exec is flaky.
      tmux.detectState.mockReturnValue('idle');
      node.exec.mockResolvedValue(null);
      node.capturePane.mockResolvedValue('input box: do something');

      const resultPromise = relay.tell(config, node, '6-DEV', 'do something');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(node.sendKeys).toHaveBeenCalledTimes(1);
    });
  });

  describe('never types into a startup gate', () => {
    it('ask refuses a blocked pane, even with force=true', async () => {
      tmux.detectState.mockReturnValue('blocked');
      node.capturePane.mockResolvedValue(' ❯ No, exit');

      const result = await relay.ask(config, node, '6-DEV', '/clear', { force: true });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/startup dialog/);
      expect(node.sendKeys).not.toHaveBeenCalled();
      expect(node.exec.mock.calls.filter(([c]) => c.includes('send-keys'))).toEqual([]);
    });

    it('tell refuses a blocked pane at once instead of pasting when the settle budget runs out', async () => {
      tmux.detectState.mockReturnValue('blocked');
      node.capturePane.mockResolvedValue(' ❯ No, exit');

      const resultPromise = relay.tell(config, node, '6-DEV', 'do something');
      await vi.advanceTimersByTimeAsync(40000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/startup dialog/);
      expect(node.sendKeys).not.toHaveBeenCalled();
      expect(node.exec.mock.calls.filter(([c]) => c.includes('send-keys'))).toEqual([]);
    });
  });
});
