import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  parseTrack,
  trackKindsForPm,
  trackMismatch,
  trackFieldCopy,
} = require('../../src/core/session-links');

/**
 * The task dialog's "Track" field. It resolves one hand-typed reference into
 * `task.sourceKey` plus the `actionContext` the PR action buttons read.
 *
 * Two things it has to get right beyond parsing:
 *   - blank is a legitimate answer ('none'), because Track is the per-task
 *     opt-in to the PM's PR machinery — not a required field;
 *   - a PR key must carry its owner, because `owner/repo#N` is the only shape
 *     `_parsePRFromKey` and `_reactOnPR` can ask GitHub about.
 */
describe('parseTrack', () => {
  const REPO = 'nukulb/hive';

  describe('PR shapes', () => {
    const cases = [
      ['a full PR URL', 'https://github.com/nukulb/hive/pull/349', undefined],
      ['owner/repo#N', 'nukulb/hive#349', undefined],
      ['owner/repo#N with no default repo', 'nukulb/hive#349', undefined],
      ['repo#N borrowing the default owner', 'hive#349', REPO],
      ['#N against the default repo', '#349', REPO],
      ['a bare number against the default repo', '349', REPO],
      ['PR #N against the default repo', 'PR #349', REPO],
      ['surrounding whitespace', '  nukulb/hive#349  ', undefined],
    ];

    for (const [label, input, repo] of cases) {
      it(`resolves ${label} to one canonical key`, () => {
        const t = parseTrack(input, repo);
        expect(t.kind).toBe('pr');
        expect(t.sourceKey).toBe('nukulb/hive#349');
        expect(t.prNumber).toBe(349);
        expect(t.url).toBe('https://github.com/nukulb/hive/pull/349');
      });
    }

    it('builds the actionContext the PR buttons and reactions read', () => {
      // _reactOnPR and ACTION_DEFS both key on this exact shape; pm.js builds
      // the identical object for its own PR-sourced tasks.
      expect(parseTrack('nukulb/hive#349').actionContext).toEqual({
        type: 'github-pr',
        repo: 'nukulb/hive',
        prNumber: 349,
      });
    });

    it('gives prNumber as a number, not the string the regex captured', () => {
      expect(parseTrack('#7', REPO).prNumber).toBe(7);
      expect(parseTrack('#7', REPO).sourceKey).toBe('nukulb/hive#7');
    });

    it('reads a PR URL on a GitHub Enterprise host', () => {
      const t = parseTrack('https://github.corp.example/acme/tools/pull/12');
      expect(t.kind).toBe('pr');
      expect(t.sourceKey).toBe('acme/tools#12');
      // The host is preserved for the link even though the key is host-less.
      expect(t.url).toBe('https://github.corp.example/acme/tools/pull/12');
    });
  });

  describe('JIRA shapes', () => {
    it('accepts a bare key', () => {
      const t = parseTrack('DEV-43333');
      expect(t.kind).toBe('jira');
      expect(t.sourceKey).toBe('DEV-43333');
      expect(t.url).toBe('https://vivtechnologies.atlassian.net/browse/DEV-43333');
    });

    it('accepts a browse URL and keeps it as the link', () => {
      const t = parseTrack('https://vivtechnologies.atlassian.net/browse/DEV-1');
      expect(t.kind).toBe('jira');
      expect(t.sourceKey).toBe('DEV-1');
      expect(t.url).toBe('https://vivtechnologies.atlassian.net/browse/DEV-1');
    });

    it('accepts a browse URL copied with a query string', () => {
      const t = parseTrack('https://vivtechnologies.atlassian.net/browse/DEV-1?atlOrigin=abc');
      expect(t.kind).toBe('jira');
      expect(t.sourceKey).toBe('DEV-1');
    });

    it('normalises a lowercase key — JIRA keys are uppercase by definition', () => {
      expect(parseTrack('dev-43333').sourceKey).toBe('DEV-43333');
    });

    it('carries no actionContext — there is no JIRA action type', () => {
      expect(parseTrack('DEV-1').actionContext).toBeNull();
    });

    it('rejects a key mentioned inside prose', () => {
      // parseJiraList would happily find DEV-1 in here. A key buried in a
      // sentence is a mention, not the task's tracking identity.
      expect(parseTrack('follow up on DEV-1 next week').kind).toBe('invalid');
    });
  });

  describe('blank is not an error', () => {
    for (const [label, input] of [
      ['empty', ''],
      ['whitespace', '   '],
      ['null', null],
      ['undefined', undefined],
      ['a number', 7],
    ]) {
      it(`treats ${label} as "nothing tracked"`, () => {
        const t = parseTrack(input, REPO);
        expect(t.kind).toBe('none');
        expect(t.sourceKey).toBeUndefined();
      });
    }
  });

  describe('refusals', () => {
    it('refuses repo#N when no default repo can supply the owner', () => {
      const t = parseTrack('hive#349');
      expect(t.kind).toBe('invalid');
      // The reason has to name the fix — the input shape was nearly right.
      expect(t.reason).toContain('owner/hive#349');
    });

    it('refuses a bare #N when no default repo is configured', () => {
      const t = parseTrack('#349');
      expect(t.kind).toBe('invalid');
      expect(t.reason).toContain('No default repo');
    });

    it('refuses a malformed default repo rather than inventing a key', () => {
      // canonicalizePrRef only borrows an owner from an `owner/repo` shape.
      expect(parseTrack('#349', 'hive').kind).toBe('invalid');
    });

    it('refuses free text', () => {
      expect(parseTrack('review the auth refactor').kind).toBe('invalid');
      expect(parseTrack('review the auth refactor').reason).toBe('Not a PR or JIRA reference');
    });

    // Same rule as a key inside prose: the URL patterns are unanchored, so
    // without a guard the key is pulled out of the sentence — and the JIRA
    // branch kept the whole sentence as the card's link.
    it('refuses a JIRA browse URL surrounded by other text', () => {
      const t = parseTrack('check out https://vivtechnologies.atlassian.net/browse/DEV-1 please');
      expect(t.kind).toBe('invalid');
      expect(t.reason).toBe('Paste just the link, without other text');
    });

    it('refuses a PR URL surrounded by other text', () => {
      const t = parseTrack('see https://github.com/nukulb/hive/pull/349 please', REPO);
      expect(t.kind).toBe('invalid');
      expect(t.reason).toBe('Paste just the link, without other text');
    });

    it('still accepts a PR URL with a trailing path or fragment', () => {
      for (const url of [
        'https://github.com/nukulb/hive/pull/349/files',
        'https://github.com/nukulb/hive/pull/349#discussion_r1',
      ]) {
        const t = parseTrack(url, REPO);
        expect(t.kind).toBe('pr');
        expect(t.sourceKey).toBe('nukulb/hive#349');
      }
    });

    it('never returns a sourceKey on a refusal', () => {
      for (const bad of ['hive#349', '#349', 'nonsense', 'a, b']) {
        expect(parseTrack(bad).sourceKey).toBeUndefined();
      }
    });
  });
});

/**
 * Pairing a Track with the PM that has to read it.
 *
 * Before the PM picker, `sourceKey` was only ever written by the poll loop
 * that knew its own source type, so the shapes always matched by construction.
 * The picker is the first place a person can pair a JIRA key with a PM that
 * watches pull requests — and neither direction fails loudly, which is exactly
 * why it needs a guard rather than a comment.
 */
describe('trackKindsForPm', () => {
  const pr = (name) => ({
    name,
    completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
  });

  it('reads github-pr-state as a PR condition', () => {
    expect(trackKindsForPm(pr('Reviews'))).toEqual(['pr']);
  });

  it('reads github-pr-changes — a continue condition counts too', () => {
    expect(trackKindsForPm({ continueConditions: [{ type: 'github-pr-changes' }] })).toEqual([
      'pr',
    ]);
  });

  it('reads jira-status from either set', () => {
    expect(
      trackKindsForPm({ completionConditions: [{ type: 'jira-status', statuses: ['Done'] }] }),
    ).toEqual(['jira']);
    expect(
      trackKindsForPm({ continueConditions: [{ type: 'jira-status', statuses: ['Done'] }] }),
    ).toEqual(['jira']);
  });

  it('returns both for a PM that mixes them, and does not duplicate', () => {
    const kinds = trackKindsForPm({
      completionConditions: [{ type: 'github-pr-state' }, { type: 'jira-status' }],
      continueConditions: [{ type: 'github-pr-changes' }],
    });
    expect(kinds.sort()).toEqual(['jira', 'pr']);
  });

  it('returns nothing for a PM with no conditions', () => {
    expect(trackKindsForPm({ name: 'Plain' })).toEqual([]);
    expect(trackKindsForPm(null)).toEqual([]);
  });

  it('ignores a condition type nothing reads sourceKey for', () => {
    expect(trackKindsForPm({ completionConditions: [{ type: 'some-future-thing' }] })).toEqual([]);
  });
});

describe('trackMismatch', () => {
  const prPm = {
    name: 'Human Reviews',
    completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
  };
  const jiraPm = {
    name: 'Dev Work',
    completionConditions: [{ type: 'jira-status', statuses: ['Done'] }],
  };
  const plainPm = { name: 'Webplatform Reviews' };

  it('refuses a JIRA key on a PM that watches pull requests', () => {
    // _parsePRFromKey returns null for a JIRA key, so the condition `continue`s
    // and the task silently never fires.
    const m = trackMismatch(prPm, parseTrack('DEV-43333'));
    expect(m).toContain('Human Reviews');
    expect(m).toContain('pull requests');
    expect(m).toContain('DEV-43333');
  });

  it('refuses a PR on a PM that watches JIRA issues', () => {
    // This one builds /rest/api/3/issue/nukulb/hive#349 and 404s into a caught
    // log.error on every poll, forever.
    const m = trackMismatch(jiraPm, parseTrack('nukulb/hive#349'));
    expect(m).toContain('Dev Work');
    expect(m).toContain('JIRA issues');
    expect(m).toContain('nukulb/hive#349');
  });

  it('names both escapes, because either one is a valid answer', () => {
    const m = trackMismatch(prPm, parseTrack('DEV-1'));
    expect(m).toContain('Track a PR');
    expect(m).toContain('clear this field');
  });

  it('allows the matching direction', () => {
    expect(trackMismatch(prPm, parseTrack('nukulb/hive#349'))).toBeNull();
    expect(trackMismatch(jiraPm, parseTrack('DEV-1'))).toBeNull();
  });

  it('allows either kind on a PM that mixes conditions', () => {
    const mixed = {
      name: 'Mixed',
      completionConditions: [{ type: 'github-pr-state' }, { type: 'jira-status' }],
    };
    expect(trackMismatch(mixed, parseTrack('nukulb/hive#349'))).toBeNull();
    expect(trackMismatch(mixed, parseTrack('DEV-1'))).toBeNull();
  });

  it('allows anything on a PM with no conditions — nothing to contradict', () => {
    // Track is then purely a label and a link, which is an honest use.
    expect(trackMismatch(plainPm, parseTrack('DEV-1'))).toBeNull();
    expect(trackMismatch(plainPm, parseTrack('nukulb/hive#349'))).toBeNull();
  });

  it('says nothing when no PM is chosen', () => {
    expect(trackMismatch(null, parseTrack('DEV-1'))).toBeNull();
  });

  it("says nothing for a blank or unparseable Track — that is parseTrack's job", () => {
    expect(trackMismatch(prPm, parseTrack(''))).toBeNull();
    expect(trackMismatch(prPm, parseTrack('nonsense'))).toBeNull();
    expect(trackMismatch(prPm, null)).toBeNull();
  });
});

/**
 * What the Track field says about itself once a PM is chosen.
 *
 * The refusal (trackMismatch) is a backstop. This is the part that means you
 * rarely reach it: the PM already determines which shape is readable, so the
 * field asks for that shape rather than waiting for the wrong one.
 *
 * It also names what a *blank* Track costs, which is the honest alternative to
 * making the field required — a task with no key asked for no automation, which
 * is a real thing to want, so it gets a sentence rather than a block.
 */
describe('trackFieldCopy', () => {
  const prPm = (extra) =>
    Object.assign(
      {
        name: 'Human Reviews',
        completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
      },
      extra,
    );

  it('narrows the placeholder to PR shapes for a PR-watching PM', () => {
    const copy = trackFieldCopy(prPm());
    expect(copy.placeholder).toContain('owner/repo#N');
    expect(copy.placeholder).not.toContain('JIRA');
  });

  it('narrows the placeholder to a JIRA key for a JIRA-watching PM', () => {
    const copy = trackFieldCopy({
      name: 'Dev Work',
      completionConditions: [{ type: 'jira-status', statuses: ['Done'] }],
    });
    expect(copy.placeholder).toContain('DEV-1234');
    expect(copy.placeholder).not.toContain('owner/repo');
  });

  it('keeps the field optional-looking in every case', () => {
    // Track is the per-task opt-in; a placeholder that reads required would be
    // a lie about what blank means.
    for (const pm of [null, prPm(), { name: 'Plain' }]) {
      expect(trackFieldCopy(pm).placeholder).toContain('optional');
      expect(trackFieldCopy(pm).emptyHint).toContain('Optional');
    }
  });

  it('says what a blank Track costs, naming the PM', () => {
    const hint = trackFieldCopy(prPm()).emptyHint;
    expect(hint).toContain('Human Reviews');
    expect(hint).toContain('their PR');
  });

  it('distinguishes closes / nudges / both from which condition sets exist', () => {
    expect(trackFieldCopy(prPm()).emptyHint).toContain('closes tasks');
    expect(
      trackFieldCopy({ name: 'W', continueConditions: [{ type: 'github-pr-changes' }] }).emptyHint,
    ).toContain('nudges tasks');
    expect(
      trackFieldCopy(prPm({ continueConditions: [{ type: 'github-pr-changes' }] })).emptyHint,
    ).toContain('nudges and closes');
  });

  it('stays generic when there is nothing to narrow to', () => {
    // No PM, a PM with no conditions, and a PM that reads both kinds all want
    // the same field — narrowing any of them would be wrong.
    for (const pm of [
      null,
      { name: 'Plain' },
      {
        name: 'Mixed',
        completionConditions: [{ type: 'github-pr-state' }, { type: 'jira-status' }],
      },
    ]) {
      expect(trackFieldCopy(pm).placeholder).toContain('JIRA key');
      expect(trackFieldCopy(pm).placeholder).toContain('owner/repo#N');
      expect(trackFieldCopy(pm).emptyHint).toContain('no PR or issue is watched');
    }
  });

  it('never promises behaviour the PM cannot deliver', () => {
    // A PM whose only condition type is one nothing reads sourceKey for must
    // not claim it closes anything — it falls back to the generic copy.
    const copy = trackFieldCopy({
      name: 'Odd',
      completionConditions: [{ type: 'some-future-thing' }],
    });
    expect(copy.emptyHint).toContain('no PR or issue is watched');
    expect(copy.emptyHint).not.toContain('Odd');
  });

  it('counts only the conditions that actually read sourceKey, per set', () => {
    // The reachable version of the case above: a PM that DOES narrow to one
    // kind, but whose completion set holds only a type nothing reads. Saying
    // "nudges and closes" here would promise a close that cannot happen.
    // Counting the set's length instead of its readable members is the bug.
    const copy = trackFieldCopy({
      name: 'Nudge Only',
      completionConditions: [{ type: 'some-future-thing' }],
      continueConditions: [{ type: 'github-pr-changes' }],
    });
    expect(copy.emptyHint).toContain('nudges tasks');
    expect(copy.emptyHint).not.toContain('closes');
  });
});
