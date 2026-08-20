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
        'core/fleet.js', 'core/relay.js', 'core/watcher.js', 'core/taskqueue.js',
        'core/session-manager.js', 'integrations/web/ws-handlers.js',
        'integrations/telegram/commands.js',
      ]) {
        expect(read(f), `${f} should use tmux.paneTarget(), not a bare template`)
          .not.toMatch(/`\$\{[A-Za-z.]+\}:\.\$\{[^}]+\}`/);
      }
    });
  });
});
