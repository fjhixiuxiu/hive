import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.resolve(__dirname, '../../../src/integrations/web/public/index.html');
const CSS_PATH = path.resolve(__dirname, '../../../src/integrations/web/public/styles.css');
const JS_PATH = path.resolve(__dirname, '../../../src/integrations/web/public/app.js');

// ---------------------------------------------------------------------------
// Unit tests: Tooltip module logic (extracted for testability)
// ---------------------------------------------------------------------------

function createTooltipModule() {
  let tooltipEl = null;
  let showTimer = null;
  let hideTimer = null;
  let currentTarget = null;
  const SHOW_DELAY = 400;
  const HIDE_DELAY = 100;

  function create() {
    if (tooltipEl) return;
    tooltipEl = { className: 'hive-tooltip', classes: new Set(['hive-tooltip']), innerHTML: '', role: 'tooltip' };
  }

  function show(target) {
    const text = target['data-tooltip'];
    if (!text) return;
    create();
    clearTimeout(hideTimer);
    tooltipEl.innerHTML = text;
    tooltipEl.classes.add('visible');
    currentTarget = target;
  }

  function hide() {
    clearTimeout(showTimer);
    if (!tooltipEl) return;
    tooltipEl.classes.delete('visible');
    currentTarget = null;
  }

  function startShow(target) {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    if (currentTarget === target) return;
    showTimer = setTimeout(() => show(target), SHOW_DELAY);
  }

  function startHide() {
    clearTimeout(showTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  return {
    show, hide, startShow, startHide,
    getEl: () => tooltipEl,
    getCurrentTarget: () => currentTarget,
  };
}

function makeTarget(tooltipText) {
  return { 'data-tooltip': tooltipText };
}

describe('Tooltip module logic', () => {
  let tooltip;

  beforeEach(() => {
    vi.useFakeTimers();
    tooltip = createTooltipModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create tooltip element on first show', () => {
    expect(tooltip.getEl()).toBe(null);
    tooltip.show(makeTarget('Hello'));
    expect(tooltip.getEl()).not.toBe(null);
    expect(tooltip.getEl().role).toBe('tooltip');
  });

  it('should display the tooltip text from data-tooltip', () => {
    tooltip.show(makeTarget('Restart all sessions'));
    expect(tooltip.getEl().innerHTML).toBe('Restart all sessions');
    expect(tooltip.getEl().classes.has('visible')).toBe(true);
  });

  it('should not show tooltip if data-tooltip is empty', () => {
    tooltip.show(makeTarget(''));
    expect(tooltip.getEl()).toBe(null);
  });

  it('should not show tooltip if data-tooltip is undefined', () => {
    tooltip.show({ 'data-tooltip': undefined });
    expect(tooltip.getEl()).toBe(null);
  });

  it('should hide tooltip and clear currentTarget', () => {
    tooltip.show(makeTarget('Hello'));
    expect(tooltip.getEl().classes.has('visible')).toBe(true);
    expect(tooltip.getCurrentTarget()).not.toBe(null);

    tooltip.hide();
    expect(tooltip.getEl().classes.has('visible')).toBe(false);
    expect(tooltip.getCurrentTarget()).toBe(null);
  });

  it('should show tooltip after delay via startShow', () => {
    const t = makeTarget('Delayed');
    tooltip.startShow(t);
    expect(tooltip.getEl()).toBe(null);

    vi.advanceTimersByTime(400);
    expect(tooltip.getEl()).not.toBe(null);
    expect(tooltip.getEl().classes.has('visible')).toBe(true);
  });

  it('should cancel show when startHide is called before delay', () => {
    tooltip.startShow(makeTarget('Canceled'));
    vi.advanceTimersByTime(200);
    tooltip.startHide();
    vi.advanceTimersByTime(300);
    expect(tooltip.getEl()).toBe(null);
  });

  it('should hide tooltip after delay via startHide', () => {
    tooltip.show(makeTarget('Will hide'));
    expect(tooltip.getEl().classes.has('visible')).toBe(true);

    tooltip.startHide();
    expect(tooltip.getEl().classes.has('visible')).toBe(true);

    vi.advanceTimersByTime(100);
    expect(tooltip.getEl().classes.has('visible')).toBe(false);
  });

  it('should update content when showing different target', () => {
    tooltip.show(makeTarget('First'));
    expect(tooltip.getEl().innerHTML).toBe('First');

    tooltip.show(makeTarget('Second'));
    expect(tooltip.getEl().innerHTML).toBe('Second');
  });

  it('should reuse the same tooltip object', () => {
    tooltip.show(makeTarget('A'));
    const el1 = tooltip.getEl();
    tooltip.show(makeTarget('B'));
    const el2 = tooltip.getEl();
    expect(el1).toBe(el2);
  });

  it('should not re-trigger startShow for same target', () => {
    const t = makeTarget('Same');
    tooltip.show(t);
    // startShow on same target should be a no-op
    tooltip.startShow(t);
    vi.advanceTimersByTime(500);
    expect(tooltip.getEl().innerHTML).toBe('Same');
    expect(tooltip.getCurrentTarget()).toBe(t);
  });
});

// ---------------------------------------------------------------------------
// HTML integration: verify data-tooltip attributes are properly placed
// ---------------------------------------------------------------------------

describe('HTML data-tooltip attributes', () => {
  let html;

  beforeEach(() => {
    html = fs.readFileSync(HTML_PATH, 'utf8');
  });

  it('should not have title attributes on buttons or links', () => {
    // Match <button ... title="..." or <a ... title="..."
    const buttonTitles = html.match(/<button\b[^>]*\btitle="/g);
    const linkTitles = html.match(/<a\b[^>]*\btitle="/g);
    expect(buttonTitles, 'Found <button> elements still using title= attribute').toBe(null);
    expect(linkTitles, 'Found <a> elements still using title= attribute').toBe(null);
  });

  it('sidebar nav buttons should have data-tooltip', () => {
    // All nav-btn with data-tab should also have data-tooltip
    const navBtnPattern = /class="nav-btn[^"]*"\s+data-tab="[^"]+"/g;
    const matches = html.match(navBtnPattern) || [];
    expect(matches.length).toBeGreaterThan(0);

    // Check that each nav-btn line also contains data-tooltip
    const navBtnLines = html.split('\n').filter(l => l.includes('class="nav-btn') && l.includes('data-tab='));
    for (const line of navBtnLines) {
      expect(line, `Nav button line missing data-tooltip: ${line.trim()}`).toContain('data-tooltip=');
    }
  });

  it('fleet control buttons should have data-tooltip', () => {
    for (const id of ['restart-all-btn', 'shutdown-all-btn']) {
      const pattern = new RegExp(`id="${id}"[^>]*data-tooltip="`);
      expect(html).toMatch(pattern);
    }
  });

  it('fleet view toggle buttons should have data-tooltip', () => {
    const viewBtnLines = html.split('\n').filter(l => l.includes('fleet-view-btn'));
    expect(viewBtnLines.length).toBeGreaterThan(0);
    for (const line of viewBtnLines) {
      expect(line, `View button missing data-tooltip: ${line.trim()}`).toContain('data-tooltip=');
    }
  });

  it('session action buttons should have data-tooltip', () => {
    for (const id of ['track-btn', 'restart-btn', 'kill-btn']) {
      const pattern = new RegExp(`id="${id}"[^>]*data-tooltip="`);
      expect(html).toMatch(pattern);
    }
  });

  it('quick bar buttons should have data-tooltip', () => {
    for (const id of ['quick-target', 'quick-all', 'quick-mode', 'quick-send']) {
      const pattern = new RegExp(`id="${id}"[^>]*data-tooltip="`);
      expect(html).toMatch(pattern);
    }
  });

  it('main session key buttons should have data-tooltip', () => {
    // Extract the keys-bar section
    const keysBarMatch = html.match(/<div id="keys-bar">([\s\S]*?)<\/div>/);
    expect(keysBarMatch).not.toBe(null);
    const keysBar = keysBarMatch[1];
    const btnMatches = keysBar.match(/<button[^>]+>/g) || [];
    expect(btnMatches.length).toBeGreaterThan(0);
    for (const btn of btnMatches) {
      expect(btn, `Key button missing data-tooltip: ${btn}`).toContain('data-tooltip=');
    }
  });

  it('console key buttons should have data-tooltip', () => {
    const consoleKeysMatch = html.match(/<div id="console-keys-bar">([\s\S]*?)<\/div>/);
    expect(consoleKeysMatch).not.toBe(null);
    const consoleKeys = consoleKeysMatch[1];
    const btnMatches = consoleKeys.match(/<button[^>]+>/g) || [];
    expect(btnMatches.length).toBeGreaterThan(0);
    for (const btn of btnMatches) {
      expect(btn, `Console key button missing data-tooltip: ${btn}`).toContain('data-tooltip=');
    }
  });

  it('theme toggle should have data-tooltip', () => {
    expect(html).toMatch(/id="theme-toggle"[^>]*data-tooltip="/);
  });

  it('console-btn (Ask) should have data-tooltip', () => {
    expect(html).toMatch(/id="console-btn"[^>]*data-tooltip="/);
  });
});

// ---------------------------------------------------------------------------
// CSS: verify tooltip styles exist
// ---------------------------------------------------------------------------

describe('CSS tooltip styles', () => {
  let css;

  beforeEach(() => {
    css = fs.readFileSync(CSS_PATH, 'utf8');
  });

  it('should define .hive-tooltip base class', () => {
    expect(css).toContain('.hive-tooltip');
  });

  it('should define .hive-tooltip.visible state', () => {
    expect(css).toContain('.hive-tooltip.visible');
  });

  it('should define .hive-tooltip.pos-above for upward positioning', () => {
    expect(css).toContain('.hive-tooltip.pos-above');
  });

  it('should define .tt-key class for keyboard shortcut badges', () => {
    expect(css).toContain('.tt-key');
  });

  it('should set pointer-events: none to prevent tooltip blocking clicks', () => {
    expect(css).toContain('pointer-events: none');
  });

  it('should set z-index high enough to appear above all other elements', () => {
    const zMatch = css.match(/\.hive-tooltip\s*\{[^}]*z-index:\s*(\d+)/);
    expect(zMatch).not.toBe(null);
    expect(parseInt(zMatch[1])).toBeGreaterThanOrEqual(9999);
  });
});

// ---------------------------------------------------------------------------
// JS: verify tooltip module exists in app.js
// ---------------------------------------------------------------------------

describe('app.js tooltip integration', () => {
  let js;

  beforeEach(() => {
    js = fs.readFileSync(JS_PATH, 'utf8');
  });

  it('should contain Tooltip module', () => {
    expect(js).toContain('const Tooltip');
  });

  it('should initialize tooltips with Tooltip.init()', () => {
    expect(js).toContain('Tooltip.init()');
  });

  it('should listen for mouseenter events on data-tooltip elements', () => {
    expect(js).toContain('mouseenter');
    expect(js).toContain("closest('[data-tooltip]')");
  });

  it('should listen for mouseleave events', () => {
    expect(js).toContain('mouseleave');
  });

  it('should support touch events for mobile (long-press)', () => {
    expect(js).toContain('touchstart');
    expect(js).toContain('touchend');
    expect(js).toContain('touchcancel');
  });

  it('should dismiss on scroll', () => {
    expect(js).toContain("'scroll'");
  });

  it('should dismiss on Escape key', () => {
    expect(js).toContain("'Escape'");
  });

  it('should use data-tooltip instead of title for command descriptions', () => {
    // Verify cmd-btn uses data-tooltip, not title
    const cmdBtnDescLines = js.split('\n').filter(l =>
      l.includes('cmd.description') && (l.includes('.title') || l.includes('data-tooltip'))
    );
    for (const line of cmdBtnDescLines) {
      expect(line, 'cmd-btn should use data-tooltip, not .title').toContain('data-tooltip');
      expect(line).not.toContain('.title =');
    }
  });
});
