// Short-label rendering + canonicalization for PR and JIRA references shown
// in the session panel.
//
// Two responsibilities:
//   1. `canonicalizePrRef` — normalize any incoming PR shape (URL, PR #N, #N,
//      N, owner/repo#N, repo#N) to a full GitHub URL. Wired into
//      `setSessionContext` so downstream code always reads a canonical URL.
//   2. `parsePrList` / `parseJiraList` / `renderChips` — parse a canonical
//      (comma-separated) string into short-labelled chip data and render it.
//
// UMD module: exports for Node (`ws-handlers`, `tq-features`, vitest); attaches
// to `window.SessionLinks` for the browser (served via /session-links.js).
(function (root) {
  'use strict';

  var JIRA_KEY_ONE = /^([A-Z][A-Z0-9]+-\d+)$/;
  // Branch scan requires 3+ leading capitals — DEV-, OPS-, INFRA- match;
  // year-shaped false positives like RC-2024 do not.
  var JIRA_KEY_STRICT_G = /\b([A-Z]{3,}-\d+)\b/g;
  // Any-prefix matcher used when the user typed the value explicitly (ctx.jira).
  var JIRA_KEY_ANY_G = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
  // Host-agnostic on purpose — GitHub Enterprise (e.g. github.mycorp.com)
  // must render too. `isSafeUrl` enforces http(s) at render time. Character
  // class also excludes quotes and angle brackets so a malformed PR URL
  // can't break out of the `href="..."` attribute renderChips builds — the
  // app-wide `esc()` HTML-escapes `<>&` but not `"`.
  var PR_URL_RE = /(https?:\/\/[^/\s"'<>]+\/([^/\s"'<>]+)\/([^/\s"'<>]+)\/pull\/(\d+))/i;
  var SHORT_PR_RE = /^(?:([^/\s#"'<>]+)\/)?([^/\s#"'<>]+)#(\d+)$/;
  var JUST_NUM_RE = /^#?(\d+)$/;
  var PR_HASH_NUM_RE = /^PR\s*#?(\d+)$/i;
  var JIRA_URL_RE = /https?:\/\/[^/\s]+\/browse\/([A-Z][A-Z0-9]+-\d+)/i;
  var DEFAULT_JIRA_BASE = 'https://vivtechnologies.atlassian.net/browse/';

  // Only http/https anchors are safe in a rendered <a href>.
  function isSafeUrl(url) {
    return !!url && /^https?:\/\//i.test(url);
  }

  // Split on commas only, then trim. Keeps multi-word tokens like "PR #123"
  // and full URLs together — space-separated multi-value isn't a supported
  // input shape, since it would fight with those.
  function splitTokens(s) {
    if (typeof s !== 'string') return [];
    var out = [];
    var parts = s.split(',');
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (t) out.push(t);
    }
    return out;
  }

  // Turn one PR token into a canonical GitHub URL when possible.
  // Accepts: full URL, owner/repo#N, repo#N (uses defaultRepo owner),
  //   PR #N, #N, N (uses defaultRepo entirely).
  // Returns the original token when no shape matches (Jeff #321's pattern:
  // hand back an unparseable token rather than dropping it).
  function canonicalizePrRef(token, defaultRepo) {
    if (typeof token !== 'string') return token;
    var t = token.trim();
    if (!t) return t;
    var url = PR_URL_RE.exec(t);
    if (url) return url[1];
    // PR#N / PR #N / #N / N first — else SHORT_PR_RE would eat "PR#31333"
    // as repo=PR, prNumber=31333.
    var pr = PR_HASH_NUM_RE.exec(t);
    var num = pr ? pr[1] : (JUST_NUM_RE.exec(t) || [])[1];
    if (num && defaultRepo && /^[^/\s]+\/[^/\s]+$/.test(String(defaultRepo))) {
      return 'https://github.com/' + defaultRepo + '/pull/' + num;
    }
    if (num) return t; // no defaultRepo — cannot build URL, keep raw
    var shrt = SHORT_PR_RE.exec(t);
    if (shrt) {
      var owner = shrt[1];
      var repo = shrt[2];
      if (!owner && defaultRepo) {
        var dr = String(defaultRepo).split('/');
        if (dr.length === 2 && dr[0]) owner = dr[0];
      }
      if (owner) return 'https://github.com/' + owner + '/' + repo + '/pull/' + shrt[3];
      return t;
    }
    return t;
  }

  // Canonicalize a pr field. Runs at the setSessionContext boundary AND at
  // load time so downstream readers see canonical URLs (or the original token
  // when we could not parse it). Accepts:
  //   - string  → tokenize by comma, canonicalize each
  //   - array   → join tokens by ', ' first (heals legacy state written by
  //               the first commit of this PR, when arrays were schema-valid)
  //   - other   → hand back unchanged
  function canonicalizePrField(field, defaultRepo) {
    if (Array.isArray(field)) field = field.filter(v => typeof v === 'string').join(', ');
    if (typeof field !== 'string') return field;
    var toks = splitTokens(field);
    if (!toks.length) return field;
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < toks.length; i++) {
      var c = canonicalizePrRef(toks[i], defaultRepo);
      if (seen[c]) continue;
      seen[c] = 1;
      out.push(c);
    }
    return out.join(', ');
  }

  function parseOnePr(seg) {
    var m = PR_URL_RE.exec(seg);
    if (m) {
      return {
        owner: m[2],
        repo: m[3],
        ownerRepo: m[2] + '/' + m[3],
        prNumber: m[4],
        url: m[1],
        label: m[3] + '#' + m[4],
      };
    }
    var s = SHORT_PR_RE.exec(seg);
    if (s) {
      return {
        owner: s[1] || '',
        repo: s[2],
        ownerRepo: s[1] ? s[1] + '/' + s[2] : s[2],
        prNumber: s[3],
        url: '',
        label: s[2] + '#' + s[3],
      };
    }
    return null;
  }

  function parsePrList(field) {
    var out = [];
    var seen = Object.create(null);
    var segs = splitTokens(field);
    for (var i = 0; i < segs.length; i++) {
      var parsed = parseOnePr(segs[i]);
      if (!parsed) continue;
      if (seen[parsed.label]) continue;
      seen[parsed.label] = 1;
      out.push(parsed);
    }
    return out;
  }

  // Global regex per token — a branch name like "jeff/DEV-1234-DEV-5678"
  // yields both keys, not just the first. Strict mode (branch scan) drops
  // 2-letter prefixes to avoid year-shaped noise (RC-2024).
  function parseJiraList(field, jiraBase, opts) {
    var base = jiraBase || DEFAULT_JIRA_BASE;
    var strict = opts && opts.strict;
    var out = [];
    var seen = Object.create(null);
    var segs = splitTokens(field);
    var re = strict ? JIRA_KEY_STRICT_G : JIRA_KEY_ANY_G;
    var pushKey = function (key) {
      if (!key || seen[key]) return;
      seen[key] = 1;
      out.push({ key: key, url: base + key });
    };
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var urlMatch = JIRA_URL_RE.exec(seg);
      if (urlMatch) { pushKey(urlMatch[1]); continue; }
      if (JIRA_KEY_ONE.test(seg) && (!strict || /^[A-Z]{3,}-\d+$/.test(seg))) {
        pushKey(seg);
        continue;
      }
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(seg)) !== null) pushKey(m[1]);
    }
    return out;
  }

  // Generic chip renderer used by PR and JIRA callers. Anchor when the item
  // has a safe URL; inert span otherwise. `separator` joins items — default ''
  // works for status-chip callers (their CSS handles spacing); inline meta
  // rows pass ', ' so multi-value strings stay legible.
  function renderChips(items, options) {
    if (!items || !items.length) return '';
    var opts = options || {};
    var escape = opts.escape;
    if (typeof escape !== 'function') throw new Error('renderChips: options.escape is required');
    var cls = opts.chipClass == null ? 'status-chip' : opts.chipClass;
    var sep = opts.separator || '';
    var classAttr = cls ? ' class="' + cls + '"' : '';
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var label = escape(it.label);
      if (isSafeUrl(it.url)) {
        out.push('<a' + classAttr + ' href="' + escape(it.url) + '" target="_blank" rel="noopener">' + label + '</a>');
      } else {
        out.push('<span' + classAttr + '>' + label + '</span>');
      }
    }
    return out.join(sep);
  }

  // Pick a "primary" PR for review/CI polling. When defaultRepo (config.github.repo)
  // is known, prefer the PR whose ownerRepo matches — that's the session's home
  // repo. Otherwise fall back to first-parsed. Returns null when list is empty.
  function primaryPr(prs, defaultRepo) {
    if (!prs || !prs.length) return null;
    if (defaultRepo) {
      for (var i = 0; i < prs.length; i++) {
        if (prs[i].ownerRepo === defaultRepo) return prs[i];
      }
    }
    return prs[0];
  }

  var api = {
    canonicalizePrRef: canonicalizePrRef,
    canonicalizePrField: canonicalizePrField,
    parsePrList: parsePrList,
    parseJiraList: parseJiraList,
    renderChips: renderChips,
    primaryPr: primaryPr,
    isSafeUrl: isSafeUrl,
    DEFAULT_JIRA_BASE: DEFAULT_JIRA_BASE,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SessionLinks = api;
  }
})(typeof window !== 'undefined' ? window : this);
