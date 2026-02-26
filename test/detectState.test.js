const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectState } = require('../src/core/tmux');

// Use the ACTUAL production config to ensure patterns stay in sync
const hiveConfig = require('../hive.config');
const config = {
  idlePatterns: hiveConfig.idlePatterns,
  offPatterns: hiveConfig.offPatterns,
};

// Helper to join lines into pane content
const pane = (...lines) => lines.join('\n');

// Full-width separator like Claude Code uses
const SEP = '─'.repeat(80);

describe('detectState', () => {

  // ── Config sanity checks ───────────────────────────────────

  it('production config has ❯ prompt pattern', () => {
    const hasPrompt = config.idlePatterns.some(p => p.test('❯ '));
    assert.ok(hasPrompt, 'hive.config.js must include a pattern matching "❯ " (prompt)');
    const hasTyped = config.idlePatterns.some(p => p.test('❯ /resume'));
    assert.ok(hasTyped, 'hive.config.js must also match "❯ /resume" (prompt with typed text)');
  });

  it('production config has Try " welcome pattern', () => {
    const hasTry = config.idlePatterns.some(p => p.test('Try "fix typecheck errors"'));
    assert.ok(hasTry, 'hive.config.js must include a pattern matching Try "..." suggestions');
  });

  it('production config has conversation. off pattern', () => {
    const hasOff = config.offPatterns.some(p => p.test('Your conversation.'));
    assert.ok(hasOff, 'hive.config.js must include an off pattern matching "conversation."');
  });

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

  it('detects idle: shift+tab vim mode prompt', () => {
    const content = pane(
      SEP,
      '  shift+tab for vim mode',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0%',
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

  it('detects idle: ❯ with user-typed command (waiting for Enter)', () => {
    // User has typed "/resume" but hasn't pressed Enter yet — Claude is idle
    const content = pane(
      SEP,
      '❯ /resume',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | ⎇ jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects working: active tool execution with spinner', () => {
    const content = pane(
      '  ⎿ Searching for files matching "*.test.js"...',
      '  ⠸ Running grep...',
      SEP,
      '  Model: Opus 4.6 | Ctx: 33.1%',
    );
    assert.equal(detectState(content, config), 'working');
  });

  it('detects working: mid-response text output', () => {
    const content = pane(
      'Let me analyze the test failures:',
      '',
      '1. The first failure is in booking.spec.js',
      SEP,
      '  Model: Opus 4.6 | Ctx: 22.0%',
    );
    assert.equal(detectState(content, config), 'working');
  });

  it('detects idle: permission prompt below separator', () => {
    // Claude asking "Do you want to proceed?" renders below the separator
    const content = pane(
      '  Reading file: src/core/tmux.js',
      SEP,
      ' Read file',
      '',
      '  Read(~/Coding/webplatform6/src/core/tmux.js)',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel · Tab to amend',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle: permission prompt without separator', () => {
    // Permission prompt fills entire pane (no separator visible)
    const content = pane(
      '',
      ' Command contains brace expansion that could alter command parsing',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle: choice menu below separator', () => {
    const content = pane(
      '  Some output',
      SEP,
      '  4. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    );
    assert.equal(detectState(content, config), 'idle');
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

  it('detects off: shell prompt only (no Claude)', () => {
    const content = pane(
      '',
      '',
      '',
    );
    assert.equal(detectState(content, config), 'off');
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

  // ── Real-world captures ────────────────────────────────────

  it('detects idle from real session with PR status bar', () => {
    // Actual capture from a session that was being detected as "working"
    // because the old code checked the last non-empty line (PR #26793)
    const content = pane(
      '  ⎿ Found 3 test files',
      '',
      '  All tests pass.',
      '',
      SEP,
      '❯ ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 88.2% | ⎇ jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  CI PASS | PR #26793 | 2 reviews',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle with thick separator (━) variant', () => {
    const thickSep = '━'.repeat(80);
    const content = pane(
      thickSep,
      '❯ ',
      thickSep,
      '  Model: Opus 4.6',
    );
    assert.equal(detectState(content, config), 'idle');
  });

  it('detects idle when user has typed response in prompt', () => {
    // User typed "yes, re-kick it" but hasn't pressed Enter — still idle
    const content = pane(
      '  Want me to re-kick CI to get a clean run?',
      '',
      '✻ Cogitated for 34s',
      '',
      SEP,
      '❯ yes, re-kick it',
      SEP,
      '  Model: Opus 4.6 | Ctx: 24.6%',
    );
    assert.equal(detectState(content, config), 'idle');
  });
});
