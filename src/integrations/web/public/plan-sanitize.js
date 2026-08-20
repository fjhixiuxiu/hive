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

  var api = { stripGlobalScopeLeaks: stripGlobalScopeLeaks };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.stripGlobalScopeLeaks = stripGlobalScopeLeaks;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
