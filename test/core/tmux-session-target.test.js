import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as tmuxMod from '../../src/core/tmux.js';

// CJS interop
const tmux = tmuxMod.default || tmuxMod;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const read = (p) => readFileSync(join(__dirname, '../../src', p), 'utf8');

// Regression tests for the tmux prefix-match bug.
//
// tmux resolves an ambiguous `-t <name>` target by prefix, so a bare `-t 3`
// matches a session named "30" when no exact "3" exists. With bare targets:
//   * hasSession("3") returned true whenever "30" existed → createSession
//     skipped forever while the dispatcher's exact-match fleet view saw no
//     session 3, an endless "create session 3" loop that stranded the queue.
//   * killSession("3") would kill "30".
//   * startClaude(3) typed `claude` into session 30's pane.
//
// Fix: every `-t` target is built via tmux.sessionTarget / tmux.paneTarget,
// which prepend tmux's `=` exact-match prefix.
describe('tmux exact-match session targets (regression: prefix-match bug)', () => {
  describe('helpers', () => {
    it('sessionTarget prepends = so "3" cannot prefix-match "30"', () => {
      expect(tmux.sessionTarget('3')).toBe('=3');
      expect(tmux.sessionTarget(30)).toBe('=30');
    });

    it('paneTarget prepends = and appends the pane', () => {
      expect(tmux.paneTarget('3', 1)).toBe('=3:.1');
      expect(tmux.paneTarget(12, 2)).toBe('=12:.2');
    });

    it('windowTarget prepends = and appends the window separator', () => {
      expect(tmux.windowTarget('3')).toBe('=3:');
      expect(tmux.windowTarget(30)).toBe('=30:');
      expect(tmux.windowTarget('hive-console')).toBe('=hive-console:');
    });
  });

  // `=name` is only a valid *target-session*. Measured on tmux 3.6a:
  //   split-window -t =s / select-layout -t =s / capture-pane / send-keys / pipe-pane
  //     → "can't find pane: =s" (exit 1)
  //   list-panes -t =s / resize-window -t =s
  //     → exit 0, but resolved a WINDOW NAMED "s" in the current session before
  //       the session "s" (list-panes returned the decoy session's pane)
  //   ...-t =s: (window form) → the session's current window, both cases
  // So sessionTarget may only feed commands whose -t is a target-session.
  describe('sessionTarget only feeds target-session commands', () => {
    const TARGET_SESSION_CMDS = /tmux (has-session|kill-session)\b/;
    const files = [
      'core/tmux.js',
      'core/fleet.js',
      'core/relay.js',
      'core/watcher.js',
      'core/taskqueue.js',
      'core/session-manager.js',
      'integrations/web/ws-handlers.js',
      'integrations/web/ws-helpers.js',
      'integrations/telegram/commands.js',
    ];

    for (const f of files) {
      it(`${f}: every sessionTarget() call is a has-session/kill-session`, () => {
        const offenders = read(f)
          .split('\n')
          .map((line, i) => ({ line: line.trim(), n: i + 1 }))
          .filter(({ line }) => /sessionTarget\(/.test(line))
          .filter(({ line }) => !/^function sessionTarget\(/.test(line))
          .filter(({ line }) => !/^\*|^\/\//.test(line))
          .filter(({ line }) => !TARGET_SESSION_CMDS.test(line));
        expect(offenders).toEqual([]);
      });
    }

    it('start-sessions.js resizes the window with the window form', () => {
      const src = readFileSync(join(__dirname, '../../start-sessions.js'), 'utf8');
      expect(src).toMatch(/resize-window -t "=\$\{name\}:"/);
      expect(src).not.toMatch(/resize-window -t "=\$\{name\}"/);
    });

    it('session-manager splits and lays out via windowTarget', () => {
      const src = read('core/session-manager.js');
      expect(src).toMatch(/split-window -h -t "\$\{tmux\.windowTarget\(sessionName\)\}"/);
      expect(src).toMatch(/select-layout -t "\$\{tmux\.windowTarget\(sessionName\)\}"/);
    });
  });

  describe('session/pane targets route through the helpers (no bare names)', () => {
    it('tmux.js hasSession + killSession use sessionTarget', () => {
      const src = read('core/tmux.js');
      expect(src).toMatch(/has-session -t "\$\{sessionTarget\(name\)\}"/);
      expect(src).toMatch(/kill-session -t "\$\{sessionTarget\(name\)\}"/);
      // No bare session-name target may reappear.
      expect(src).not.toMatch(/-t "\$\{name\}"/);
      expect(src).not.toMatch(/-t "\$\{name\}:/);
    });

    it('no module builds a bare `${name}:.${pane}` pane target', () => {
      for (const f of [
        'core/fleet.js',
        'core/relay.js',
        'core/watcher.js',
        'core/taskqueue.js',
        'core/session-manager.js',
        'integrations/web/ws-handlers.js',
        'integrations/telegram/commands.js',
      ]) {
        expect(read(f), `${f} should use tmux.paneTarget(), not a bare template`).not.toMatch(
          /`\$\{[A-Za-z.]+\}:\.\$\{[^}]+\}`/,
        );
      }
    });
  });
});
