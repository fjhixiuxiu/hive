// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const {
  popoverBottom,
  wireKeysPopover,
} = require('../../../src/integrations/web/public/keys-popover.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '../../../src/integrations/web/public');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

// ---------------------------------------------------------------------------
// On phones the session keys bar is a fixed popover, closed only by the ⌨ Keys
// toggle on the status line below it. It sat a hardcoded 80px above the bottom
// of the screen — the status line plus a one-row composer. One keystroke grows
// the composer to its four-row height (36px → 99px at 412px wide), the status
// line moves up 63px, and the popover covers the toggle: a tap on it lands on
// the popover's Tab key, sends Tab, and the popover can't be closed.
//
// jsdom has no layout, so these tests supply the geometry the browser would.
// ---------------------------------------------------------------------------

describe('the mobile keys bar is placed from the status line, not a fixed offset', () => {
  it('styles.css reads the measured offset', () => {
    const rule = css.match(/#keys-bar\s*\{[^}]*position:\s*fixed[^}]*\}/);
    expect(rule, 'mobile #keys-bar popover rule').not.toBeNull();
    expect(rule[0]).toMatch(/bottom:\s*var\(--keys-popover-bottom/);
  });

  it('app.js wires the popover instead of toggling the class itself', () => {
    expect(appJs).toContain('wireKeysPopover(');
    expect(appJs).not.toMatch(/keysBar\.classList\.toggle\('mobile-open'\)/);
  });
});

describe('popoverBottom', () => {
  it('puts the popover’s bottom edge on the anchor’s top edge', () => {
    // The measured case: status line top at 776 on a 915px screen.
    expect(popoverBottom(915, 776)).toBe(139);
  });

  it('rounds, and never goes below the screen edge', () => {
    expect(popoverBottom(915, 775.6)).toBe(139);
    expect(popoverBottom(915, 950)).toBe(0);
  });
});

describe('wireKeysPopover', () => {
  let observers;
  let anchorTop;
  let bar, anchor, inputBar, toggle, outside;

  class FakeResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      observers.push(this);
    }
    observe(el) {
      this.targets.push(el);
    }
    fire() {
      this.cb([]);
    }
  }

  beforeEach(() => {
    observers = [];
    window.ResizeObserver = FakeResizeObserver;
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      get: () => 915,
    });
    document.body.innerHTML = `
      <div id="keys-bar"><button class="key-btn" data-key="Tab">Tab</button></div>
      <div id="session-status-line"><button id="mobile-keys-toggle">⌨ Keys</button></div>
      <div id="input-bar"><textarea id="msg-input"></textarea></div>
      <div id="terminal">terminal</div>`;
    bar = document.getElementById('keys-bar');
    anchor = document.getElementById('session-status-line');
    inputBar = document.getElementById('input-bar');
    toggle = document.getElementById('mobile-keys-toggle');
    outside = document.getElementById('terminal');
    anchorTop = 839; // one-row composer
    anchor.getBoundingClientRect = () => ({ top: anchorTop });
  });

  afterEach(() => {
    delete window.ResizeObserver;
    delete document.documentElement.clientHeight;
  });

  function wire() {
    return wireKeysPopover({
      keysBar: bar,
      anchor,
      watch: [anchor, inputBar],
      getToggle: () => document.getElementById('mobile-keys-toggle'),
    });
  }

  const offset = () => bar.style.getPropertyValue('--keys-popover-bottom');
  const tap = (el) => el.dispatchEvent(new Event('pointerdown', { bubbles: true }));

  it('opens resting on the status line and lights the toggle', () => {
    wire().toggle();
    expect(bar.classList.contains('mobile-open')).toBe(true);
    expect(toggle.classList.contains('active')).toBe(true);
    expect(offset()).toBe('76px');
  });

  it('follows the status line up when the composer grows', () => {
    wire().toggle();
    anchorTop = 776; // composer grew to four rows
    observers[0].fire();
    expect(offset()).toBe('139px');
  });

  it('watches the status line and everything below it', () => {
    wire();
    expect(observers[0].targets).toEqual([anchor, inputBar]);
  });

  it('re-places on a window resize (rotation, keyboard)', () => {
    wire().toggle();
    anchorTop = 700;
    window.dispatchEvent(new Event('resize'));
    expect(offset()).toBe('215px');
  });

  it('leaves the offset alone while closed', () => {
    wire();
    anchorTop = 500;
    observers[0].fire();
    expect(offset()).toBe('');
  });

  it('closes on a tap outside, and the toggle goes dark', () => {
    wire().toggle();
    tap(outside);
    expect(bar.classList.contains('mobile-open')).toBe(false);
    expect(toggle.classList.contains('active')).toBe(false);
  });

  it('stays open for a tap on one of its keys', () => {
    wire().toggle();
    tap(bar.querySelector('[data-key="Tab"]'));
    expect(bar.classList.contains('mobile-open')).toBe(true);
  });

  it('leaves a tap on the toggle to the toggle, so one tap closes rather than close-then-reopen', () => {
    const popover = wire();
    popover.toggle();
    tap(toggle);
    expect(bar.classList.contains('mobile-open')).toBe(true);
    popover.toggle(); // the click that follows the pointerdown
    expect(bar.classList.contains('mobile-open')).toBe(false);
  });

  it('finds a toggle that the status line re-created', () => {
    const popover = wire();
    anchor.innerHTML = '<button id="mobile-keys-toggle">⌨ Keys</button>';
    const fresh = document.getElementById('mobile-keys-toggle');
    popover.toggle();
    expect(fresh.classList.contains('active')).toBe(true);
    tap(fresh);
    expect(bar.classList.contains('mobile-open')).toBe(true);
  });

  it('still works where ResizeObserver is missing', () => {
    delete window.ResizeObserver;
    const popover = wire();
    popover.toggle();
    expect(offset()).toBe('76px');
    tap(outside);
    expect(bar.classList.contains('mobile-open')).toBe(false);
  });
});
