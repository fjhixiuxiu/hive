import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '../../../src/integrations/web/public/app.js');

// ---------------------------------------------------------------------------
// The composers' auto-grow.
//
// #msg-input and .ts-msg are capped at max-height:40vh, #task-dialog-text at
// 50vh. Past the cap the box scrolls internally — and autoGrow collapses it to
// height:'auto' on every keystroke to re-measure, which discards the browser's
// own "scroll the caret into view". Nothing put it back, so the line being
// typed sat below the visible box, and the session panel around it is
// overflow:hidden: there was no outer scroll to reach it with.
//
// autoGrow is lifted out of app.js rather than restated, so a change there that
// stops clamping or stops re-applying the scroll cannot pass this.
// ---------------------------------------------------------------------------

const source = fs.readFileSync(APP_JS, 'utf8');

function autoGrowSource() {
  const m = source.match(/function autoGrow\(el\) \{[\s\S]*?\n {2}\}/);
  if (!m) throw new Error('could not find autoGrow in app.js');
  return m[0];
}

function liftAutoGrow(getComputedStyle) {
  return new Function('getComputedStyle', `return (${autoGrowSource()});`)(getComputedStyle);
}

// growAndRefit calls autoGrow, so both come across together into one scope.
function liftGrowAndRefit(getComputedStyle, document, requestAnimationFrame) {
  const m = source.match(/function growAndRefit\(el, paneId, refit\) \{[\s\S]*?\n {2}\}/);
  if (!m) throw new Error('could not find growAndRefit in app.js');
  return new Function(
    'getComputedStyle',
    'document',
    'requestAnimationFrame',
    `${autoGrowSource()}\n${m[0]}\nreturn growAndRefit;`,
  )(getComputedStyle, document, requestAnimationFrame);
}

// A textarea with only the parts of CSS that this behaviour turns on: content
// height sets scrollHeight, max-height clamps the used height, and scrollTop
// cannot exceed the overflow. Nothing here scrolls itself — which is the point.
// Whatever the browser's caret-scroll did before the input event, the re-measure
// in autoGrow is free to throw away, so autoGrow is what has to leave the caret
// line inside the visible window.
function makeTextarea({ maxHeight, lineHeight = 20 }) {
  const el = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    style: { height: 'auto' },
    _maxHeight: maxHeight,
    _scrollTop: 0,
  };
  const contentHeight = () => el.value.split('\n').length * lineHeight;
  const maxScroll = () => Math.max(0, el.scrollHeight - el.clientHeight);
  Object.defineProperty(el, 'clientHeight', {
    get: () => {
      const specified = el.style.height === 'auto' ? contentHeight() : parseFloat(el.style.height);
      return Math.min(specified, el._maxHeight);
    },
  });
  Object.defineProperty(el, 'scrollHeight', {
    get: () => Math.max(contentHeight(), el.clientHeight),
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => Math.min(el._scrollTop, maxScroll()),
    set: (v) => {
      el._scrollTop = Math.max(0, Math.min(v, maxScroll()));
    },
  });
  el.maxScroll = maxScroll;
  // The caret line is visible when it sits inside the scrolled window.
  el.caretLineVisible = () => {
    const caretLine = el.value.slice(0, el.selectionEnd).split('\n').length - 1;
    const top = caretLine * lineHeight;
    return top >= el.scrollTop && top + lineHeight <= el.scrollTop + el.clientHeight;
  };
  el.typeAtEnd = (text) => {
    el.value += text;
    el.selectionStart = el.selectionEnd = el.value.length;
  };
  el.typeAt = (index, text) => {
    el.value = el.value.slice(0, index) + text + el.value.slice(index);
    el.selectionStart = el.selectionEnd = index + text.length;
  };
  return el;
}

const computedStyle = (el) => ({ maxHeight: `${el._maxHeight}px` });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('composer auto-grow', () => {
  const autoGrow = liftAutoGrow(computedStyle);

  it('grows with the content while the content still fits', () => {
    const el = makeTextarea({ maxHeight: 400 });
    el.typeAtEnd(lines(5));
    autoGrow(el);
    expect(el.style.height).toBe('100px');
  });

  it('never sets a height past the cap the stylesheet gives it', () => {
    // The height it writes has to describe the element. It used to keep
    // climbing past max-height — 448px of inline height on a 384px box — so
    // every later measurement was taken against a number the page never used.
    const el = makeTextarea({ maxHeight: 400 });
    el.typeAtEnd(lines(40));
    autoGrow(el);
    expect(parseFloat(el.style.height)).toBeLessThanOrEqual(400);
  });

  it('keeps the line being typed visible once the box is capped', () => {
    // The reported bug: past the cap the text you are typing goes below the
    // visible box and nothing can scroll to it.
    const el = makeTextarea({ maxHeight: 400 });
    el.typeAtEnd(lines(40));
    autoGrow(el);
    expect(el.caretLineVisible(), 'the caret line is below the visible box').toBe(true);
    expect(el.scrollTop).toBe(el.maxScroll());
  });

  it('stays at the bottom as each new line is typed', () => {
    const el = makeTextarea({ maxHeight: 400 });
    for (let i = 1; i <= 60; i++) {
      el.typeAtEnd(i === 1 ? 'line 1' : '\nline ' + i);
      autoGrow(el);
      expect(el.caretLineVisible(), `caret lost at line ${i}`).toBe(true);
    }
  });

  it('respects a different cap — the task dialog is 50vh, not 40vh', () => {
    const el = makeTextarea({ maxHeight: 600 });
    el.typeAtEnd(lines(60));
    autoGrow(el);
    expect(el.style.height).toBe('600px');
    expect(el.caretLineVisible()).toBe(true);
  });

  it('leaves the view where it is when the edit is mid-text', () => {
    // Regression guard for the fix itself: scrolling to the bottom on every
    // keystroke would yank the view away from someone editing higher up.
    const el = makeTextarea({ maxHeight: 400 });
    el.typeAtEnd(lines(40));
    autoGrow(el);
    el.scrollTop = 0;
    el.typeAt(4, 'EDIT');
    autoGrow(el);
    expect(el.scrollTop).toBe(0);
    expect(el.caretLineVisible()).toBe(true);
  });

  it('does not scroll a box that has not reached its cap', () => {
    const el = makeTextarea({ maxHeight: 400 });
    el.typeAtEnd(lines(5));
    autoGrow(el);
    expect(el.scrollTop).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The pane above the composer.
//
// Every pixel the composer takes comes out of #terminal-wrap, which is
// overflow:hidden with an xterm inside that keeps whatever row count it was
// last fitted to. Nothing refitted it on composer growth, so the bottom rows —
// the live tail among them — were cut off: measured against a real xterm, the
// readable output went from lines 173-200 to lines 173-187 the moment the box
// hit its cap, and stayed there until an unrelated event refitted it.
// ---------------------------------------------------------------------------

describe('composer auto-grow refits the pane above it', () => {
  // The flex column in one line: whatever the composer takes, the pane loses.
  function makePane(el, total) {
    return {
      get clientHeight() {
        return total - el.clientHeight;
      },
    };
  }

  function harness({ maxHeight = 400, total = 800, paneId = 'terminal-wrap' } = {}) {
    const el = makeTextarea({ maxHeight });
    // The box carries the height the last keystroke left on it — height:'auto'
    // only exists for the instant autoGrow re-measures in.
    el.style.height = '100px';
    const pane = makePane(el, total);
    const frames = [];
    const growAndRefit = liftGrowAndRefit(
      computedStyle,
      { getElementById: (id) => (id === paneId ? pane : null) },
      (cb) => {
        frames.push(cb);
      }, // held, not run: rAF is not synchronous
    );
    return {
      el,
      pane,
      frames,
      growAndRefit,
      runFrames: () => {
        frames.splice(0).forEach((cb) => cb());
      },
    };
  }

  it('refits the pane the composer just took height from', () => {
    const h = harness();
    let refits = 0;
    h.el.typeAtEnd(lines(40));
    h.growAndRefit(h.el, 'terminal-wrap', () => {
      refits++;
    });
    h.runFrames();
    expect(refits, 'the pane shrank and was never told').toBe(1);
  });

  it('does not refit when the box did not change size', () => {
    // The guard that keeps this off the per-keystroke path: a character typed
    // into a box already at its cap costs nothing.
    const h = harness();
    h.el.typeAtEnd(lines(40));
    h.growAndRefit(h.el, 'terminal-wrap', () => {});
    h.runFrames();
    let refits = 0;
    h.el.typeAtEnd('x');
    h.growAndRefit(h.el, 'terminal-wrap', () => {
      refits++;
    });
    h.runFrames();
    expect(refits).toBe(0);
  });

  it('refits when the box shrinks too, not only when it grows', () => {
    // Sending a message empties the composer and hands the height back.
    const h = harness();
    h.el.typeAtEnd(lines(40));
    h.growAndRefit(h.el, 'terminal-wrap', () => {});
    h.runFrames();
    let refits = 0;
    h.el.value = '';
    h.el.selectionStart = h.el.selectionEnd = 0;
    h.growAndRefit(h.el, 'terminal-wrap', () => {
      refits++;
    });
    h.runFrames();
    expect(refits).toBe(1);
  });

  it('still grows the box when the pane is not there', () => {
    // The task dialog floats over the page and takes height from nothing.
    const h = harness();
    let refits = 0;
    h.el.typeAtEnd(lines(40));
    h.growAndRefit(h.el, 'no-such-pane', () => {
      refits++;
    });
    h.runFrames();
    expect(refits).toBe(0);
    expect(h.el.style.height).toBe('400px');
    expect(h.el.caretLineVisible()).toBe(true);
  });

  it('grows the box before the refit is queued, not after', () => {
    // The refit reads the pane's new height, so the resize has to have landed
    // by the time the frame runs.
    const h = harness();
    h.el.typeAtEnd(lines(40));
    let paneAtRefit = null;
    h.growAndRefit(h.el, 'terminal-wrap', () => {
      paneAtRefit = h.pane.clientHeight;
    });
    h.runFrames();
    expect(paneAtRefit).toBe(400); // 800 total - the 400px cap
  });
});

// ---------------------------------------------------------------------------
// Everything else that resizes the pane.
//
// growAndRefit only hears the composer's input events. sendMessage empties the
// composer by setting height:'auto' directly — no input event — so after every
// multi-line send the pane grew back while xterm kept its typing-time rows:
// measured in the live dashboard, pane 608px with xterm stuck at 525px, a blank
// band under the output. refitOnResize watches the pane itself.
// ---------------------------------------------------------------------------

describe('the terminal pane refits on any resize', () => {
  function harness() {
    const pane = { clientWidth: 1000, clientHeight: 600 };
    let observed = null;
    let fire = null;
    class FakeResizeObserver {
      constructor(cb) {
        fire = cb;
      }
      observe(el) {
        observed = el;
      }
    }
    const frames = [];
    const m = source.match(/function refitOnResize\(paneId, refit\) \{[\s\S]*?\n {2}\}/);
    if (!m) throw new Error('could not find refitOnResize in app.js');
    const refitOnResize = new Function(
      'document',
      'ResizeObserver',
      'requestAnimationFrame',
      `${m[0]}\nreturn refitOnResize;`,
    )(
      { getElementById: (id) => (id === 'terminal-wrap' ? pane : null) },
      FakeResizeObserver,
      (cb) => frames.push(cb),
    );
    let refits = 0;
    refitOnResize('terminal-wrap', () => refits++);
    return {
      pane,
      observed: () => observed,
      resize: (w, h) => {
        pane.clientWidth = w;
        pane.clientHeight = h;
        fire();
        frames.splice(0).forEach((cb) => cb());
      },
      refits: () => refits,
    };
  }

  it('observes the pane it was given', () => {
    const h = harness();
    expect(h.observed()).toBe(h.pane);
  });

  it('refits when the pane grows back after a send empties the composer', () => {
    const h = harness();
    h.resize(1000, 525); // composer grown while typing
    h.resize(1000, 608); // sendMessage: value='' + height:'auto', no input event
    expect(h.refits()).toBe(2);
  });

  it('does not refit when the size did not change', () => {
    const h = harness();
    h.resize(1000, 525);
    h.resize(1000, 525);
    expect(h.refits()).toBe(1);
  });

  it('does not fit a hidden pane, and does not refit when it reappears unchanged', () => {
    const h = harness();
    h.resize(1000, 525);
    h.resize(0, 0); // tab switched away: display:none
    h.resize(1000, 525);
    expect(h.refits()).toBe(1);
  });

  it('is a no-op for a pane that is not in the page', () => {
    const m = source.match(/function refitOnResize\(paneId, refit\) \{[\s\S]*?\n {2}\}/);
    const refitOnResize = new Function(
      'document',
      'ResizeObserver',
      'requestAnimationFrame',
      `${m[0]}\nreturn refitOnResize;`,
    )({ getElementById: () => null }, class {}, () => {});
    expect(() => refitOnResize('nope', () => {})).not.toThrow();
  });

  // The tests above prove the function; this proves it is switched on. Deleting
  // both calls left every web test green, and a missing pane id is a silent
  // no-op by design — so the ids are checked against the page as well.
  it('is wired to both terminals that sit above an auto-growing composer', () => {
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../../src/integrations/web/public/index.html'),
      'utf8',
    );
    for (const [paneId, refit] of [
      ['terminal-wrap', 'refitSessionTerminal'],
      ['tasks-session-terminal', 'refitTasksTerminal'],
    ]) {
      const call = `refitOnResize('${paneId}', ${refit});`;
      expect(source.includes(`\n  ${call}`), `app.js never calls ${call}`).toBe(true);
      expect(html).toContain(`id="${paneId}"`);
    }
  });
});
