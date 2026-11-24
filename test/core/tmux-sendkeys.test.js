import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tmuxSrc = readFileSync(join(__dirname, '../../src/core/tmux.js'), 'utf8');

// These are regression tests for the multi-line paste bug.
//
// Mocking the inner exec/writeFileSync from a vitest spec is brittle:
// src/core/tmux.js destructures `child_process.exec` and `fs.writeFileSync`
// at module-load time, and uses a closure-captured local `exec` wrapper that
// can't be reached through the module's exports. The simplest reliable check
// is a source-level snapshot of the paste-buffer command and the cleaning
// rules in sendKeys.
describe('tmux.sendKeys — paste flags (regression)', () => {
  it('uses bracketed paste mode (-p) on tmux paste-buffer', () => {
    // History:
    //   * PR #57 stopped collapsing \n → ' ' in sendKeys, on the assumption
    //     that "tmux paste-buffer handles newlines natively". True at the
    //     byte level; false in a TUI context.
    //   * Without -p, paste-buffer streams raw keystrokes — every embedded
    //     \n arrives as an Enter key event. Claude Code's TUI does paste-
    //     burst heuristics: when many keystrokes land within ms, it swallows
    //     the Enters but keeps the text → multi-line input collapses to one
    //     line (e.g. "/ship-jira DEV-47379\nno cherry pick needed" became
    //     "/ship-jira DEV-47379no cherry pick needed").
    //   * -p wraps the buffer in ESC[200~ … ESC[201~ so the TUI sees one
    //     paste event with newlines intact. Safe as a no-op when the app
    //     hasn't enabled bracketed paste mode.
    expect(tmuxSrc).toMatch(/tmux paste-buffer\b[^`]*\s-p\b/);
  });


  it('uses a per-call named buffer (concurrent dispatch cross-paste regression)', () => {
    // The unnamed tmux buffer is a shared stack. Two concurrent dispatches
    // interleave as: load(A), load(B), paste→target1 delivers B (top of
    // stack), paste→target2 delivers A — the sessions receive each other's
    // task text. Observed 2026-07-09: tasks dispatched 80ms apart landed
    // swapped across S1/S2 (branch/PR/terminal all showed the other task).
    // A per-call -b name pins each paste to its own buffer.
    expect(tmuxSrc).toMatch(/tmux load-buffer -b /);
    expect(tmuxSrc).toMatch(/tmux paste-buffer -b /);
  });

  it('preserves embedded newlines in the buffer (only normalizes CRLF, only trims edges)', () => {
    // The trim()-only cleaning step is load-bearing: any \n+ → ' '
    // replacement or split-on-newline would re-introduce the original
    // pre-#57 bug.
    expect(tmuxSrc).toMatch(/keys\.replace\(\/\\r\\n\/g,\s*['"]\\n['"]\)\.trim\(\)/);
    expect(tmuxSrc).not.toMatch(/\.replace\(\/\\r\?\\n\+\/g,\s*['"]\s['"]\)/);
  });
});
