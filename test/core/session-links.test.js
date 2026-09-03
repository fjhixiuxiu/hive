import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const SessionLinks = require('../../src/core/session-links.js');

const {
  parsePrList, parseJiraList, renderChips, isSafeUrl,
  canonicalizePrRef, canonicalizePrField, primaryPr,
} = SessionLinks;

const identityEsc = (s) => String(s);
const DEFAULT_REPO = 'mavencare/webplatform';

describe('canonicalizePrRef', () => {
  it('leaves a full URL untouched', () => {
    expect(canonicalizePrRef('https://github.com/mavencare/webplatform/pull/31333', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/webplatform/pull/31333');
  });

  it('turns "PR #N" into a URL using defaultRepo', () => {
    expect(canonicalizePrRef('PR #31333', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/webplatform/pull/31333');
    expect(canonicalizePrRef('PR#31333', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/webplatform/pull/31333');
  });

  it('turns "#N" and bare "N" into URLs via defaultRepo', () => {
    expect(canonicalizePrRef('#31333', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/webplatform/pull/31333');
    expect(canonicalizePrRef('31333', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/webplatform/pull/31333');
  });

  it('turns "owner/repo#N" into a URL', () => {
    expect(canonicalizePrRef('mavencare/devops#111', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/devops/pull/111');
  });

  it('turns "repo#N" into a URL using defaultRepo owner', () => {
    expect(canonicalizePrRef('webplatform#31333', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/webplatform/pull/31333');
  });

  it('hands back the raw token when no shape matches and it cannot be built', () => {
    expect(canonicalizePrRef('some note about the PR', DEFAULT_REPO))
      .toBe('some note about the PR');
    expect(canonicalizePrRef('31333', '')).toBe('31333'); // no defaultRepo, bare N stays
  });

  it('accepts non-github.com hosts (GitHub Enterprise)', () => {
    expect(canonicalizePrRef('https://github.mycorp.com/acme/web/pull/42', DEFAULT_REPO))
      .toBe('https://github.mycorp.com/acme/web/pull/42');
  });

  it('ignores non-string input', () => {
    expect(canonicalizePrRef(42, DEFAULT_REPO)).toBe(42);
    expect(canonicalizePrRef(null, DEFAULT_REPO)).toBe(null);
  });
});

describe('canonicalizePrField', () => {
  it('canonicalizes each token in a comma-separated field', () => {
    expect(canonicalizePrField('PR #1, #2, mavencare/devops#3', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/webplatform/pull/1, https://github.com/mavencare/webplatform/pull/2, https://github.com/mavencare/devops/pull/3');
  });

  it('deduplicates canonical URLs while preserving order', () => {
    expect(canonicalizePrField('PR #1, https://github.com/mavencare/webplatform/pull/1', DEFAULT_REPO))
      .toBe('https://github.com/mavencare/webplatform/pull/1');
  });

  it('leaves null/undefined alone', () => {
    expect(canonicalizePrField(null, DEFAULT_REPO)).toBe(null);
    expect(canonicalizePrField(undefined, DEFAULT_REPO)).toBe(undefined);
  });

  it('flattens legacy array-shaped pr (from PR-331 first commit) into a canonical string', () => {
    // dc83441 allowed pr: string[]. Anyone whose state landed as an array
    // would otherwise render nothing. Coerce and canonicalize each entry.
    expect(canonicalizePrField(
      ['https://github.com/mavencare/webplatform/pull/1', 'PR #2'],
      DEFAULT_REPO
    )).toBe('https://github.com/mavencare/webplatform/pull/1, https://github.com/mavencare/webplatform/pull/2');
  });

  it('returns the raw field when it has no tokens', () => {
    expect(canonicalizePrField('   ', DEFAULT_REPO)).toBe('   ');
  });
});

describe('parsePrList', () => {
  it('returns [] for empty inputs', () => {
    expect(parsePrList(null)).toEqual([]);
    expect(parsePrList(undefined)).toEqual([]);
    expect(parsePrList('')).toEqual([]);
    expect(parsePrList('   ')).toEqual([]);
  });

  it('parses a single GitHub PR URL into owner + repo + prNumber + short label', () => {
    const out = parsePrList('https://github.com/mavencare/webplatform/pull/31333');
    expect(out).toEqual([{
      owner: 'mavencare',
      repo: 'webplatform',
      ownerRepo: 'mavencare/webplatform',
      prNumber: '31333',
      url: 'https://github.com/mavencare/webplatform/pull/31333',
      label: 'webplatform#31333',
    }]);
  });

  it('parses comma-separated URLs into multiple entries preserving order', () => {
    const input = 'https://github.com/mavencare/webplatform/pull/31333, https://github.com/mavencare/devops/pull/111';
    const out = parsePrList(input);
    expect(out.map(p => p.label)).toEqual(['webplatform#31333', 'devops#111']);
  });

  it('parses short form owner/repo#num and preserves ownerRepo', () => {
    const out = parsePrList('mavencare/webplatform#31333');
    expect(out[0]).toEqual({
      owner: 'mavencare',
      repo: 'webplatform',
      ownerRepo: 'mavencare/webplatform',
      prNumber: '31333',
      url: '',
      label: 'webplatform#31333',
    });
  });

  it('de-dupes exact repo#num duplicates and keeps first-seen order', () => {
    const out = parsePrList('https://github.com/a/webplatform/pull/1, https://github.com/b/webplatform/pull/1, https://github.com/a/devops/pull/2');
    expect(out.map(p => p.label)).toEqual(['webplatform#1', 'devops#2']);
    expect(out[0].url).toBe('https://github.com/a/webplatform/pull/1');
    expect(out[0].owner).toBe('a');
  });

  it('drops unparseable segments but keeps valid ones', () => {
    const out = parsePrList('not a pr, https://github.com/a/webplatform/pull/1, garbage://foo');
    expect(out.map(p => p.label)).toEqual(['webplatform#1']);
  });

  it('does NOT produce entries for javascript:/data: URLs (render-time guard handles them anyway)', () => {
    // parsePrList only accepts strict PR_URL_RE, which requires github.com over http(s).
    // A javascript: token doesn't match short-form either. So the list is empty.
    expect(parsePrList('javascript:alert(1)')).toEqual([]);
    expect(parsePrList('data:text/html,<script>alert(1)</script>')).toEqual([]);
    // Mixed list keeps the valid entry.
    expect(parsePrList('https://github.com/a/webplatform/pull/1, javascript:alert(1)').map(p => p.label))
      .toEqual(['webplatform#1']);
  });

  it('excludes quote/angle-bracket characters from PR URLs (attribute-injection guard)', () => {
    // app-wide `esc()` HTML-escapes `<>&` but not `"`; a URL like
    // `https://x"onclick=y/a/b/pull/1` would otherwise break out of href="..."
    // when renderChips builds the anchor. PR_URL_RE now rejects those chars.
    expect(parsePrList('https://x"onclick=alert(1)/a/b/pull/1')).toEqual([]);
    expect(parsePrList('https://x/a/b/pull/1"><script>alert(1)</script>').map(p => p.label))
      .toEqual(['b#1']); // regex matches the URL prefix only; the injection tail is left outside
  });

  it('ignores non-string input', () => {
    expect(parsePrList(42)).toEqual([]);
    expect(parsePrList({})).toEqual([]);
    expect(parsePrList([])).toEqual([]);
  });
});

describe('parseJiraList', () => {
  it('returns [] for empty inputs', () => {
    expect(parseJiraList(null)).toEqual([]);
    expect(parseJiraList('')).toEqual([]);
  });

  it('parses a single DEV key with default URL', () => {
    expect(parseJiraList('DEV-1234')).toEqual([{
      key: 'DEV-1234',
      url: 'https://vivtechnologies.atlassian.net/browse/DEV-1234',
    }]);
  });

  it('parses comma-separated keys preserving order', () => {
    expect(parseJiraList('DEV-1234, DEV-5678').map(j => j.key))
      .toEqual(['DEV-1234', 'DEV-5678']);
  });

  it('extracts key from a full Jira URL', () => {
    expect(parseJiraList('https://vivtechnologies.atlassian.net/browse/DEV-1234'))
      .toEqual([{ key: 'DEV-1234', url: 'https://vivtechnologies.atlassian.net/browse/DEV-1234' }]);
  });

  it('accepts arbitrary project prefixes in default (non-strict) mode', () => {
    expect(parseJiraList('OPS-1, INFRA-999, HR-42').map(j => j.key))
      .toEqual(['OPS-1', 'INFRA-999', 'HR-42']);
  });

  it('finds MULTIPLE keys inside one token (regression: was returning only the first)', () => {
    expect(parseJiraList('jeff/DEV-1234-DEV-5678-both').map(j => j.key))
      .toEqual(['DEV-1234', 'DEV-5678']);
  });

  it('de-dupes duplicate keys, preserves order', () => {
    expect(parseJiraList('DEV-1, DEV-1, DEV-2').map(j => j.key))
      .toEqual(['DEV-1', 'DEV-2']);
  });

  it('honors a custom jiraBase', () => {
    expect(parseJiraList('DEV-1', 'https://example.atlassian.net/browse/')[0].url)
      .toBe('https://example.atlassian.net/browse/DEV-1');
  });

  describe('strict mode (branch scan)', () => {
    it('drops 2-letter false positives (RC-2024, HR-42)', () => {
      expect(parseJiraList('release/RC-2024-hotfix', null, { strict: true })).toEqual([]);
      expect(parseJiraList('eric/HR-42-thing', null, { strict: true })).toEqual([]);
    });

    it('still matches 3+ letter prefixes', () => {
      expect(parseJiraList('eric/DEV-1234-fix-thing', null, { strict: true }).map(j => j.key))
        .toEqual(['DEV-1234']);
      expect(parseJiraList('eric/INFRA-99-thing', null, { strict: true }).map(j => j.key))
        .toEqual(['INFRA-99']);
    });

    it('finds all 3+ letter keys within one token', () => {
      expect(parseJiraList('jeff/DEV-1234-DEV-5678-both', null, { strict: true }).map(j => j.key))
        .toEqual(['DEV-1234', 'DEV-5678']);
    });
  });
});

describe('renderChips', () => {
  it('returns empty string for empty list', () => {
    expect(renderChips([], { escape: identityEsc })).toBe('');
    expect(renderChips(null, { escape: identityEsc })).toBe('');
  });

  it('renders one anchor per item with the short label', () => {
    const prs = parsePrList('https://github.com/a/webplatform/pull/1, https://github.com/a/devops/pull/2');
    const html = renderChips(prs, { escape: identityEsc });
    expect(html).toContain('>webplatform#1<');
    expect(html).toContain('>devops#2<');
    expect(html.match(/<a /g).length).toBe(2);
  });

  it('renders href with noopener + target', () => {
    const html = renderChips(parsePrList('https://github.com/a/webplatform/pull/1'), { escape: identityEsc });
    expect(html).toContain('href="https://github.com/a/webplatform/pull/1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  it('emits an inert span when the item has no safe URL', () => {
    const html = renderChips(parsePrList('webplatform#31333'), { escape: identityEsc });
    expect(html).toContain('<span');
    expect(html).not.toContain('<a ');
    expect(html).toContain('webplatform#31333');
  });

  it('accepts a JIRA {label, url} shape (unified renderer)', () => {
    const jiras = parseJiraList('DEV-1, DEV-2').map(j => ({ label: j.key, url: j.url }));
    const html = renderChips(jiras, { escape: identityEsc, chipClass: 'status-chip jira' });
    expect(html.match(/<a /g).length).toBe(2);
    expect(html).toContain('class="status-chip jira"');
  });

  it('applies the injected escape function to url and label', () => {
    const spy = (s) => `[${s}]`;
    const html = renderChips([{ label: 'r#1', url: 'https://x/1' }], { escape: spy });
    expect(html).toContain('href="[https://x/1]"');
    expect(html).toContain('>[r#1]<');
  });

  it('omits the class attribute entirely when chipClass is empty string', () => {
    // Bug fix: earlier `opts.chipClass || 'status-chip'` treated '' as falsy
    // and stamped status-chip anyway, breaking the meta-panel styling.
    const html = renderChips(parsePrList('https://github.com/a/webplatform/pull/1'), { escape: identityEsc, chipClass: '' });
    expect(html).not.toContain('class=');
    expect(html).toContain('<a href=');
  });

  it('joins with the separator option when provided', () => {
    const html = renderChips(parsePrList('https://github.com/a/webplatform/pull/1, https://github.com/a/devops/pull/2'), { escape: identityEsc, chipClass: '', separator: ', ' });
    expect(html).toBe(
      '<a href="https://github.com/a/webplatform/pull/1" target="_blank" rel="noopener">webplatform#1</a>' +
      ', ' +
      '<a href="https://github.com/a/devops/pull/2" target="_blank" rel="noopener">devops#2</a>'
    );
  });

  it('defaults to empty separator (status-chip callers rely on flex gap)', () => {
    const html = renderChips(parsePrList('https://github.com/a/webplatform/pull/1, https://github.com/a/devops/pull/2'), { escape: identityEsc });
    expect(html).not.toContain(', ');
    expect(html.split('</a>').length).toBe(3);
  });

  it('throws when escape option is missing', () => {
    expect(() => renderChips([{ label: 'r#1', url: 'https://x/1' }], {})).toThrow(/escape is required/);
  });
});

describe('primaryPr', () => {
  it('returns null for empty list', () => {
    expect(primaryPr([], DEFAULT_REPO)).toBe(null);
    expect(primaryPr(null, DEFAULT_REPO)).toBe(null);
  });

  it('prefers the PR whose ownerRepo matches defaultRepo', () => {
    const prs = parsePrList('https://github.com/mavencare/devops/pull/1, https://github.com/mavencare/webplatform/pull/2');
    expect(primaryPr(prs, DEFAULT_REPO).label).toBe('webplatform#2');
  });

  it('falls back to first-parsed when no PR matches defaultRepo', () => {
    const prs = parsePrList('https://github.com/mavencare/devops/pull/1, https://github.com/nukulb/hive/pull/2');
    expect(primaryPr(prs, DEFAULT_REPO).label).toBe('devops#1');
  });

  it('falls back to first-parsed when defaultRepo is empty', () => {
    const prs = parsePrList('https://github.com/mavencare/webplatform/pull/1');
    expect(primaryPr(prs, '').label).toBe('webplatform#1');
  });
});

describe('isSafeUrl', () => {
  it('accepts http/https', () => {
    expect(isSafeUrl('https://foo')).toBe(true);
    expect(isSafeUrl('http://foo')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,x')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });
});
