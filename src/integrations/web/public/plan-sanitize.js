// Strip page-scope elements from rendered plan HTML before it's innerHTML'd
// into the (non-isolated) plan sidebar body.
//
// A session's `plan` context is *supposed* to be markdown, but some sessions
// point it at a full standalone HTML document. marked passes that raw HTML
// straight through, and setBodyHtml drops it into #plan-sidebar-body via
// innerHTML — at which point the doc's <style>, <meta name="viewport">, <link>
// and <base> apply GLOBALLY, clobbering the dashboard's dark theme and viewport
// (the "open session 22 and the colours/zoom change" bug). The visible body
// content is harmless; only these head-scope elements leak. Strip them.
//
// The published-plan path (planref) already gets full shadow-DOM isolation via
// mountPlanShadow — this is the equivalent guard for the plain markdown path,
// which never needed isolation until a plan file turned out to be a whole HTML
// document. Normal markdown output never contains these tags, so this is a
// no-op there and the dashboard's .plan-sidebar-body CSS still styles it.
//
// DOMParser parses into an inert document: nothing applies or executes during
// parsing, so reading body.innerHTML back out is safe. <script> is stripped
// too as cheap defense-in-depth (innerHTML wouldn't execute it, but a plan
// file is not arbitrary-but-not-trusted input).
(function (root) {
  'use strict';

  var LEAK_SELECTOR = 'style, link, meta, base, script, title';

  function stripGlobalScopeLeaks(html) {
    if (html == null) return html;
    if (typeof DOMParser === 'undefined') return html; // non-browser; nothing to strip against
    try {
      var doc = new DOMParser().parseFromString(String(html), 'text/html');
      var leaks = doc.querySelectorAll(LEAK_SELECTOR);
      for (var i = 0; i < leaks.length; i++) leaks[i].remove();
      return doc.body ? doc.body.innerHTML : html;
    } catch (e) {
      return html; // never let a parse failure blank the sidebar
    }
  }

  // Published plans (mountPlanShadow) render inside a shadow root, which has no
  // document root — so a plan's `:root { --line: …; --panel: … }` palette
  // matches nothing there. Every var() it feeds is then invalid: table borders
  // vanish and SVG boxes filled with var(--panel) paint solid black. Move those
  // rules onto :host, where the shadow tree inherits them.
  //
  // The shadow styles force a white page regardless of theme, so a plan's
  // `@media (prefers-color-scheme: dark)` palette (light text) would be
  // unreadable there once it can apply. `not all` switches that block off.
  //
  // Only <style> contents are rewritten: a plan whose prose or code samples
  // mention `:root` must render them as written.
  function scopePlanStylesToHost(html) {
    if (html == null) return html;
    return String(html).replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, function (_, open, css, close) {
      var scoped = css
        .replace(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '@media not all')
        .replace(/:root\b/g, ':host');
      return open + scoped + close;
    });
  }

  var api = { stripGlobalScopeLeaks: stripGlobalScopeLeaks, scopePlanStylesToHost: scopePlanStylesToHost };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.stripGlobalScopeLeaks = stripGlobalScopeLeaks;
    root.scopePlanStylesToHost = scopePlanStylesToHost;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
