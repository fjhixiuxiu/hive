import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  designationCapBadge,
  designationCapHint,
  designationCapOptions,
} = require('../../../src/integrations/web/public/designation-cap.js');

// ---------------------------------------------------------------------------
// A cap of 0 and an absent cap mean OPPOSITE things: blank is "no limit", 0 is
// "never auto-spawn". Both of the bugs this file pins down came from treating
// them as the same:
//
//   - the badge rendered a cap of 0 as "0 / 0", which reads as an empty counter
//     rather than a policy, and sat beside an uncapped designation showing no
//     badge at all — so the two looked like an inconsistency instead of
//     opposite settings;
//   - reviewing it, the value 0 was read as a synonym for leaving the field
//     blank, which means the value someone is most likely to type for
//     "unlimited" is the one that silently stops a lane.
//
// Neither could fail a test while the logic lived inside app.js, which has no
// harness. That is why it lives in its own file now.
// ---------------------------------------------------------------------------

describe('designationCapBadge', () => {
  describe('an uncapped designation is quiet', () => {
    // Absence has to keep meaning "no limit": existing designations are not
    // seeded with a cap, and labelling them would imply they were.
    for (const [label, value] of [
      ['undefined', undefined],
      ['null', null],
    ]) {
      it(`shows nothing when the cap is ${label}`, () => {
        expect(designationCapBadge(value, 3)).toBeNull();
      });
    }

    it('shows nothing for a value that could never cap anything', () => {
      expect(designationCapBadge(NaN, 0)).toBeNull();
      expect(designationCapBadge(-1, 0)).toBeNull();
      expect(designationCapBadge('5', 0)).toBeNull();
    });
  });

  describe('a cap of 0 is a policy, not a count', () => {
    it('says what it does instead of counting to zero', () => {
      const badge = designationCapBadge(0, 0);

      expect(badge.text).toBe('No auto-spawn');
      expect(badge.text).not.toMatch(/0\s*\/\s*0/);
      expect(badge.policy).toBe(true);
    });

    it('still says it when sessions exist, because they were started by hand', () => {
      // 3 live sessions against a cap of 0 is not a contradiction: the cap
      // bounds what hive spawns, never what a person starts.
      const badge = designationCapBadge(0, 3);

      expect(badge.text).toBe('No auto-spawn');
      expect(badge.tone).toBe('warn');
    });
  });

  describe('a real cap reads as pressure', () => {
    it('shows live count over the cap', () => {
      expect(designationCapBadge(5, 0).text).toBe('0 / 5');
      expect(designationCapBadge(5, 2).text).toBe('2 / 5');
    });

    it('is quiet until the lane is actually full', () => {
      expect(designationCapBadge(5, 4).full).toBe(false);
      expect(designationCapBadge(5, 4).tone).toBe('dim');
    });

    it('warns once the lane is full', () => {
      expect(designationCapBadge(5, 5).full).toBe(true);
      expect(designationCapBadge(5, 5).tone).toBe('warn');
    });

    it('still warns when the lane is over its cap', () => {
      // Reachable: the cap never removes sessions, so lowering a cap below the
      // current count leaves the lane over it until sessions end.
      const badge = designationCapBadge(2, 5);

      expect(badge.text).toBe('5 / 2');
      expect(badge.full).toBe(true);
    });
  });
});

describe('designationCapHint', () => {
  it('calls a blank field no limit', () => {
    expect(designationCapHint('').text).toMatch(/No limit/);
    expect(designationCapHint('   ').text).toMatch(/No limit/);
    expect(designationCapHint('').tone).toBe('dim');
  });

  // The whole reason the hint exists.
  it('says 0 never spawns, in the strongest terms it has', () => {
    const hint = designationCapHint('0');

    expect(hint.text).toMatch(/NEVER/);
    expect(hint.tone).toBe('warn');
    // It must not read as agreement with "0 means unlimited".
    expect(hint.text).not.toMatch(/no limit/i);
  });

  it('gives blank and 0 visibly different answers', () => {
    expect(designationCapHint('0').text).not.toBe(designationCapHint('').text);
    expect(designationCapHint('0').tone).not.toBe(designationCapHint('').tone);
  });

  it('states the actual number for a real cap', () => {
    expect(designationCapHint('3').text).toMatch(/up to 3 sessions/);
    expect(designationCapHint('1').text).toMatch(/up to 1 session\b/);
    expect(designationCapHint('3').tone).toBe('dim');
  });

  it('rejects what the field cannot store', () => {
    for (const bad of ['-2', 'five', '2.5', '1e3']) {
      expect(designationCapHint(bad).tone, bad).toBe('error');
    }
  });
});

describe('designationCapOptions', () => {
  const labels = (...args) => designationCapOptions(...args).map((o) => o.label);
  const values = (...args) => designationCapOptions(...args).map((o) => o.value);

  // The picker exists to make an invalid cap unrepresentable, which is only
  // true if nothing it offers needs validating.
  it('offers nothing that would need validation', () => {
    for (const { value } of designationCapOptions(8, null)) {
      if (value === '') continue;
      expect(Number.isInteger(parseInt(value, 10))).toBe(true);
      expect(parseInt(value, 10)).toBeGreaterThanOrEqual(0);
      expect(String(parseInt(value, 10))).toBe(value);
    }
  });

  it('names the two values nobody could guess', () => {
    const opts = designationCapOptions(8, null);

    expect(opts[0]).toEqual({ value: '', label: 'No limit' });
    expect(opts[1]).toEqual({ value: '0', label: 'Never auto-spawn' });
  });

  it('stops at the number of sessions the fleet can run', () => {
    expect(values(8, null)).toEqual(['', '0', '1', '2', '3', '4', '5', '6', '7', '8']);
  });

  // Lowering spawnSlotMax below an existing cap is all it takes: without this
  // the dialog would open showing a different cap than the one in force, and
  // saving would silently change it.
  it('still offers a saved cap that sits above the current range', () => {
    expect(labels(8, 20)).toContain('20');
  });

  it('does not duplicate a saved cap already in range', () => {
    expect(labels(8, 5).filter((l) => l === '5')).toHaveLength(1);
  });

  it('falls back to a sane range when the slot max is unusable', () => {
    expect(values(undefined, null)).toContain('32');
    expect(values(0, null)).toContain('32');
  });
});
