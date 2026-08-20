import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS_PATH = path.resolve(__dirname, '../../../src/integrations/web/public/app.js');
const HTML_PATH = path.resolve(__dirname, '../../../src/integrations/web/public/index.html');

// ---------------------------------------------------------------------------
// PM-form source-field visibility — togglePmSourceFields()
//
// The "Exclude Authors" field is dual-tagged `pm-fields-github
// pm-fields-re-reviews` so it can appear for BOTH github-prs/github-issues and
// github-re-reviews. The toggle loop sets display per-class, last-write-wins, so
// the ordering of the `types` array is load-bearing: the re-reviews pass
// (show=false for a github-prs/issues source) must run BEFORE the github pass
// (show=true) or it clobbers it and the field vanishes. This was the bug fixed
// in PR #294 — these tests pin both the per-type visibility and the array order.
// ---------------------------------------------------------------------------

// Parse the real `const types = [...]` literal out of app.js so the mirror below
// is driven by the SHIPPING order, not a copy. Revert the fix and these fail.
function readTypesArray(js) {
  const m = js.match(/const types = \[([^\]]+)\];/);
  if (!m) throw new Error('could not find `const types = [...]` in app.js');
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

// Faithful mirror of the visibility logic in togglePmSourceFields(). Operates on
// a tiny field model: { id, classes:Set, hasRepoInput, display }. Mirrors the
// show/hide loop + the re-reviews trim-loop exactly.
function applyToggle(type, types, fields) {
  const isGithub =
    type === 'github-issues' || type === 'github-prs' || type === 'github-re-reviews';
  const isReReviews = type === 'github-re-reviews';

  for (const t of types) {
    let show = false;
    if (t === type) show = true;
    else if (t === 'github' && isGithub) show = true;
    else if (t === 'github-prs' && type === 'github-prs') show = true;
    else if (t === 're-reviews' && isReReviews) show = true;
    for (const f of fields) {
      if (f.classes.has(`pm-fields-${t}`)) f.display = show ? '' : 'none';
    }
  }

  if (isReReviews) {
    for (const f of fields) {
      if (!f.classes.has('pm-fields-github')) continue;
      if (f.hasRepoInput) continue;
      if (f.classes.has('pm-fields-re-reviews')) continue;
      f.display = 'none';
    }
  }
}

function modelFields() {
  return [
    // Exclude Authors — dual-tagged (index.html line ~1189)
    { id: 'excludeAuthors', classes: new Set(['pm-fields-github', 'pm-fields-re-reviews']), hasRepoInput: false, display: 'none' },
    // Repo — github-tagged but holds #pm-form-gh-repo, needed by re-reviews too
    { id: 'repo', classes: new Set(['pm-fields-github']), hasRepoInput: true, display: 'none' },
    // Query — a github-only field that must NOT show for re-reviews
    { id: 'query', classes: new Set(['pm-fields-github']), hasRepoInput: false, display: 'none' },
    // Reviewer — re-reviews only
    { id: 'reviewer', classes: new Set(['pm-fields-re-reviews']), hasRepoInput: false, display: 'none' },
  ];
}

function visible(fields, id) {
  return fields.find((f) => f.id === id).display !== 'none';
}

describe('togglePmSourceFields visibility', () => {
  let types;
  beforeAll(() => {
    types = readTypesArray(fs.readFileSync(JS_PATH, 'utf8'));
  });

  it('keeps Exclude Authors visible for github-prs (regression: PR #294)', () => {
    const fields = modelFields();
    applyToggle('github-prs', types, fields);
    expect(visible(fields, 'excludeAuthors')).toBe(true);
    expect(visible(fields, 'reviewer')).toBe(false);
  });

  it('keeps Exclude Authors visible for github-issues', () => {
    const fields = modelFields();
    applyToggle('github-issues', types, fields);
    expect(visible(fields, 'excludeAuthors')).toBe(true);
  });

  it('shows Exclude Authors + Repo + Reviewer but hides Query for github-re-reviews', () => {
    const fields = modelFields();
    applyToggle('github-re-reviews', types, fields);
    expect(visible(fields, 'excludeAuthors')).toBe(true);
    expect(visible(fields, 'repo')).toBe(true);
    expect(visible(fields, 'reviewer')).toBe(true);
    expect(visible(fields, 'query')).toBe(false); // non-repo github field is trimmed
  });

  it('hides all github/re-reviews fields for a non-github source (jira)', () => {
    const fields = modelFields();
    applyToggle('jira', types, fields);
    expect(visible(fields, 'excludeAuthors')).toBe(false);
    expect(visible(fields, 'repo')).toBe(false);
    expect(visible(fields, 'reviewer')).toBe(false);
  });
});

describe('togglePmSourceFields source invariants', () => {
  it("orders 're-reviews' before 'github' in the types array", () => {
    const types = readTypesArray(fs.readFileSync(JS_PATH, 'utf8'));
    expect(types).toContain('re-reviews');
    expect(types).toContain('github');
    expect(types.indexOf('re-reviews')).toBeLessThan(types.indexOf('github'));
  });

  it('keeps the Exclude Authors field dual-tagged in index.html', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const line = html
      .split('\n')
      .find((l) => l.includes('pm-form-gh-exclude-authors') || (l.includes('pm-fields-github') && l.includes('pm-fields-re-reviews')));
    // The wrapping div must carry both classes; assert against the wrapper.
    const wrapper = html
      .split('\n')
      .find((l) => l.includes('pm-fields-github') && l.includes('pm-fields-re-reviews'));
    expect(wrapper, 'a div tagged both pm-fields-github and pm-fields-re-reviews must exist').toBeTruthy();
    expect(html).toContain('pm-form-gh-exclude-authors');
  });
});
