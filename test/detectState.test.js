const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectState } = require('../src/core/tmux');

// Default config matching hive.config.js
const config = {
  idlePatterns: [
    /bypass permissions/,
    /shift\+tab/,
    /ctrl-g to edit/,
    /\? for shortcuts/,
    /Try "/,
    /❯\s*$/m,
  ],
  offPatterns: [
    /conversation\./,
  ],
};

// Helper to join lines into pane content
const pane = (...lines) => lines.join('\n');

// Full-width separator like Claude Code uses
const SEP = '─'.repeat(80);

describe('detectState', () => {

  // ── Idle: ❯ prompt between separators ──────────────────────

  it('detects idle: ❯ prompt with status bar below', () => {
    const content = pane(
      '❯ /resume',
      '  ⎿  Resume cancelled',
      '',
      SEP,
      '❯ ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | ⎇ jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  PR #26793',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle: welcome screen above prompt', () => {
    const content = pane(
      '  Try "create a todo app" or "find bugs in my code"',
      SEP,
      '❯ ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | ⎇ jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle: welcome screen with different suggestion text', () => {
    // Claude shows different suggestions: "fix typecheck errors", "create a todo app", etc.
    const content = pane(
      SEP,
      '❯ Try "fix typecheck errors"',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | ⎇ no gi...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle: ? for shortcuts on prompt line', () => {
    const content = pane(
      'Some output above',
      SEP,
      '  ? for shortcuts    shift+tab for vim mode',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | ⎇ jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  PR #26793',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle: bypass permissions prompt', () => {
    const content = pane(
      'Some output above',
      SEP,
      '  bypass permissions for this session',
      SEP,
      '  Model: Opus 4.6 | Ctx: 12.3% | ⎇ jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle: ctrl-g to edit prompt', () => {
    const content = pane(
      SEP,
      '  ctrl-g to edit',
      SEP,
      '  Model: Opus 4.6 | Ctx: 55.0%',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  // ── Idle: no separator (fallback) ─────────────────────────

  it('detects idle: ❯ prompt without status bar (fallback)', () => {
    const content = pane(
      'Some previous output',
      '❯ ',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle: ? for shortcuts without separator (fallback)', () => {
    const content = pane(
      '  ? for shortcuts',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  // ── Working ────────────────────────────────────────────────

  it('detects working: tool output above status bar separator', () => {
    const content = pane(
      '  Reading file: src/core/taskqueue.js',
      '  ⎿ Found 850 lines',
      SEP,
      '  Model: Opus 4.6 | Ctx: 45.2% | ⎇ jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  PR #26793',
    );
    assert.equal(detectState(content, config), 'working');
  });

  it('detects working: Claude generating text (no separator)', () => {
    const content = pane(
      'I will now implement the feature by modifying the following files:',
      '',
      '1. src/core/tmux.js - Update detectState',
      '2. src/core/fleet.js - Increase capture lines',
    );
    assert.equal(detectState(content, config), 'working');
  });

  it('detects working: ❯ with command text is not bare prompt', () => {
    const content = pane(
      SEP,
      '❯ /resume',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | ⎇ jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    assert.equal(detectState(content, config), 'working');
  });

  // ── Off ────────────────────────────────────────────────────

  it('detects off: conversation ended', () => {
    const content = pane(
      '  Your conversation.',
      '',
    );
    assert.equal(detectState(content, config), 'off');
  });

  it('detects off: empty pane', () => {
    assert.equal(detectState('', config), 'off');
  });

  it('detects off: only blank lines', () => {
    assert.equal(detectState('\n\n\n', config), 'off');
  });

  // ── Separator handling ─────────────────────────────────────

  it('finds the bottom-most separator even with multiple', () => {
    const content = pane(
      '  Previous output',
      SEP,
      '  More output',
      SEP,
      '❯ ',
      SEP,
      '  Model: Opus 4.6',
      '  cwd: /some/path',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('ignores short Unicode sequences that are not separators', () => {
    const content = pane(
      '───',
      '  Some working output',
    );
    assert.equal(detectState(content, config), 'working');
  });

  it('does not false-positive on ❯ mid-line in content', () => {
    const content = pane(
      'The arrow ❯ points right',
      SEP,
      '  Model: Opus 4.6',
    );
    assert.equal(detectState(content, config), 'working');
  });

  it('works regardless of custom status bar content', () => {
    const content = pane(
      SEP,
      '❯ ',
      SEP,
      '  CUSTOM_FIELD: something unusual',
      '  another_custom: 12345',
      '  totally unexpected status bar line!!!',
    );
    assert.equal(detectState(content, config), 'idle');
  });
});
