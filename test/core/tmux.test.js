import { describe, it, expect } from 'vitest';
import * as tmuxMod from '../../src/core/tmux.js';

// CJS interop
const tmux = tmuxMod.default || tmuxMod;

describe('tmux — pure functions', () => {
  const config = {
    idlePatterns: [/>\s*$/, /\$\s*$/],
    offPatterns: [/\[exited\]/, /no server running/],
  };

  describe('detectState', () => {
    it('returns "idle" for idle patterns', () => {
      expect(tmux.detectState('some output\n> ', config)).toBe('idle');
      expect(tmux.detectState('prompt $ ', config)).toBe('idle');
    });

    it('returns "off" for off patterns', () => {
      expect(tmux.detectState('[exited]', config)).toBe('off');
      expect(tmux.detectState('no server running on /tmp/tmux', config)).toBe('off');
    });

    it('returns "off" for empty content', () => {
      expect(tmux.detectState('', config)).toBe('off');
      expect(tmux.detectState('   \n  \n  ', config)).toBe('off');
    });

    it('returns "off" for content without TUI separator (Claude not running)', () => {
      expect(tmux.detectState('Compiling typescript...', config)).toBe('off');
      expect(tmux.detectState('Reading file /src/index.js\nAnalyzing...', config)).toBe('off');
    });

    it('returns "working" for active content with TUI separator', () => {
      const sep = '─'.repeat(40);
      expect(tmux.detectState(`Compiling typescript...\n${sep}\nModel: Opus`, config)).toBe('working');
    });

    it('strips non-printable characters before matching', () => {
      // detectState strips chars outside 0x20-0x7E range, then tests against patterns
      // Without TUI separator, content is 'off' (Claude not running)
      expect(tmux.detectState('\x1b[32m> \x1b[0m', config)).toBe('off');
      // Clean content with just > matches idle
      expect(tmux.detectState('> ', config)).toBe('idle');
    });

    it('returns "working" when idle prompt has failed checklist items', () => {
      const content = '  \u2713 Step 1\n  \u2713 Step 2\n  \u2717 Step 3\n> ';
      expect(tmux.detectState(content, config)).toBe('working');
    });

    it('returns "idle" when checklist has only passing items', () => {
      const content = '  \u2713 Step 1\n  \u2713 Step 2\n  \u2713 Step 3\n> ';
      expect(tmux.detectState(content, config)).toBe('idle');
    });

    // Regression: a session parked on a tool/edit-permission prompt. Claude Code
    // draws that prompt's divider with the DASHED box-drawing rule (\u254c U+254C),
    // not the solid \u2500 used by the normal input box, and renders a todo-list
    // footer BELOW the prompt. isSeparator used to match only \u2500/\u2501, so the pane
    // looked separator-less and detectState fell through to 'off' \u2014 hive reported
    // the live, waiting-for-approval session as dead.
    it('returns "idle" for an edit-permission prompt with a dashed (\u254c) divider', () => {
      const dashed = '\u254c'.repeat(120); // \u254c\u254c\u254c\u2026 \u2014 the permission-prompt divider
      const content = [
        '              const geoId = new mongoose.Types.ObjectId();',
        dashed,
        ' Do you want to make this edit to messageQueueService.spec.js?',
        ' \u276f 1. Yes',
        '   2. Yes, allow all edits during this session (shift+tab)',
        '   3. No',
        '',
        ' Esc to cancel \u00b7 Tab to amend',
        '',
        '  3 tasks (2 done, 1 open)',
        '  \u2714 Add skipAckTaskExclusionRequeue model static',
        '  \u2714 Wire guard into queueVisit before validation short-circuit',
        '  \u25fb Add model unit + integration tests',
        '',
      ].join('\n');
      expect(tmux.detectState(content, config)).toBe('idle');
    });

    it('recognizes a dashed (\u254c) separator for the working-content case too', () => {
      const dashed = '\u254c'.repeat(40);
      // Active content above a dashed separator \u2192 working (mirrors the solid-\u2500 case).
      expect(tmux.detectState(`Compiling typescript...\n${dashed}\nModel: Opus`, config)).toBe('working');
    });
  });

  describe('stripTUIChrome', () => {
    it('returns empty string for empty/null content', () => {
      expect(tmux.stripTUIChrome('', config)).toBe('');
      expect(tmux.stripTUIChrome(null, config)).toBe('');
      expect(tmux.stripTUIChrome(undefined, config)).toBe('');
    });

    it('removes status bars and prompts from bottom', () => {
      const content = 'Hello world\nSome output\n$186.73\n> ';
      const result = tmux.stripTUIChrome(content, config);
      expect(result).toBe('Hello world\nSome output');
    });

    it('removes TUI chrome from top', () => {
      const content = '> \n\nActual content here\nMore content';
      const result = tmux.stripTUIChrome(content, config);
      expect(result).toBe('Actual content here\nMore content');
    });

    it('removes known TUI patterns', () => {
      const content = 'Real content\nbypass permissions\nshift+tab\n$12.50';
      const result = tmux.stripTUIChrome(content, config);
      expect(result).toBe('Real content');
    });

    it('removes "copy" button text', () => {
      const content = 'Code output\n  copy  ';
      const result = tmux.stripTUIChrome(content, config);
      expect(result).toBe('Code output');
    });

    it('removes -- INSERT -- mode indicator', () => {
      const content = 'Content here\n-- INSERT --';
      const result = tmux.stripTUIChrome(content, config);
      expect(result).toBe('Content here');
    });

    it('removes Cogitated/Baked timing lines', () => {
      const content = 'Response text\nCogitated for 1m 19s\n> ';
      const result = tmux.stripTUIChrome(content, config);
      expect(result).toBe('Response text');
    });

    it('preserves meaningful content between chrome', () => {
      const content = '> \nFirst line\nSecond line\nThird line\n> ';
      const result = tmux.stripTUIChrome(content, config);
      expect(result).toBe('First line\nSecond line\nThird line');
    });

    it('works without config', () => {
      const content = 'bypass permissions\nReal content\n$42.00';
      const result = tmux.stripTUIChrome(content, null);
      expect(result).toBe('Real content');
    });
  });
});
