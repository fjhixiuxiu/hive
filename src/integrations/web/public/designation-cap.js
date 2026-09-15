/**
 * Designation session cap — the two decisions, kept out of app.js so they can
 * be tested.
 *
 * Both turn on the same trap: a cap of 0 and an absent cap mean OPPOSITE
 * things. Blank is "no limit"; 0 is "never auto-spawn". Reading 0 as a synonym
 * for unset is the natural assumption, and acting on it would silently stop a
 * lane — which is exactly the bug this file exists to pin down.
 *
 * No DOM here on purpose. These return a description of what to show and the
 * caller renders it, so the branching is provable without a browser.
 */
(function (root) {
  'use strict';

  /**
   * What badge, if any, belongs on a designation row.
   * @param {number|undefined|null} sessionCap
   * @param {number} liveCount - sessions carrying the designation, however started
   * @returns {null|{text: string, tone: string, policy: boolean, full: boolean, title: string}}
   *   null means "show nothing" — an uncapped designation is the default and
   *   should be quiet, not labelled.
   */
  function designationCapBadge(sessionCap, liveCount) {
    if (sessionCap === 0) {
      return {
        text: 'No auto-spawn',
        tone: 'warn',
        policy: true,
        full: true,
        title: 'hive never auto-spawns for this designation — you start these yourself',
      };
    }
    if (!Number.isInteger(sessionCap) || sessionCap < 0) return null;
    var live = Number.isFinite(liveCount) ? liveCount : 0;
    var full = live >= sessionCap;
    return {
      text: live + ' / ' + sessionCap,
      tone: full ? 'warn' : 'dim',
      policy: false,
      full: full,
      title: full
        ? 'Lane is full — hive will not auto-spawn another'
        : 'Sessions hive will auto-spawn for this designation',
    };
  }

  /**
   * What the cap field should say about the value currently typed in it.
   * States the consequence rather than the rule, because the rule is the thing
   * people assume they already know.
   * @param {string} raw - the input's value, verbatim
   * @returns {{text: string, tone: string}}
   */
  function designationCapHint(raw) {
    var trimmed = (raw == null ? '' : String(raw)).trim();
    if (trimmed === '') {
      return {
        text: 'No limit — hive auto-spawns sessions for this designation as work needs them.',
        tone: 'dim',
      };
    }
    var n = parseInt(trimmed, 10);
    if (isNaN(n) || n < 0 || String(n) !== trimmed) {
      return { text: 'Enter 0 or more, or leave blank for no limit.', tone: 'error' };
    }
    if (n === 0) {
      return {
        text: 'hive will NEVER auto-spawn this designation — you start every one of these sessions yourself.',
        tone: 'warn',
      };
    }
    return {
      text: 'hive auto-spawns up to ' + n + ' session' + (n === 1 ? '' : 's') +
        ' for this designation. Sessions you start yourself count toward that but are never blocked.',
      tone: 'dim',
    };
  }

  /**
   * The options the cap picker offers.
   *
   * A picker rather than a text field because it makes an invalid cap
   * unrepresentable — there is nothing left to validate, and no way for a
   * validator and a hint to disagree about "2.5". It also turns the two values
   * nobody can guess into labels: "No limit" and "Never auto-spawn" instead of
   * blank and 0.
   *
   * Bounded by the fleet's own slot range, since a cap above the number of
   * sessions hive can ever run means nothing.
   *
   * @param {number} maxSlots - spawnSlotMax; the largest cap worth offering
   * @param {number|undefined|null} current - the cap already saved, if any
   * @returns {Array<{value: string, label: string}>}
   */
  function designationCapOptions(maxSlots, current) {
    var max = Number.isInteger(maxSlots) && maxSlots > 0 ? maxSlots : 32;
    var options = [
      { value: '', label: 'No limit' },
      { value: '0', label: 'Never auto-spawn' },
    ];
    for (var i = 1; i <= max; i++) options.push({ value: String(i), label: String(i) });
    // A saved cap above the current slot range still has to appear, or opening
    // the dialog would show a different value than the one in force and saving
    // would silently change it. Lowering spawnSlotMax is all it takes.
    if (Number.isInteger(current) && current > max) {
      options.push({ value: String(current), label: String(current) });
    }
    return options;
  }

  var api = {
    designationCapBadge: designationCapBadge,
    designationCapHint: designationCapHint,
    designationCapOptions: designationCapOptions,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.designationCapBadge = designationCapBadge;
    root.designationCapHint = designationCapHint;
    root.designationCapOptions = designationCapOptions;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
