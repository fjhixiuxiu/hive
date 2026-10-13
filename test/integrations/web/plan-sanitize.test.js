// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { stripGlobalScopeLeaks } = require('../../../src/integrations/web/public/plan-sanitize.js');

// ---------------------------------------------------------------------------
// stripGlobalScopeLeaks — plan-sidebar style/viewport leak guard.
//
// Repro of the bug: a session's `plan` context points at a full standalone HTML
// document (not markdown). renderMarkdown passes the raw HTML through, and
// setBodyHtml innerHTML's it into the non-isolated #plan-sidebar-body — so the
// doc's <style>/<meta viewport>/<link>/<base> apply GLOBALLY and clobber the
// dashboard's theme and viewport ("open session 22 → colours + zoom change").
//
// This guard strips those head-scope elements while keeping the visible body
// content, and is a no-op on the normal markdown the function usually sees.
// Tests run under jsdom so DOMParser has real full-document head/body parsing.
// ---------------------------------------------------------------------------

// A representative full standalone HTML plan document — the shape that triggers
// the bug. Head carries every page-scope leak vector; body is the real content.
const FULL_HTML_PLAN = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Geo custom fields plan</title>
  <base href="/somewhere/">
  <link rel="stylesheet" href="plan.css">
  <style>
    :root { --viv: #5b2a86; }
    * { box-sizing: border-box; }
    body { background: #ffffff; max-width: 920px; margin: 0 auto; }
    pre { background: #1f2430; }
  </style>
</head>
<body>
  <h1>Geo custom fields</h1>
  <p>Implement the thing.</p>
  <pre><code>const x = 1;</code></pre>
  <table><tr><td>cell</td></tr></table>
</body>
</html>`;

const LEAK_TAGS = ['style', 'link', 'meta', 'base', 'script', 'title'];

function parse(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('stripGlobalScopeLeaks', () => {
  describe('full standalone HTML plan document (the bug)', () => {
    it('removes every page-scope leak element', () => {
      // Sanity: the raw input genuinely contains the leak elements we claim to strip.
      const before = parse(FULL_HTML_PLAN);
      for (const tag of LEAK_TAGS) {
        if (tag === 'script') continue; // this fixture has no <script>; covered separately
        expect(
          before.querySelectorAll(tag).length,
          `input should contain <${tag}>`,
        ).toBeGreaterThan(0);
      }

      const out = stripGlobalScopeLeaks(FULL_HTML_PLAN);
      const after = parse(out);
      for (const tag of LEAK_TAGS) {
        expect(after.querySelectorAll(tag).length, `output should not contain <${tag}>`).toBe(0);
      }
    });

    it('keeps the visible body content (headings, paragraphs, tables)', () => {
      const after = parse(stripGlobalScopeLeaks(FULL_HTML_PLAN));
      expect(after.querySelector('h1')?.textContent).toBe('Geo custom fields');
      expect(after.querySelector('p')?.textContent).toBe('Implement the thing.');
      expect(after.querySelector('pre code')?.textContent).toBe('const x = 1;');
      expect(after.querySelector('table td')?.textContent).toBe('cell');
    });

    it('actually neutralizes the global leak when injected into the live DOM', () => {
      // End-to-end proof against the real failure mechanism: innerHTML into an
      // attached element. Before sanitizing, the plan's <style> and <meta
      // viewport> land in the document; after, they don't.
      const leakStyle =
        '<meta name="viewport" content="width=600">' +
        '<style id="leak">body{max-width:920px}</style>' +
        '<h1>Plan</h1>';

      const host = document.createElement('div');
      document.body.appendChild(host);

      host.innerHTML = leakStyle; // unsanitized — the old behavior
      expect(document.getElementById('leak'), 'control: leak present unsanitized').not.toBeNull();
      expect(
        document.querySelector('meta[name="viewport"]'),
        'control: viewport leaked',
      ).not.toBeNull();

      host.innerHTML = stripGlobalScopeLeaks(leakStyle); // the fix
      expect(document.getElementById('leak'), 'fix: <style> stripped').toBeNull();
      expect(
        document.querySelector('meta[name="viewport"]'),
        'fix: <meta viewport> stripped',
      ).toBeNull();
      expect(host.querySelector('h1')?.textContent, 'fix: visible content kept').toBe('Plan');

      host.remove();
    });
  });

  describe('normal markdown-rendered HTML (no-op)', () => {
    it('passes ordinary marked output through unchanged in structure', () => {
      const md =
        '<h1>Heading</h1>\n<p>some <code>inline</code> text</p>\n' +
        '<ul><li>a</li><li>b</li></ul>\n<blockquote>quote</blockquote>';
      const after = parse(stripGlobalScopeLeaks(md));
      expect(after.querySelector('h1')?.textContent).toBe('Heading');
      expect(after.querySelector('code')?.textContent).toBe('inline');
      expect(after.querySelectorAll('li').length).toBe(2);
      expect(after.querySelector('blockquote')?.textContent).toBe('quote');
    });

    it('leaves a plain fragment with no leak tags untouched', () => {
      const frag = '<p>hello <strong>world</strong></p>';
      const after = parse(stripGlobalScopeLeaks(frag));
      expect(after.querySelector('p')?.textContent).toBe('hello world');
      expect(after.querySelector('strong')?.textContent).toBe('world');
    });

    it('preserves task-list checkboxes (GFM)', () => {
      const gfm = '<ul><li><input type="checkbox" disabled> todo</li></ul>';
      const after = parse(stripGlobalScopeLeaks(gfm));
      expect(after.querySelector('input[type="checkbox"]')).not.toBeNull();
    });
  });

  describe('defense-in-depth', () => {
    it('strips <script> from plan HTML', () => {
      const withScript = '<h1>Plan</h1><script>window.__pwned = true;</script><p>body</p>';
      const out = stripGlobalScopeLeaks(withScript);
      expect(parse(out).querySelector('script')).toBeNull();
      expect(out).not.toContain('__pwned');
      expect(parse(out).querySelector('h1')?.textContent).toBe('Plan');
    });
  });

  describe('robustness', () => {
    it('returns null/undefined inputs as-is without throwing', () => {
      expect(stripGlobalScopeLeaks(null)).toBeNull();
      expect(stripGlobalScopeLeaks(undefined)).toBeUndefined();
    });

    it('returns empty string for empty input', () => {
      expect(stripGlobalScopeLeaks('')).toBe('');
    });

    it('coerces non-string input rather than throwing', () => {
      expect(() => stripGlobalScopeLeaks(42)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// scopePlanStylesToHost — published plans render in a shadow root.
//
// A shadow root has no document root, so a plan's `:root { --line; --panel }`
// palette matched nothing: every var() it fed was invalid, table borders
// vanished and SVG boxes filled with var(--panel) painted solid black (seen on
// the DEV-51756 plan in a 240px session sidebar). The shadow styles force a
// white page, so the plan's dark-scheme palette has to stay off once :root can
// apply at all.
// ---------------------------------------------------------------------------

const { scopePlanStylesToHost } = require('../../../src/integrations/web/public/plan-sanitize.js');

describe('scopePlanStylesToHost', () => {
  const PLAN = `<style>
:root { --fg:#1b1f24; --panel:#f6f8fa; --line:#d0d7de; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --panel:#161b22; } }
th, td { border: 1px solid var(--line); }
</style>
<h1>Plan</h1>
<p>The palette lives on <code>:root</code> in the page.</p>`;

  it('moves the :root palette onto :host so the shadow tree inherits it', () => {
    const out = scopePlanStylesToHost(PLAN);
    expect(out).toContain(':host { --fg:#1b1f24; --panel:#f6f8fa; --line:#d0d7de; }');
    expect(out).not.toMatch(/<style[\s\S]*:root[\s\S]*<\/style>/);
  });

  it('switches off the dark-scheme palette, since the page is forced white', () => {
    const out = scopePlanStylesToHost(PLAN);
    expect(out).toContain('@media not all { :host { --fg:#e6edf3;');
    expect(out).not.toMatch(/prefers-color-scheme\s*:\s*dark/);
  });

  it('matches the dark-scheme query however it is spaced or cased', () => {
    const out = scopePlanStylesToHost(
      '<style>@media ( Prefers-Color-Scheme:DARK ) { :root { --fg: #fff } }</style>',
    );
    expect(out).toBe('<style>@media not all { :host { --fg: #fff } }</style>');
  });

  it('leaves :root in the plan text alone — only <style> contents are rewritten', () => {
    const out = scopePlanStylesToHost(PLAN);
    expect(out).toContain('<p>The palette lives on <code>:root</code> in the page.</p>');
  });

  it('rewrites every <style> block, not just the first', () => {
    const out = scopePlanStylesToHost(
      '<style>:root{a:1}</style><p>x</p><style media="all">:root{b:2}</style>',
    );
    expect(out).toBe('<style>:host{a:1}</style><p>x</p><style media="all">:host{b:2}</style>');
  });

  it('is a no-op on a plan with no palette, and passes null through', () => {
    expect(scopePlanStylesToHost('<h1>Plan</h1>')).toBe('<h1>Plan</h1>');
    expect(scopePlanStylesToHost(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The tests above prove scopePlanStylesToHost; these prove the sidebar uses it.
// Removing the call in mountPlanShadow left every web test green. mountPlanShadow
// is lifted from app.js and mounts into a real jsdom shadow root.
// ---------------------------------------------------------------------------

describe('mountPlanShadow scopes the plan palette to the shadow host', () => {
  const fs = require('fs');
  const path = require('path');
  const PUBLIC = path.resolve(__dirname, '../../../src/integrations/web/public');
  const appSource = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

  function liftMountPlanShadow() {
    const m = appSource.match(/function mountPlanShadow\(planHtml, planId\) \{[\s\S]*?\n {2}\}/);
    if (!m) throw new Error('could not find mountPlanShadow in app.js');
    return new Function(
      'document',
      'window',
      'planRefShadowStyles',
      'injectSectionMarkers',
      `${m[0]}\nreturn mountPlanShadow;`,
    )(
      document,
      { scopePlanStylesToHost },
      () => '',
      () => {},
    );
  }

  it('mounts the plan with its :root palette moved onto :host', () => {
    document.body.innerHTML = '<div class="plan-ref-shadow-host"></div>';
    liftMountPlanShadow()('<style>:root { --line:#d0d7de; }</style><h1>Plan</h1>', 'p1');
    const css = document
      .querySelector('.plan-ref-shadow-host')
      .shadowRoot.querySelector('style').textContent;
    expect(css).toBe(':host { --line:#d0d7de; }');
  });

  it('loads plan-sanitize.js before app.js, so the global exists when a plan mounts', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const sanitize = html.indexOf('<script src="/plan-sanitize.js');
    expect(sanitize).toBeGreaterThan(-1);
    expect(sanitize).toBeLessThan(html.indexOf('<script src="/app.js'));
  });
});
