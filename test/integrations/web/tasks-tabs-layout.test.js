import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CSS = fs.readFileSync(
  path.join(process.cwd(), 'src/integrations/web/public/styles.css'),
  'utf8',
);

/**
 * The Tasks → List status row: In Progress (+ caret), Queued, Snoozed,
 * Completed, then `+ Create` pushed right with `margin-left: auto`.
 *
 * At ≥900px the list pane is `width: 30%; flex: none`, so it cannot grow to fit
 * that row. The row used to be a single non-wrapping line about 523px wide, so
 * at 1440px (a 413px pane) `+ Create` spilled out of the pane and the session
 * pane — later in the DOM, `position: relative` — painted over it.
 * `document.elementFromPoint` at the button's centre returned the session
 * header, at 1280px it covered Completed too, and a click did nothing.
 *
 * jsdom has no layout, so these tests pin the rules instead. The hand-run
 * Playwright probe in the PR measured the result at 400/900/1024/1280/1440/
 * 1600/1900/1920.
 */

/** Flatten styles.css into { media, selector, decls } rules. Comments dropped. */
function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  function walk(text, media) {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) {
        walk(body, prelude.replace(/\s+/g, ' '));
      } else {
        const decls = {};
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon === -1) continue;
          decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
        }
        for (const sel of prelude.split(',')) {
          rules.push({ media: media || null, selector: sel.trim().replace(/\s+/g, ' '), decls });
        }
      }
      i = j;
    }
  }
  walk(src, null);
  return rules;
}

const RULES = parseRules(CSS);

/** Merged declarations for `selector` in one media context (null = top level). */
function declsFor(selector, media) {
  const out = {};
  for (const r of RULES) {
    if (r.selector === selector && r.media === media) Object.assign(out, r.decls);
  }
  return out;
}

const DESKTOP = '@media (min-width: 900px)';
const PHONE = '@media (max-width: 640px)';

describe('Tasks list status row layout', () => {
  it('finds the media blocks it reasons about', () => {
    // Guards the rest: a renamed breakpoint would otherwise make every
    // media-scoped assertion below pass vacuously on an empty object.
    expect(RULES.some((r) => r.media === DESKTOP)).toBe(true);
    expect(RULES.some((r) => r.media === PHONE)).toBe(true);
  });

  it('gives the desktop list pane a fixed width, which is why the row has to wrap', () => {
    // If this ever changes (say, back to a flex share that grows to fit its
    // content), the wrap below may no longer be needed. Re-measure then.
    const pane = declsFor('.tasks-list-pane', DESKTOP);
    expect(pane.width).toBe('30%');
    expect(pane.flex).toBe('none');
  });

  it('wraps the status row, so + Create drops to a new line instead of under the session pane', () => {
    expect(declsFor('.tasks-tabs', null)['flex-wrap']).toBe('wrap');
  });

  it('does not let the desktop split override the wrap', () => {
    expect(declsFor('.tasks-tabs', DESKTOP)['flex-wrap']).toBeUndefined();
  });

  it('keeps the phone row a one-line swipeable carousel', () => {
    // The top-level wrap must not leak into the phone layout, which has no
    // session pane and scrolls the row sideways instead.
    const tabs = declsFor('.tasks-tabs', PHONE);
    expect(tabs['flex-wrap']).toBe('nowrap');
    expect(tabs['overflow-x']).toBe('auto');
  });
});

describe('Task card action row layout', () => {
  // Same pane, same failure: an in-progress card's row (Assign, Snooze,
  // Requeue, Defer, Done, Cancel) is wider than a 1440px list pane, and Cancel
  // sat under the session pane. The phone block already wrapped this row.
  it('wraps the action row at every width, not only on a phone', () => {
    expect(declsFor('.task-actions', null)['flex-wrap']).toBe('wrap');
    expect(declsFor('.task-actions', DESKTOP)['flex-wrap']).toBeUndefined();
  });
});

describe('Task card info row layout', () => {
  // Same pane, same failure: an in-progress card with every badge (source,
  // pending approval, waiting, time, PR, CI) is wider than a 1280px list pane,
  // and the CI link sat under the session pane. The phone block already
  // wrapped this row.
  it('wraps the info row at every width, not only on a phone', () => {
    expect(declsFor('.task-info', null)['flex-wrap']).toBe('wrap');
    expect(declsFor('.task-info', DESKTOP)['flex-wrap']).toBeUndefined();
  });
});

describe('Tasks bulk bar layout', () => {
  // Same pane, same failure: with a task ticked, the bar (count, Cancel,
  // Requeue, Defer, Mark Done) is wider than a 900px list pane, and Defer and
  // Mark Done sat under the resize handle and session pane. The phone block
  // already wrapped this row.
  it('wraps the bulk bar at every width, not only on a phone', () => {
    expect(declsFor('.tasks-bulk-bar', null)['flex-wrap']).toBe('wrap');
    expect(declsFor('.tasks-bulk-bar', DESKTOP)['flex-wrap']).toBeUndefined();
  });
});
