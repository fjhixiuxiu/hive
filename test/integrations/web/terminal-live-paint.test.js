import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '../../../src/integrations/web/public/app.js');

// ---------------------------------------------------------------------------
// Terminal repaint positioning and buffer growth.
//
// app.js is a browser IIFE with no exports, so these tests lift the two
// functions out of the real source and run them. That matters more than usual
// here: both of the bugs below were found in live use rather than by a test,
// and a hand-written mirror of the logic would have kept passing through both.
//
//   1. Live repaints refilled xterm's 5000-line scrollback with repeated
//      snapshots of one screen, whenever a captured line was wider than the
//      terminal (measured: 44 lines per poll, cap reached in ~3 minutes).
//   2. Opening a session painted the history capture, then the first live poll
//      ~2s later repainted one or two rows higher — the terminal appeared to
//      scroll on its own. Measured over 36 pane/terminal-size combinations:
//      the old anchoring shifted in 27 of them.
// ---------------------------------------------------------------------------

/** Lift a top-level `function name(...) {...}` out of source by brace matching. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in app.js`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

const source = fs.readFileSync(APP_JS, 'utf8');

// ---------------------------------------------------------------------------

describe('livePaint — where a live repaint lands', () => {
  const livePaint = new Function(`${extractFunction(source, 'livePaint')}; return livePaint;`)();

  /** Row number each payload line will occupy, given the leading cursor move. */
  function placement(payload) {
    const m = payload.match(/^\x1b\[(\d+);1H\x1b\[J/);
    const startRow = m ? Number(m[1]) : 1;
    const body = payload.replace(/^\x1b\[[0-9;]*[HJ]/g, '').replace(/^\x1b\[J/, '');
    return { startRow, lines: body.split('\n') };
  }

  it('anchors the payload against the bottom of the terminal', () => {
    const content = ['a', 'b', 'c'].join('\n');
    const payload = livePaint(content, 10, 3);
    const { startRow, lines } = placement(payload);

    expect(startRow).toBe(8); // 10 - 3 + 1
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(startRow + lines.length - 1).toBe(10);
  });

  it('leaves the rows above the pane untouched', () => {
    // Those rows hold real scrollback from the history paint, which a
    // visible-only capture cannot reproduce. Erasing from the top blanked them.
    const payload = livePaint('x\ny', 20, 2);

    expect(payload.startsWith('\x1b[19;1H')).toBe(true);
    expect(payload.startsWith('\x1b[H')).toBe(false);
  });

  it('pads back to the pane height when tmux trimmed the blank tail', () => {
    // tmux trims a pane's trailing blank rows, and inconsistently — the same
    // 50-row pane came back as 48 lines on one session and 51 on another. The
    // line count therefore says nothing about where content sits; pane_height
    // is the only authority.
    const payload = livePaint('one\ntwo', 50, 50);
    const { startRow, lines } = placement(payload);

    expect(lines).toHaveLength(50);
    expect(lines.slice(0, 2)).toEqual(['one', 'two']);
    expect(lines.slice(2).every((l) => l === '')).toBe(true);
    expect(startRow).toBe(1);
  });

  it('a trimmed and an untrimmed capture of the same screen land identically', () => {
    // The regression in one assertion: these two are the same 6-row pane, one
    // with tmux's blank tail included and one without.
    const trimmed = livePaint('one\ntwo', 30, 6);
    const untrimmed = livePaint('one\ntwo\n\n\n\n', 30, 6);

    expect(placement(trimmed).startRow).toBe(placement(untrimmed).startRow);
    expect(placement(trimmed).lines).toHaveLength(6);
    expect(placement(untrimmed).lines).toHaveLength(6);
  });

  it("drops the trailing-newline artifact but keeps the pane's own blank rows", () => {
    const payload = livePaint('top\n\n\n', 10, 4);
    const { lines } = placement(payload);

    // 'top', '', '' from the content (last '' is the newline artifact), padded to 4.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('top');
  });

  it('keeps the newest rows when a capture overshoots the pane height', () => {
    const payload = livePaint(['r1', 'r2', 'r3', 'r4', 'r5'].join('\n'), 20, 3);
    const { lines } = placement(payload);

    expect(lines).toEqual(['r3', 'r4', 'r5']);
  });

  it('falls back to a full erase when the pane is taller than the terminal', () => {
    // Nothing can be anchored below the top in this case, so the old behaviour
    // is correct and must be preserved.
    const payload = livePaint(['a', 'b', 'c', 'd', 'e'].join('\n'), 3, 5);

    expect(payload.startsWith('\x1b[H\x1b[J')).toBe(true);
    expect(payload.slice('\x1b[H\x1b[J'.length).split('\n')).toEqual(['c', 'd', 'e']);
  });

  it('falls back to the line count when the pane height is unknown', () => {
    // rows parses to 0 when tmux's display-message fails; the payload must
    // still be positioned rather than throwing or anchoring at row 0.
    const payload = livePaint('a\nb', 10, 0);
    const { startRow, lines } = placement(payload);

    expect(startRow).toBe(9);
    expect(lines).toEqual(['a', 'b']);
  });

  it('never advances the cursor past the last row, which is what scrolls', () => {
    // A repaint pushes rows into scrollback only if its newlines carry the
    // cursor below the terminal's last row. The payload may well *end* in a
    // newline — a pane whose last row is blank does — so the invariant is
    // about the final cursor row, not about the trailing character.
    for (const [termRows, paneRows] of [
      [10, 3],
      [50, 50],
      [3, 5],
      [24, 24],
      [80, 12],
    ]) {
      const payload = livePaint('a\nb\n', termRows, paneRows);
      const m = payload.match(/^\x1b\[(\d+);1H/);
      const startRow = m ? Number(m[1]) : 1;
      const newlines = (
        payload.replace(/^\x1b\[[0-9;]*[HJ]\x1b\[J|^\x1b\[H\x1b\[J/, '').match(/\n/g) || []
      ).length;

      expect(startRow + newlines).toBeLessThanOrEqual(termRows);
    }
  });

  // The measured matrix: 36 pane/terminal-size combinations, the shape that
  // caught this originally. The invariant is that the last content row always
  // lands on the terminal's last row, so a history paint and the live poll that
  // follows it agree on where the screen sits.
  describe('bottom-anchor invariant across pane/terminal sizes', () => {
    const termSizes = [24, 30, 40, 50, 60, 80];
    const paneSizes = [12, 24, 30, 40, 48, 50];

    for (const termRows of termSizes) {
      for (const paneRows of paneSizes) {
        if (paneRows > termRows) continue;
        it(`term ${termRows} × pane ${paneRows}`, () => {
          const payload = livePaint('content\nhere', termRows, paneRows);
          const { startRow, lines } = placement(payload);

          expect(lines).toHaveLength(paneRows);
          expect(startRow + lines.length - 1).toBe(termRows);
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('enforceBufferCeiling — scrollback cannot climb on live repaints', () => {
  let harness;

  beforeEach(() => {
    // Rebuild the closure state (`term`, `bufferBaseline`) the real function
    // reads, around the real function body.
    harness = new Function(`
      let term = null;
      let bufferBaseline = null;
      ${extractFunction(source, 'enforceBufferCeiling')}
      return {
        setTerm: (t) => { term = t; },
        baseline: () => bufferBaseline,
        resetBaseline: () => { bufferBaseline = null; },
        enforceBufferCeiling,
      };
    `)();
  });

  /** A terminal whose buffer grows by `growth` rows on each repaint. */
  function fakeTerm(rows, startLen) {
    return {
      rows,
      buffer: { active: { length: startLen } },
      clear: vi.fn(function () {
        this.buffer.active.length = rows;
      }),
    };
  }

  it('does nothing when there is no terminal', () => {
    harness.setTerm(null);
    expect(() => harness.enforceBufferCeiling(false)).not.toThrow();
  });

  it('takes a baseline from a full paint instead of policing it', () => {
    // The first paint after subscribing carries 500 lines of scrollback and is
    // meant to land in the buffer — clearing it would throw away the history
    // the user just asked to scroll through.
    const term = fakeTerm(50, 550);
    harness.setTerm(term);

    harness.enforceBufferCeiling(true);

    expect(term.clear).not.toHaveBeenCalled();
    expect(harness.baseline()).toBe(550);
  });

  it('takes a baseline on the first live paint of a session', () => {
    const term = fakeTerm(50, 550);
    harness.setTerm(term);

    harness.enforceBufferCeiling(false);

    expect(term.clear).not.toHaveBeenCalled();
    expect(harness.baseline()).toBe(550);
  });

  it('tolerates growth up to one viewport of slack', () => {
    const term = fakeTerm(50, 550);
    harness.setTerm(term);
    harness.enforceBufferCeiling(true);

    term.buffer.active.length = 600; // baseline + rows exactly
    harness.enforceBufferCeiling(false);

    expect(term.clear).not.toHaveBeenCalled();
  });

  it('drops stale scrollback once a repaint grows past that slack', () => {
    const term = fakeTerm(50, 550);
    harness.setTerm(term);
    harness.enforceBufferCeiling(true);

    term.buffer.active.length = 601; // one past baseline + rows
    harness.enforceBufferCeiling(false);

    expect(term.clear).toHaveBeenCalledTimes(1);
    expect(harness.baseline()).toBe(50);
  });

  it('bounds the buffer across a long run of over-wide repaints', () => {
    // The measured regression: lines wider than term.cols wrap, the payload
    // overflows the viewport, and the excess scrolls into the buffer at ~44
    // rows per poll — refilling the 5000-line scrollback in about 3 minutes.
    // Unguarded, 300 polls reached 4950 rows.
    const term = fakeTerm(50, 550);
    harness.setTerm(term);
    harness.enforceBufferCeiling(true);

    let peak = 0;
    for (let poll = 0; poll < 300; poll++) {
      term.buffer.active.length += 44;
      harness.enforceBufferCeiling(false);
      peak = Math.max(peak, term.buffer.active.length);
    }

    expect(peak).toBeLessThan(5000);
    expect(peak).toBeLessThanOrEqual(550 + 50 + 44);
    expect(term.clear).toHaveBeenCalled();
  });

  it('leaves a well-formed session flat', () => {
    // The guard must not fire on normal input: 100 polls that do not grow the
    // buffer clear nothing. This is what keeps it from eating live scrollback.
    const term = fakeTerm(50, 550);
    harness.setTerm(term);
    harness.enforceBufferCeiling(true);

    for (let poll = 0; poll < 100; poll++) harness.enforceBufferCeiling(false);

    expect(term.clear).not.toHaveBeenCalled();
    expect(term.buffer.active.length).toBe(550);
  });
});

// ---------------------------------------------------------------------------
// Scroll-up history resync, for all three session terminals.
//
// Live polls capture the visible pane only, so lines that scroll off it between
// polls never reached xterm's scrollback. Reproduced in @xterm/headless against
// the real repaint code:
//   - session view: the buffer jumped from `line 20` to `line 38` — the history
//     from when the session was opened, then the current screen, spliced.
//   - tasks panel / task detail (sized to their panel, not the pane): shorter
//     than the pane, every poll stacked another copy of the screen into
//     scrollback — 80 duplicated lines after five polls; taller, the same
//     splice as the session view.
// ---------------------------------------------------------------------------

function fakeTerm({ baseY = 500, viewportY = 500 } = {}) {
  const t = {
    cols: 200,
    rows: 50,
    writes: [],
    buffer: { active: { baseY, viewportY } },
    write: vi.fn((payload, cb) => {
      t.writes.push(payload);
      cb();
    }),
    scrollToBottom: vi.fn(() => {
      t.buffer.active.viewportY = t.buffer.active.baseY;
    }),
    scrollToLine: vi.fn((y) => {
      t.buffer.active.viewportY = y;
    }),
  };
  return t;
}
const fakeWs = () => ({ readyState: 1, send: vi.fn() });

/**
 * Each terminal's resync + writer, lifted from app.js into a closure that
 * rebuilds the state they read. `term`/`ws`/`scrolledUp` are wired per terminal.
 */
const TERMINALS = [
  {
    name: 'session view',
    resync: 'resyncTerminalHistory',
    write: 'writeTerminalContent',
    state: `let term = null, ws = null, currentSession = null, activePane = null, paneRows = 0;
      let userScrolledUp = false, writingContent = false, lastContent = '', readingMode = false;
      let _termWriteRAF = null;
      const enforceBufferCeiling = () => {};
      const livePaint = (c) => 'LIVE:' + c;`,
    wire: `(t, w, session, pane, up) => { term = t; ws = w; currentSession = session; activePane = pane; userScrolledUp = up; }`,
    // The session view repaints live polls in place; the panel-sized ones replace the buffer.
    livePrefix: 'LIVE:',
    subscribeExtra: { cols: 200, rows: 50 },
  },
  {
    name: 'tasks panel',
    resync: 'tsResyncHistory',
    write: 'writeTasksSessionContent',
    state: `let tasksSessionTerm = null, ws = null, tasksSessionNum = null, tsActivePane = null;
      let tsUserScrolledUp = false, tsWriting = false, tsLastContent = '', _tsWriteRAF = null;
      const ensureTasksSessionTerm = () => {};`,
    wire: `(t, w, session, pane, up) => { tasksSessionTerm = t; ws = w; tasksSessionNum = session; tsActivePane = pane; tsUserScrolledUp = up; }`,
    livePrefix: '\x1b[3J\x1b[H\x1b[J',
    subscribeExtra: {},
  },
  {
    name: 'task detail',
    resync: 'tdResyncHistory',
    write: 'writeTaskDetailContent',
    state: `let taskDetailTerm = null, ws = null, taskDetailSession = null, tdActivePane = null;
      let taskDetailScrolledUp = false, taskDetailWriting = false, taskDetailLastContent = '', _tdWriteRAF = null;`,
    wire: `(t, w, session, pane, up) => { taskDetailTerm = t; ws = w; taskDetailSession = session; tdActivePane = pane; taskDetailScrolledUp = up; }`,
    livePrefix: '\x1b[3J\x1b[H\x1b[J',
    subscribeExtra: {},
  },
];

/** The resync flag declaration sits just above each resync function. */
function extractFlag(name) {
  const m = source.match(
    new RegExp(`var (\\w+HistoryFresh|historyFresh) = false;\\s*function ${name}\\(`),
  );
  if (!m) throw new Error(`history flag for ${name} not found`);
  return `let ${m[1]} = false;`;
}

describe.each(TERMINALS)('$name — scroll-up history resync', (T) => {
  let h;

  beforeEach(() => {
    h = new Function(`
      ${T.state}
      ${extractFlag(T.resync)}
      const requestAnimationFrame = (fn) => { fn(); return 1; };
      const cancelAnimationFrame = () => {};
      ${extractFunction(source, T.resync)}
      ${extractFunction(source, T.write)}
      return { wire: ${T.wire}, resync: ${T.resync}, write: ${T.write} };
    `)();
  });

  it('asks for a fresh history capture on a scroll-up', () => {
    const ws = fakeWs();
    h.wire(fakeTerm(), ws, '20', 1, false);

    h.resync();

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      type: 'terminal:subscribe',
      session: '20',
      pane: 1,
      ...T.subscribeExtra,
    });
  });

  it('a run of wheel ticks costs one capture', () => {
    const ws = fakeWs();
    h.wire(fakeTerm(), ws, '20', null, false);

    for (let tick = 0; tick < 5; tick++) h.resync();

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0])).not.toHaveProperty('pane');
  });

  it('a full paint satisfies it, and a live paint makes the history stale again', () => {
    const ws = fakeWs();
    h.wire(fakeTerm(), ws, '20', null, false);

    h.write('history', true);
    h.resync();
    expect(ws.send).not.toHaveBeenCalled();

    h.write('screen', false);
    h.resync();
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when there is no live session behind the terminal', () => {
    // The tasks panel shows saved snapshots with the session cleared; a resync
    // would subscribe the live pane over the snapshot.
    const ws = fakeWs();
    h.wire(fakeTerm(), ws, null, null, false);

    h.resync();

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('a full paint replaces scrollback instead of stacking a second copy', () => {
    const term = fakeTerm();
    h.wire(term, fakeWs(), '20', null, false);

    h.write('history', true);

    expect(term.writes[0]).toBe('\x1b[3J\x1b[H\x1b[Jhistory');
  });

  it('writes a live paint the way this terminal needs', () => {
    const term = fakeTerm();
    h.wire(term, fakeWs(), '20', null, false);

    h.write('screen', false);

    expect(term.writes[0]).toBe(`${T.livePrefix}screen`);
  });

  it('keeps a scrolled-up reader the same distance from the bottom', () => {
    const term = fakeTerm({ baseY: 500, viewportY: 470 });
    term.write = vi.fn((payload, cb) => {
      term.buffer.active.baseY = 520; // the resync filled in the missing lines
      cb();
    });
    h.wire(term, fakeWs(), '20', null, true);

    h.write('history', true);

    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(term.scrollToLine).toHaveBeenCalledWith(490);
  });

  it('follows the bottom when the reader was not scrolled up', () => {
    const term = fakeTerm();
    h.wire(term, fakeWs(), '20', null, false);

    h.write('history', true);

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });
});

describe('scroll-up gestures drive the resync', () => {
  // A position check cannot fire when the buffer holds too little scrollback to
  // move 3 lines — after a clear, or in a tasks-panel terminal after a live paint —
  // so the request has to come from the gesture itself.
  it.each([
    ['term', 'resyncTerminalHistory', 'touchStartY'],
    ['tasksSessionTerm', 'tsResyncHistory', 'tsTouchStartY'],
    ['taskDetailTerm', 'tdResyncHistory', 'tdTouchStartY'],
  ])('%s requests history on wheel-up and on a downward swipe', (termVar, resync, touchVar) => {
    const wheel = source.match(
      new RegExp(`${termVar}\\.element\\.addEventListener\\('wheel', \\(e\\) => \\{[^\\n]*`),
    );
    expect(wheel?.[0]).toContain(`if (e.deltaY < 0) ${resync}()`);

    const touchStart = source.indexOf(`${touchVar} - (e.changedTouches[0] || {}).clientY`);
    expect(touchStart).toBeGreaterThan(-1);
    expect(source.slice(touchStart, touchStart + 200)).toContain(`if (dy < -20) ${resync}()`);
  });
});

describe('terminal:data — a full paint lands even while the reader is scrolled up', () => {
  // It is the resync the scroll-up asked for; deferring it like a live poll
  // would hold the stale history on screen until the reader scrolled back down.
  const handler = source.slice(
    source.indexOf("case 'terminal:data':"),
    source.indexOf('// Console (Session 0) terminal data'),
  );

  it.each([
    ['session view', 'writeTerminalContent(msg.content, true)'],
    ['tasks panel', 'writeTasksSessionContent(msg.content, true)'],
    ['task detail', 'writeTaskDetailContent(msg.content, true)'],
  ])('%s', (_name, call) => {
    const at = handler.indexOf(call);
    expect(at).toBeGreaterThan(-1);
    // The full-paint branch comes before, and outside, the scrolled-up deferral.
    const branch = handler.slice(handler.lastIndexOf('msg.full === true', at), at);
    expect(branch).not.toMatch(/ScrolledUp|scrolledUp/);
  });
});
