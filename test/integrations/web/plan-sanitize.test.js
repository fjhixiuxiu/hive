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
