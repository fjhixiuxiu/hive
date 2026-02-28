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

    it('returns "working" for active content', () => {
      expect(tmux.detectState('Compiling typescript...', config)).toBe('working');
      expect(tmux.detectState('Reading file /src/index.js\nAnalyzing...', config)).toBe('working');
    });

    it('strips non-printable characters before matching', () => {
      // detectState strips chars outside 0x20-0x7E range, then tests against patterns
      // \x1b is stripped but [ ] digits are printable, so ANSI codes leave residue
      // This means raw ANSI content is "working" since the residue doesn't match idle/off
      expect(tmux.detectState('\x1b[32m> \x1b[0m', config)).toBe('working');
      // Clean content with just > matches idle
      expect(tmux.detectState('> ', config)).toBe('idle');
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
