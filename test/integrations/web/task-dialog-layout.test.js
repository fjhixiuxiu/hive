import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const INDEX = fs.readFileSync(
  path.join(process.cwd(), 'src/integrations/web/public/index.html'),
  'utf8',
);

/**
 * The Create Task dialog's markup.
 *
 * `.dialog` caps itself at `calc(100vh - 48px)` and lays its children out as a
 * column, but it does not scroll — so content past the cap is clipped, and the
 * clipped part is the actions row at the bottom. Adding Project Manager and
 * Track was enough to push a phone past that cap and make Create unreachable.
 *
 * `.dialog-scroll` (already defined in styles.css, with no users until now) is
 * the fix: the body scrolls, the title and the actions stay put. These tests
 * pin the structure, because the failure mode is invisible in a diff — you can
 * add a field outside the wrapper and nothing looks wrong until a short screen
 * loses its Create button.
 */
function taskDialogHtml() {
  const start = INDEX.indexOf('<div class="dialog-overlay" id="task-dialog">');
  expect(start).toBeGreaterThan(-1);
  const end = INDEX.indexOf('<!-- Assign task dialog -->', start);
  expect(end).toBeGreaterThan(start);
  return INDEX.slice(start, end);
}

describe('Create Task dialog layout', () => {
  const html = taskDialogHtml();

  // Index just past the `</div>` that closes `.dialog-scroll`, found by
  // balancing tags — string search alone cannot tell that close from the
  // dozen nested ones before it.
  function scrollEnd() {
    const open = html.indexOf('<div class="dialog-scroll">');
    expect(open).toBeGreaterThan(-1);
    let depth = 0;
    const tag = /<div\b|<\/div>/g;
    tag.lastIndex = open;
    let m;
    while ((m = tag.exec(html)) !== null) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) return m.index + m[0].length;
    }
    throw new Error('.dialog-scroll is never closed');
  }

  it('wraps its body in a scroll container', () => {
    expect(html).toContain('<div class="dialog-scroll">');
  });

  it('keeps the actions row outside the scroll container, so Create stays pinned', () => {
    expect(html.indexOf('<div class="dialog-actions">')).toBeGreaterThan(scrollEnd());
  });

  it('leaves nothing stranded between the scroll container and the actions row', () => {
    // A field added after the wrapper closes renders below the scroll area and
    // eats the same vertical budget the wrapper exists to protect.
    const gap = html.slice(scrollEnd(), html.indexOf('<div class="dialog-actions">'));
    expect(gap.trim()).toBe('');
  });

  it('puts every field inside the scroll container', () => {
    const scrollStart = html.indexOf('<div class="dialog-scroll">');
    for (const id of [
      'task-dialog-title',
      'task-dialog-text',
      'task-dialog-assignee',
      'task-dialog-pm',
      'task-dialog-track',
      'task-dialog-designation',
      'task-dialog-queue-field',
      'task-dialog-picker',
      'task-dialog-require-human-close',
    ]) {
      const at = html.indexOf(`id="${id}"`);
      expect(at, `${id} is missing from the dialog`).toBeGreaterThan(-1);
      expect(at, `${id} must sit inside .dialog-scroll`).toBeGreaterThan(scrollStart);
      expect(at, `${id} must sit above the scroll container's close`).toBeLessThan(scrollEnd());
    }
  });
});

describe('Create Task dialog — PM and Track controls', () => {
  const html = taskDialogHtml();

  it('offers (none) as the PM default', () => {
    expect(html).toMatch(/id="task-dialog-pm"><option value="">\(none\)<\/option>/);
  });

  it('gives each new field a hint element the client writes into', () => {
    expect(html).toContain('id="task-dialog-pm-hint"');
    expect(html).toContain('id="task-dialog-track-hint"');
  });

  it('names every Track shape in the placeholder', () => {
    const m = /id="task-dialog-track"[\s\S]*?placeholder="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    for (const shape of ['PR URL', 'owner/repo#N', '#N', 'JIRA']) {
      expect(m[1]).toContain(shape);
    }
    // Track is the per-task opt-in, so it has to read as optional.
    expect(m[1]).toContain('optional');
  });

  it('wraps each new field in an element the client can hide on the edit path', () => {
    expect(html).toContain('id="task-dialog-pm-field"');
    expect(html).toContain('id="task-dialog-track-field"');
  });
});
