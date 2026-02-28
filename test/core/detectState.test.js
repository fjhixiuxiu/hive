import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Use the ACTUAL production config to ensure patterns stay in sync
const hiveConfig = require('../../hive.config');
const config = {
  idlePatterns: hiveConfig.idlePatterns,
  offPatterns: hiveConfig.offPatterns,
};

// CJS interop
import * as tmuxMod from '../../src/core/tmux.js';
const tmux = tmuxMod.default || tmuxMod;
const { detectState } = tmux;

// Helper to join lines into pane content
const pane = (...lines) => lines.join('\n');

// Full-width separator like Claude Code uses
const SEP = '\u2500'.repeat(80);

describe('detectState — production config', () => {

  // -- Config sanity checks -------------------------------------------

  it('production config has prompt pattern', () => {
    const hasPrompt = config.idlePatterns.some(p => p.test('\u276f '));
    expect(hasPrompt).toBe(true);
    const hasTyped = config.idlePatterns.some(p => p.test('\u276f /resume'));
    expect(hasTyped).toBe(true);
  });

  it('production config has Try " welcome pattern', () => {
    const hasTry = config.idlePatterns.some(p => p.test('Try "fix typecheck errors"'));
    expect(hasTry).toBe(true);
  });

  it('production config has conversation. off pattern', () => {
    const hasOff = config.offPatterns.some(p => p.test('Your conversation.'));
    expect(hasOff).toBe(true);
  });

  // -- Idle: prompt between separators --------------------------------

  it('detects idle: prompt with status bar below', () => {
    const content = pane(
      '\u276f /resume',
      '  \u23bf  Resume cancelled',
      '',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | \u2387 jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  PR #26793',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: welcome screen above prompt', () => {
    const content = pane(
      '  Try "create a todo app" or "find bugs in my code"',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | \u2387 jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: welcome screen with different suggestion text', () => {
    const content = pane(
      SEP,
      '\u276f Try "fix typecheck errors"',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | \u2387 no gi...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: ? for shortcuts on prompt line', () => {
    const content = pane(
      'Some output above',
      SEP,
      '  ? for shortcuts    shift+tab for vim mode',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | \u2387 jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  PR #26793',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: bypass permissions prompt', () => {
    const content = pane(
      'Some output above',
      SEP,
      '  bypass permissions for this session',
      SEP,
      '  Model: Opus 4.6 | Ctx: 12.3% | \u2387 jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: ctrl-g to edit prompt', () => {
    const content = pane(
      SEP,
      '  ctrl-g to edit',
      SEP,
      '  Model: Opus 4.6 | Ctx: 55.0%',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: shift+tab vim mode prompt', () => {
    const content = pane(
      SEP,
      '  shift+tab for vim mode',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0%',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  // -- Idle: no separator (fallback) ----------------------------------

  it('detects idle: prompt without status bar (fallback)', () => {
    const content = pane(
      'Some previous output',
      '\u276f ',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: ? for shortcuts without separator (fallback)', () => {
    const content = pane(
      '  ? for shortcuts',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  // -- Working --------------------------------------------------------

  it('detects working: tool output above status bar separator', () => {
    const content = pane(
      '  Reading file: src/core/taskqueue.js',
      '  \u23bf Found 850 lines',
      SEP,
      '  Model: Opus 4.6 | Ctx: 45.2% | \u2387 jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  PR #26793',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('detects working: Claude generating text (no separator)', () => {
    const content = pane(
      'I will now implement the feature by modifying the following files:',
      '',
      '1. src/core/tmux.js - Update detectState',
      '2. src/core/fleet.js - Increase capture lines',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('detects working: Doodling with prompt visible (ASCII dots)', () => {
    const content = pane(
      '\u23fa Doodling... (1m 6s · \u2193 2.8k tokens · thought for 3s)',
      '',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 39.7% | \u2387 clau...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  PR #26669',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('detects working: Doing with prompt visible (Unicode ellipsis)', () => {
    const content = pane(
      '\u2722 Doing\u2026 (1m 10s · \u2193 1.9k tokens · thought for 3s)',
      '',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 41.8%',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('detects working: Choreographing with prompt visible', () => {
    const content = pane(
      '\u2733 Choreographing\u2026',
      '',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 64.4%',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('detects idle: completed status (past tense) with prompt', () => {
    const content = pane(
      '\u273b Saut\u00e9ed for 14m 34s',
      '',
      SEP,
      '\u276f /ship-it DEV-43846',
      SEP,
      '  Model: Opus 4.6 | Ctx: 75.7%',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: prompt with user-typed command (waiting for Enter)', () => {
    const content = pane(
      SEP,
      '\u276f /resume',
      SEP,
      '  Model: Opus 4.6 | Ctx: 0.0% | \u2387 jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects working: active tool execution with spinner', () => {
    const content = pane(
      '  \u23bf Searching for files matching "*.test.js"...',
      '  \u2838 Running grep...',
      SEP,
      '  Model: Opus 4.6 | Ctx: 33.1%',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('detects working: mid-response text output', () => {
    const content = pane(
      'Let me analyze the test failures:',
      '',
      '1. The first failure is in booking.spec.js',
      SEP,
      '  Model: Opus 4.6 | Ctx: 22.0%',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('detects idle: permission prompt below separator', () => {
    const content = pane(
      '  Reading file: src/core/tmux.js',
      SEP,
      ' Read file',
      '',
      '  Read(~/Coding/webplatform6/src/core/tmux.js)',
      '',
      ' Do you want to proceed?',
      ' \u276f 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel \u00b7 Tab to amend',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: permission prompt without separator', () => {
    const content = pane(
      '',
      ' Command contains brace expansion that could alter command parsing',
      '',
      ' Do you want to proceed?',
      ' \u276f 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel \u00b7 Tab to amend \u00b7 ctrl+e to explain',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle: choice menu below separator', () => {
    const content = pane(
      '  Some output',
      SEP,
      '  4. Chat about this',
      '',
      'Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  // -- Off ------------------------------------------------------------

  it('detects off: conversation ended', () => {
    const content = pane(
      '  Your conversation.',
      '',
    );
    expect(detectState(content, config)).toBe('off');
  });

  it('detects off: empty pane', () => {
    expect(detectState('', config)).toBe('off');
  });

  it('detects off: only blank lines', () => {
    expect(detectState('\n\n\n', config)).toBe('off');
  });

  it('detects off: shell prompt only (no Claude)', () => {
    const content = pane(
      '',
      '',
      '',
    );
    expect(detectState(content, config)).toBe('off');
  });

  // -- Separator handling ---------------------------------------------

  it('finds the bottom-most separator even with multiple', () => {
    const content = pane(
      '  Previous output',
      SEP,
      '  More output',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6',
      '  cwd: /some/path',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('ignores short Unicode sequences that are not separators', () => {
    const content = pane(
      '\u2500\u2500\u2500',
      '  Some working output',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('does not false-positive on prompt mid-line in content', () => {
    const content = pane(
      'The arrow \u276f points right',
      SEP,
      '  Model: Opus 4.6',
    );
    expect(detectState(content, config)).toBe('working');
  });

  it('works regardless of custom status bar content', () => {
    const content = pane(
      SEP,
      '\u276f ',
      SEP,
      '  CUSTOM_FIELD: something unusual',
      '  another_custom: 12345',
      '  totally unexpected status bar line!!!',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  // -- Real-world captures --------------------------------------------

  it('detects idle from real session with PR status bar', () => {
    const content = pane(
      '  \u23bf Found 3 test files',
      '',
      '  All tests pass.',
      '',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 88.2% | \u2387 jeffh...',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
      '  CI PASS | PR #26793 | 2 reviews',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle with thick separator variant', () => {
    const thickSep = '\u2501'.repeat(80);
    const content = pane(
      thickSep,
      '\u276f ',
      thickSep,
      '  Model: Opus 4.6',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects idle when user has typed response in prompt', () => {
    const content = pane(
      '  Want me to re-kick CI to get a clean run?',
      '',
      '\u273b Cogitated for 34s',
      '',
      SEP,
      '\u276f yes, re-kick it',
      SEP,
      '  Model: Opus 4.6 | Ctx: 24.6%',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  // -- Stalled (incomplete checklist with failures) ---------------------

  it('detects stalled: checklist with failed item and idle prompt', () => {
    // Claude was working through a task checklist but stopped after a failure.
    // The prompt is visible but the task isn't done — should NOT be idle.
    const content = pane(
      '  \u2713 Add bulkRepublishVisits to schedulingEvv API',
      '  \u2713 Add configureEvvVisits to permissions hook',
      '  \u2713 Create BulkRepublishPanel component',
      '  \u2713 Create BulkRepublishMenuItem component',
      '  \u2713 Write tests for BulkRepublishPanel and MenuItem',
      '  \u2717 Run lint and tests to verify',
      '',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 37.6%',
      '  cwd: /Users/jeffheifetz/Coding/webpla...',
    );
    expect(detectState(content, config)).toBe('stalled');
  });

  it('detects stalled: checklist with failure and no separator', () => {
    const content = pane(
      '  \u2713 Step 1 completed',
      '  \u2713 Step 2 completed',
      '  \u2717 Step 3 failed',
      '\u276f ',
    );
    expect(detectState(content, config)).toBe('stalled');
  });

  it('detects stalled: alternate checkmark characters', () => {
    // ✔ (U+2714) and ✘ (U+2718) variants
    const content = pane(
      '  \u2714 First task done',
      '  \u2714 Second task done',
      '  \u2718 Third task failed',
      '',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 50.0%',
    );
    expect(detectState(content, config)).toBe('stalled');
  });

  it('detects idle (not stalled): checklist with all items passing', () => {
    // All items passed — task completed successfully, normal idle
    const content = pane(
      '  \u2713 Step 1 completed',
      '  \u2713 Step 2 completed',
      '  \u2713 Step 3 completed',
      '',
      SEP,
      '\u276f ',
      SEP,
      '  Model: Opus 4.6 | Ctx: 40.0%',
    );
    expect(detectState(content, config)).toBe('idle');
  });

  it('detects working (not stalled): checklist visible but Claude still active', () => {
    // Claude is actively working — stalled only applies when idle
    const content = pane(
      '  \u2713 Step 1 completed',
      '  \u2717 Step 2 failed',
      '  Retrying step 2...',
      SEP,
      '  Model: Opus 4.6 | Ctx: 55.0%',
    );
    expect(detectState(content, config)).toBe('working');
  });
});
